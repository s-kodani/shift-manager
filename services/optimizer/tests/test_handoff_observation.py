import json
import subprocess
import sys

import pytest

from optimizer import split_process as split
from optimizer.fixtures import multi_synthetic
from optimizer.model_handoff import solve_probe
from optimizer.process_observation import read_observation
from test_model_handoff import capture
from test_process_observation import event


def test_progress_matches_real_cp_and_contains_only_fixed_fields(tmp_path):
    data = multi_synthetic(1, 30, tiny=True)
    root = tmp_path / "bundle"
    saved = capture(root, data, export_mode="whole-native-v1")
    rows = []
    baseline = solve_probe(root, data, saved["sha"], 5, seed_first=True)
    result = solve_probe(
        root, data, saved["sha"], 5, seed_first=True, progress_callback=rows.append
    )
    assert baseline["solverStatus"] == result["solverStatus"] == "OPTIMAL"
    assert baseline["assignments"] == result["assignments"]
    assert baseline["validation"] == result["validation"]
    phases = [row["phase"] for row in rows if row["event"] == "phase"]
    assert phases[:8] == [
        "loadInput",
        "loadFiles",
        "loadProto",
        "validateProto",
        "loadLayout",
        "validateLayout",
        "restoreObjectives",
        "modelReady",
    ]
    assert "extractSolution" in phases and "checkSolution" in phases
    assert any(row["phase"] == "initialFeasibility" and row["event"] == "cpStart" for row in rows)
    assert any(row["phase"] == "initialFeasibility" and row["event"] == "cpEnd" for row in rows)
    path = tmp_path / "progress.json"
    path.write_text(json.dumps({"version": 1, "events": rows}))
    assert read_observation(path) == {"available": True, "events": rows}
    assert all(rows[n]["seconds"] <= rows[n + 1]["seconds"] for n in range(len(rows) - 1))


def test_failed_observer_does_not_change_solution(tmp_path):
    data = multi_synthetic(1, 30, tiny=True)
    root = tmp_path / "bundle"
    saved = capture(root, data)

    def broken(row):
        raise OSError("fictional observation failure")

    result = solve_probe(root, data, saved["sha"], 5, progress_callback=broken)
    assert result["solverStatus"] == "OPTIMAL" and result["validation"]["status"] == "VERIFIED"
    assert result["observationFailures"] > 0


def test_real_solve_crash_retains_progress_after_private_root_cleanup(monkeypatch):
    data = multi_synthetic(1, 30, tiny=True)
    original_stage, original_popen = split.run_stage, subprocess.Popen
    roots, children = [], []
    row = event()
    row.update(
        event="phase", phase="loadProto", variables=0, constraints=0, modelBuildComplete=False
    )

    def run(root, name, seconds, **settings):
        roots.append(root)
        if name == "initial":
            return {
                "name": name,
                "seconds": 0.1,
                "expired": False,
                "exitCode": 0,
                "childReaped": True,
            }
        if name == "build":
            split.atomic_result(
                root / "ready.json", {"status": "PREPARED", "manifestSha256": "fake"}
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
                "import pathlib,os,signal; "
                + f"pathlib.Path({str(root / 'solve-progress.json')!r}).write_text({json.dumps({'version': 1, 'events': [row]})!r}); os.kill(os.getpid(),signal.SIGKILL)"
            )
            child = original_popen([sys.executable, "-c", code], **kwargs)
            children.append(child)
            return child

        monkeypatch.setattr(split.subprocess, "Popen", create)
        return original_stage(root, name, 1, **settings)

    monkeypatch.setattr(split, "run_stage", run)
    with pytest.raises(split.SplitStageFailure) as caught:
        split.solve_split(data, 20)
    assert caught.value.diagnostics["stage"] == "solve"
    assert (
        caught.value.diagnostics["childExitCode"] == -9 and caught.value.diagnostics["childReaped"]
    )
    assert caught.value.diagnostics["solveProgress"] == {"available": True, "events": [row]}
    assert all(child.poll() is not None for child in children)
    assert all(not root.exists() for root in roots)
