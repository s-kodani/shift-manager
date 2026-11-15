from copy import deepcopy
from itertools import product
import json
import hashlib

import pytest
from ortools.sat.python import cp_model

from optimizer import early_candidate as early
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from test_multi_optimizer import assignments, block
from test_server_boundaries import request
from optimizer import server


@pytest.mark.parametrize("priority", ["coverage", "preference"])
@pytest.mark.parametrize("slot", [30, 60])
def test_checked_starting_point_belongs_to_independent_feasible_enumeration(priority, slot):
    data = multi_synthetic(1, slot, tiny=True)
    data["priority"] = priority
    unchanged = deepcopy(data)
    vectors = []
    for sequence in product(("phone", "backoffice"), repeat=120 // slot):
        report = check_multi(
            data,
            assignments(
                data,
                [block(540 + i * slot, 540 + (i + 1) * slot, t) for i, t in enumerate(sequence)],
            ),
        )
        if report["status"] == "VERIFIED":
            vectors.append(report["objectiveVector"])
    result = early.checked_initial_candidate(data, 5)
    assert data == unchanged and result["candidateStatus"] == "CHECKED"
    assert result["globalSolverStatus"] == "NOT_RUN" and result["publication"] == "BLOCKED_A1"
    assert result["validation"]["objectiveVector"] in vectors
    assert result["validation"] == check_multi(data, result["assignments"])
    assert (
        result["inputHash"] == hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    )
    assert result["validation"]["objectiveVector"] == min(
        a["objectiveVector"]
        for a in result["metrics"]["attempts"]
        if a["validationStatus"] == "VERIFIED"
    )


@pytest.mark.parametrize("kind", ["training", "meeting"])
def test_non_aligned_events_are_not_waiting_and_keep_exact_minutes(kind):
    data = multi_synthetic(1, 30, tiny=True)
    data["events"] = [
        {
            "id": "fictional-event",
            "date": "2026-10-01",
            "start": 577,
            "end": 586,
            "kind": kind,
            "staffIds": [data["staff"][0]["id"]],
        }
    ]
    result = early.checked_initial_candidate(data, 5)
    assert result["candidateStatus"] == "CHECKED"
    assert check_multi(data, result["assignments"])["status"] == "VERIFIED"
    assert next(a["shift"]["workedMinutes"] for a in result["assignments"] if a["shift"]) == 120


def test_only_advisory_calendar_cp_is_invoked(monkeypatch):
    solve = cp_model.CpSolver.solve
    calls = []

    def observe(solver, model, *a, **kw):
        calls.append(model.proto.name)
        assert model.proto.name == "advisory-calendar-hint-v1"
        return solve(solver, model, *a, **kw)

    monkeypatch.setattr(cp_model.CpSolver, "solve", observe)
    result = early.checked_initial_candidate(multi_synthetic(1, 30, tiny=True), 5)
    assert calls and result["globalSolverStatus"] == "NOT_RUN"


def test_unknown_history_and_impossible_minimum_are_not_retained():
    for damage in ("history", "minimum"):
        data = multi_synthetic(1, 30, tiny=True)
        if damage == "history":
            data["history"] = []
        else:
            data["staff"][0]["rules"][0].update(monthlyMin=300, monthlyMax=300)
        result = early.checked_initial_candidate(data, 5)
        assert result["candidateStatus"] == "NOT_CREATED" and result["assignments"] is None
        assert all(a["validationStatus"] != "VERIFIED" for a in result["metrics"]["attempts"])
        assert result["globalSolverStatus"] == "NOT_RUN" and result["publication"] == "BLOCKED_A1"


def test_zero_direct_demand_does_not_use_calculated_value():
    data = multi_synthetic(1, 30, tiny=True)
    for d in data["demand"]:
        d.update(direct=0, calculated=100000)
    result = early.checked_initial_candidate(data, 5)
    assert result["candidateStatus"] == "CHECKED" and result["validation"]["generalShortage"] == 0


def test_published_partial_cancellation_preserves_entire_shift():
    data = multi_synthetic(1, 30, tiny=True)
    first = early.checked_initial_candidate(data, 5)
    data["mode"] = "reallocation"
    data["published"] = [
        {"staffId": r["staffId"], "date": r["date"], "shift": deepcopy(r["shift"])}
        for r in first["assignments"]
    ]
    shift = next(a["shift"] for a in data["published"] if a["shift"])
    shift["cancelled"] = [[540, 570]]
    shift["workedMinutes"] = 90
    data["staff"][0]["rules"][0].update(monthlyMin=90, monthlyMax=90)
    result = early.checked_initial_candidate(data, 5)
    assert result["candidateStatus"] == "CHECKED"
    assert [a["shift"] for a in result["assignments"]] == [a["shift"] for a in data["published"]]
    assert check_multi(data, result["assignments"])["status"] == "VERIFIED"


def test_budget_after_first_check_keeps_only_verified_prefix(monkeypatch):
    clock = [0.0]
    original = early.check_multi

    def check(data, rows):
        result = original(data, rows)
        clock[0] = 2.0
        return result

    monkeypatch.setattr(early.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(early, "check_multi", check)
    result = early.checked_initial_candidate(multi_synthetic(1, 30, tiny=True), 1)
    assert result["candidateStatus"] == "CHECKED" and result["metrics"]["expired"]
    assert len(result["metrics"]["attempts"]) == 1
    assert (
        original(multi_synthetic(1, 30, tiny=True), result["assignments"])["status"] == "VERIFIED"
    )


@pytest.mark.parametrize("seconds", [0, -1, 91, float("inf"), float("nan"), True])
def test_invalid_budget_is_rejected(seconds):
    with pytest.raises(ValueError, match="INITIAL_CANDIDATE_BUDGET"):
        early.checked_initial_candidate({}, seconds)


def test_diagnostic_route_is_not_a_normal_solve_profile(monkeypatch):
    calls = []

    def generate(data, budget):
        calls.append((data, budget))
        return {"candidateStatus": "NOT_CREATED", "globalSolverStatus": "NOT_RUN"}

    monkeypatch.setattr(server, "checked_initial_candidate", generate)
    body = json.dumps({"schemaVersion": "multi-task-v1"}).encode()
    profile = server.INITIAL_CANDIDATE_PROFILE
    assert request("/solve", body, monkeypatch, profile=profile) == [(400, {"error": "ValueError"})]
    assert request("/initial-candidate", body, monkeypatch) == [(400, {"error": "ValueError"})]
    assert request("/initial-candidate", body, monkeypatch, profile=profile) == [
        (
            200,
            {
                "candidateStatus": "NOT_CREATED",
                "globalSolverStatus": "NOT_RUN",
                "calculationProfile": profile,
            },
        )
    ]
    assert calls == [({"schemaVersion": "multi-task-v1"}, 90)]


@pytest.mark.parametrize("exception", [False, True])
def test_unavailable_exception_requires_the_exact_fixed_shift(exception):
    data = multi_synthetic(1, 30, tiny=True)
    sid = data["staff"][0]["id"]
    shift = {
        "patternId": "short",
        "start": 540,
        "end": 660,
        "breakKind": "auto",
        "break": None,
        "workedMinutes": 120,
        "cancelled": [],
    }
    data["staff"][0]["unavailable"].append({"date": "2026-10-01", "start": 540, "end": 570})
    data["locks"] = [
        {
            "id": "fictional-lock",
            "staffId": sid,
            "date": "2026-10-01",
            "parts": ["pattern", "time", "break"],
            "shift": shift,
        }
    ]
    if exception:
        data["exceptions"] = [
            {
                "id": "fictional-exception",
                "staffId": sid,
                "date": "2026-10-01",
                "start": 540,
                "end": 570,
                "lockId": "fictional-lock",
                "reason": "架空の手動許可",
            }
        ]
    unchanged = deepcopy(data)
    result = early.checked_initial_candidate(data, 5)
    assert data == unchanged
    if exception:
        assert result["candidateStatus"] == "CHECKED"
        assert next(a["shift"] for a in result["assignments"] if a["shift"]) == shift
        assert check_multi(data, result["assignments"])["status"] == "VERIFIED"
    else:
        assert result["candidateStatus"] == "NOT_CREATED" and result["assignments"] is None


def test_ineligible_task_level_is_not_lowered():
    data = multi_synthetic(1, 30, tiny=True)
    for task in data["tasks"]:
        task["minimumLevel"] = 2
    unchanged = deepcopy(data)
    result = early.checked_initial_candidate(data, 5)
    assert result["candidateStatus"] == "NOT_CREATED" and result["assignments"] is None
    assert data == unchanged
