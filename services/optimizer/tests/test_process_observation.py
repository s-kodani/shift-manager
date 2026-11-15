import json

import pytest
from ortools.sat.python import cp_model

from optimizer import process_budget as boundary
from optimizer import multi_model, server
from optimizer.process_observation import read_observation, memory_usage
from test_covered_off_hint import covered_fixture
from test_process_budget import controlled_child
from test_server_boundaries import request


def event():
    return {
        "event": "cpStart",
        "phase": "initialFeasibility",
        "seconds": 1.0,
        "variables": 10,
        "constraints": 20,
        "rssBytes": None,
        "maxRssBytes": 4096,
        "modelBuildComplete": True,
        "cpStatus": None,
    }


@pytest.mark.parametrize(
    "damage", ["secret", "number", "size", "count", "partial", "status", "phase", "bool"]
)
def test_bad_progress_is_not_disclosed_or_used(tmp_path, damage):
    row = event()
    body = {"version": 1, "events": [row]}
    if damage == "secret":
        row["staffId"] = "private-input"
    if damage == "number":
        row["seconds"] = float("nan")
    if damage == "size":
        body["padding"] = "x" * 65537
    if damage == "count":
        body["events"] = [row] * 65
    if damage == "status":
        row["cpStatus"] = "secret-token"
    if damage == "phase":
        row["phase"] = "private-identifier"
    if damage == "bool":
        row["variables"] = True
    p = tmp_path / "progress.json"
    p.write_text("{" if damage == "partial" else json.dumps(body))
    assert read_observation(p) == {"available": False, "reason": "INVALID_PROGRESS"}


def test_missing_and_atomic_complete_observation(tmp_path):
    p = tmp_path / "progress.json"
    assert read_observation(p) == {"available": False, "reason": "NO_PROGRESS"}
    boundary.atomic_result(p, {"version": 1, "events": [event()]})
    assert read_observation(p) == {"available": True, "events": [event()]}
    current, maximum = memory_usage()
    assert (current is None or current >= 0) and maximum > 0


@pytest.mark.parametrize(
    "script", ["raise SystemExit(7)", "import os,signal;os.kill(os.getpid(),signal.SIGKILL)"]
)
def test_crash_retains_bounded_progress_after_reap_and_removes_private_files(monkeypatch, script):
    children, roots = controlled_child(
        monkeypatch, script, {"version": 1, "events": [event()]}, "progress.json"
    )
    with pytest.raises(boundary.ProcessExecutionError) as caught:
        boundary.solve_in_process(covered_fixture(), 2)
    diagnostic = caught.value.diagnostics
    assert str(caught.value) == "PROCESS_EXECUTION_FAILED"
    assert diagnostic["progress"] == {"available": True, "events": [event()]}
    assert diagnostic["childReaped"] and diagnostic["childExitCode"] in (7, -9)
    assert children[0].poll() is not None and not roots[0].exists()


def test_deadline_retains_progress_without_creating_a_feasible_candidate(monkeypatch):
    children, roots = controlled_child(
        monkeypatch,
        "import time;time.sleep(10)",
        {"version": 1, "events": [event()]},
        "progress.json",
    )
    result = boundary.solve_in_process(covered_fixture(), 0.1)
    assert result["solverStatus"] == "UNKNOWN" and result["assignments"] is None
    assert result["metrics"]["processObservation"] == {"available": True, "events": [event()]}
    assert children[0].poll() is not None and not roots[0].exists()


def test_real_child_observations_have_only_allowed_metadata():
    result = boundary.solve_in_process(covered_fixture(), 4)
    progress = result["metrics"]["processObservation"]
    assert progress["available"] and progress["events"]
    assert any(e["event"] == "cpStart" and e["modelBuildComplete"] for e in progress["events"])
    assert any(e["event"] == "cpEnd" for e in progress["events"])
    assert progress["events"][-1]["phase"] == "finalCheck"
    assert "fictional-" not in json.dumps(progress)
    assert result["validation"]["status"] == "VERIFIED"


@pytest.mark.parametrize("failure", [False, True])
def test_observation_does_not_change_proto_or_checked_objective(monkeypatch, failure):
    original = cp_model.CpSolver.solve
    traces = []
    rows = []

    def capture(solver, model, *a, **kw):
        traces[-1].append(str(model.proto))
        return original(solver, model, *a, **kw)

    def observer(row):
        rows.append(row)
        if failure:
            raise OSError("fictional-observer-fault")

    monkeypatch.setattr(cp_model.CpSolver, "solve", capture)
    results = []
    for callback in (None, observer):
        traces.append([])
        results.append(
            multi_model.solve_multi(
                covered_fixture(),
                4,
                hint_strategy="balanced-incumbent-v4",
                covered_off_hints=True,
                progress_callback=callback,
            )
        )
    assert traces[0] == traces[1]
    assert (
        results[0]["validation"]["objectiveVector"] == results[1]["validation"]["objectiveVector"]
    )
    assert rows and results[1]["metrics"]["phaseTimings"]["observationFailures"] == (
        len(rows) if failure else 0
    )


@pytest.mark.parametrize("profile", [server.PROCESS_PROFILE, server.COMMON_PROFILE])
def test_internal_diagnostic_failure_is_hidden_from_normal_profile(monkeypatch, profile):
    diagnostics = {
        "progress": {"available": False, "reason": "NO_PROGRESS"},
        "childExitCode": -9,
        "childReaped": True,
        "executionSeconds": 1.0,
    }

    def fail(*a, **kw):
        raise boundary.ProcessExecutionError(diagnostics)

    monkeypatch.setattr(server, "solve_in_process", fail)
    expected = {"error": "MODEL_ERROR"}
    if profile == server.COMMON_PROFILE:
        expected["diagnostics"] = diagnostics
    assert request(
        "/solve",
        json.dumps({"schemaVersion": "multi-task-v1"}).encode(),
        monkeypatch,
        profile=profile,
    ) == [(500, expected)]


def test_worker_retains_only_latest_64_complete_events(monkeypatch, tmp_path):
    (tmp_path / 'input.json').write_text('{}')
    def solve(data, budget, **settings):
        for n in range(70):
            row = event()
            row['seconds'] = n
            settings['progress_callback'](row)
        return {'result': 'fake transport only'}
    monkeypatch.setattr(multi_model, 'solve_multi', solve)
    boundary.worker(tmp_path, 1)
    report = read_observation(tmp_path / 'progress.json')
    assert report['available'] and len(report['events']) == 64
    assert report['events'][0]['seconds'] == 6 and report['events'][-1]['seconds'] == 69
    assert not (tmp_path / 'progress.pending').exists()
    assert (tmp_path / 'progress.json').stat().st_size < 65536


def test_zero_allowance_does_not_report_a_cp_call(monkeypatch):
    clock = [0.0]
    rows = []
    def observe(row):
        rows.append(row)
        if row['event'] == 'phase' and row['phase'] == 'initialFeasibility':
            clock[0] = 3.8
    def unexpected(*args, **kwargs):
        raise AssertionError('CP must not run with zero allowance')
    monkeypatch.setattr(multi_model.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(cp_model.CpSolver, 'solve', unexpected)
    result = multi_model.solve_multi(covered_fixture(), 4,
        hint_strategy='balanced-incumbent-v4', progress_callback=observe)
    assert result['solverStatus'] == 'UNKNOWN' and result['assignments'] is None
    assert not any(row['event'] in ('cpStart', 'cpEnd') for row in rows)
