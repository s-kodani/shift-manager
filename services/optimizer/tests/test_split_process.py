from copy import deepcopy
import json
import subprocess
import sys

import pytest

from optimizer import split_process as split
from optimizer.early_candidate import checked_initial_candidate
from optimizer.multi_model import solve_multi
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer import server
from test_server_boundaries import request
from test_process_observation import event


@pytest.mark.parametrize("slot", [30, 60])
@pytest.mark.parametrize("priority", ["coverage", "preference"])
def test_real_sequential_children_match_original_optimum(slot, priority):
    data = multi_synthetic(1, slot, tiny=True)
    data["priority"] = priority
    unchanged = deepcopy(data)
    baseline = solve_multi(data, 4, hint_strategy="balanced-incumbent-v4")
    result = split.solve_split(data, 20)
    assert data == unchanged
    assert result["solverStatus"] == baseline["solverStatus"] == "OPTIMAL"
    assert result["validation"]["objectiveVector"] == baseline["validation"]["objectiveVector"]
    assert check_multi(data, result["assignments"])["status"] == "VERIFIED"
    phases = result["metrics"]["processStages"]
    assert [p["name"] for p in phases] == ["initial", "build", "solve"]
    assert all(p["exitCode"] == 0 and p["childReaped"] and not p["expired"] for p in phases)
    assert result["metrics"]["cpProbe"]["seed"]["scope"] == "hint-restricted-feasibility"
    observation = result["metrics"]["buildObservation"]
    assert observation["phase"] == "manifest" and observation["modelBuildComplete"]
    assert all(observation["fileBytes"][name] > 0 for name in ("model.pb.txt", "layout.json"))
    progress = result["metrics"]["buildProgress"]
    assert progress["available"]
    assert progress["events"][-1]["phase"] == "initialHints"
    assert progress["events"][-1]["modelBuildComplete"]
    assert not any(row["event"] in ("cpStart", "cpEnd") for row in progress["events"])
    assert result["metrics"]["preparedModel"]["debugNamesEnabled"] is False
    assert result["metrics"]["preparedModel"]["modelExportMode"] == "whole-native-v1"
    solve_progress = result["metrics"]["solveProgress"]
    assert solve_progress["available"]
    phases = [row["phase"] for row in solve_progress["events"]]
    assert "loadProto" in phases and "modelReady" in phases and "checkSolution" in phases
    assert any(row["event"] == "cpStart" for row in solve_progress["events"])


@pytest.mark.parametrize("valid_progress", [True, False])
def test_build_timeout_keeps_only_checked_prefix_and_does_not_start_solver(
    monkeypatch, valid_progress
):
    data = multi_synthetic(1, 30, tiny=True)
    initial = checked_initial_candidate(data, 5)
    calls = []
    roots = []

    def run(root, name, seconds, **kw):
        calls.append(name)
        roots.append(root)
        if name == "initial":
            split.atomic_result(
                root / "initial.json",
                split.envelope(data, initial["assignments"], initial["validation"]),
            )
        else:
            row = event()
            row.update(event="buildProgress", phase="duties", modelBuildComplete=False)
            if not valid_progress:
                row["staffId"] = "must-not-be-returned"
            split.atomic_result(root / "build-progress.json", {"version": 1, "events": [row]})
        return {
            "name": name,
            "seconds": 0.1,
            "exitCode": -15 if name == "build" else 0,
            "expired": name == "build",
            "childReaped": True,
        }

    monkeypatch.setattr(split, "run_stage", run)
    result = split.solve_split(data, 20)
    assert calls == ["initial", "build"] and result["solverStatus"] == "UNKNOWN"
    assert result["candidateStatus"] == "CHECKED" and result["validation"]["status"] == "VERIFIED"
    progress = result["metrics"]["buildProgress"]
    assert progress["available"] == valid_progress
    if valid_progress:
        assert progress["events"][-1]["phase"] == "duties"
    else:
        assert progress == {"available": False, "reason": "INVALID_PROGRESS"}
    assert all(not p.exists() for p in roots)


def test_builder_retains_only_last_64_safe_events(monkeypatch, tmp_path):
    from optimizer import multi_model
    from optimizer.process_observation import read_observation

    (tmp_path / "input.json").write_text(json.dumps(multi_synthetic(1, 30, tiny=True)))

    def build(data, seconds, **settings):
        row = event()
        row.update(event="buildProgress", phase="duties", modelBuildComplete=False)
        for second in range(70):
            row["seconds"] = second
            settings["progress_callback"](row)
        return {"metrics": {}}

    monkeypatch.setattr(multi_model, "solve_multi", build)
    split.stage_worker("build", tmp_path, 10)
    report = read_observation(tmp_path / "build-progress.json")
    assert report["available"] and len(report["events"]) == 64
    assert report["events"][0]["seconds"] == 6 and report["events"][-1]["seconds"] == 69
    assert (tmp_path / "build-progress.json").stat().st_size < 65536
    assert not (tmp_path / "build-progress.pending").exists()


def test_real_killed_builder_progress_survives_parent_and_private_cleanup(monkeypatch):
    data = multi_synthetic(1, 30, tiny=True)
    initial = checked_initial_candidate(data, 5)
    original_stage, original_popen = split.run_stage, subprocess.Popen
    roots, children = [], []
    row = event()
    row.update(event="buildProgress", phase="duties", modelBuildComplete=False)

    def run(root, name, seconds, **settings):
        roots.append(root)
        if name == "initial":
            split.atomic_result(
                root / "initial.json",
                split.envelope(data, initial["assignments"], initial["validation"]),
            )
            return {
                "name": name,
                "seconds": 0.1,
                "expired": False,
                "exitCode": 0,
                "childReaped": True,
            }

        def create(command, **kwargs):
            code = (
                "from pathlib import Path; import time; "
                + f"Path({str(root / 'build-progress.json')!r}).write_text({json.dumps({'version': 1, 'events': [row]})!r}); time.sleep(10)"
            )
            child = original_popen([sys.executable, "-c", code], **kwargs)
            children.append(child)
            return child

        monkeypatch.setattr(split.subprocess, "Popen", create)
        return original_stage(root, name, 0.2, **settings)

    monkeypatch.setattr(split, "run_stage", run)
    result = split.solve_split(data, 20)
    assert result["solverStatus"] == "UNKNOWN" and result["validation"]["status"] == "VERIFIED"
    assert result["metrics"]["buildProgress"]["events"] == [row]
    assert result["metrics"]["processStages"][-1]["expired"]
    assert all(child.poll() is not None for child in children)
    assert all(not root.exists() for root in roots)


def test_stage_failure_rejects_prefix_and_cleans_private_root(monkeypatch):
    data = multi_synthetic(1, 30, tiny=True)
    initial = checked_initial_candidate(data, 5)
    roots = []

    def run(root, name, seconds, **kw):
        roots.append(root)
        if name == "build":
            raise RuntimeError("SPLIT_STAGE_FAILED")
        split.atomic_result(
            root / "initial.json",
            split.envelope(data, initial["assignments"], initial["validation"]),
        )
        return {"name": name, "seconds": 0.1, "exitCode": 0, "expired": False, "childReaped": True}

    monkeypatch.setattr(split, "run_stage", run)
    with pytest.raises(RuntimeError, match="SPLIT_STAGE_FAILED"):
        split.solve_split(data, 20)
    assert all(not p.exists() for p in roots)


def test_real_timeout_stops_and_reaps_owned_process(monkeypatch, tmp_path):
    original = subprocess.Popen
    children = []

    def create(command, **settings):
        child = original([sys.executable, "-c", "import time;time.sleep(10)"], **settings)
        children.append(child)
        return child

    monkeypatch.setattr(split.subprocess, "Popen", create)
    result = split.run_stage(tmp_path, "initial", 0.1)
    assert result["expired"] and result["childReaped"] and children[0].poll() is not None


def test_builder_rejects_changed_initial_file_before_model(monkeypatch, tmp_path):
    data = multi_synthetic(1, 30, tiny=True)
    (tmp_path / "input.json").write_text(json.dumps(data))
    (tmp_path / "initial.json").write_text("{}")
    with pytest.raises(ValueError, match="SPLIT_INITIAL_SHA"):
        split.stage_worker("build", tmp_path, 5, "0" * 64)


@pytest.mark.parametrize("seconds", [0, -1, 241, float("nan"), float("inf"), True])
def test_invalid_budget_cannot_start_process(seconds):
    with pytest.raises(ValueError, match="SPLIT_BUDGET"):
        split.solve_split({}, seconds)


def test_fixed_split_profile_is_diagnostic_240_seconds(monkeypatch):
    calls = []
    monkeypatch.setattr(server, "solve_split", lambda data, budget: calls.append(budget) or {})
    result = request(
        "/solve",
        json.dumps({"schemaVersion": "multi-task-v1"}).encode(),
        monkeypatch,
        profile=server.SPLIT_PROFILE,
    )
    assert result == [(200, {"calculationProfile": server.SPLIT_PROFILE})] and calls == [240]


@pytest.mark.parametrize("stage", ["build", "solve"])
def test_real_nonzero_exit_retains_stage_and_reaped_diagnostics(monkeypatch, tmp_path, stage):
    original = subprocess.Popen
    row = event()
    row.update(event="buildProgress", phase="duties", modelBuildComplete=False)
    split.atomic_result(tmp_path / "build-progress.json", {"version": 1, "events": [row]})
    solve_row = {**row, "event": "phase", "phase": "loadProto", "variables": 0, "constraints": 0}
    split.atomic_result(tmp_path / "solve-progress.json", {"version": 1, "events": [solve_row]})

    def create(command, **settings):
        return original([sys.executable, "-c", "raise SystemExit(7)"], **settings)

    monkeypatch.setattr(split.subprocess, "Popen", create)
    with pytest.raises(split.SplitStageFailure) as caught:
        split.run_stage(tmp_path, stage, 1)
    assert caught.value.diagnostics["stage"] == stage
    assert (
        caught.value.diagnostics["childExitCode"] == 7 and caught.value.diagnostics["childReaped"]
    )
    assert caught.value.diagnostics["buildProgress"] == (
        {"available": True, "events": [row]} if stage == "build" else None
    )
    assert caught.value.diagnostics["solveProgress"] == (
        {"available": True, "events": [solve_row]} if stage == "solve" else None
    )
