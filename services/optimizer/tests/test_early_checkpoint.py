import json
from copy import deepcopy

import pytest

from optimizer import early_candidate as early
from optimizer import process_budget as boundary
from optimizer.multi_model import solve_multi
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer.candidate_certificate import CandidateCertificate
from test_process_budget import controlled_child
from test_server_boundaries import request
from optimizer import server


def fixture():
    return multi_synthetic(1, 30, tiny=True)


def prefix(data):
    generated = early.checked_initial_candidate(data, 5)
    return {
        "schemaVersion": "multi-task-v1",
        **{k: data[k] for k in boundary.LINEAGE},
        "inputHash": generated["inputHash"],
        "solverStatus": "UNKNOWN",
        "candidateStatus": "CHECKED",
        "globalSolverStatus": "NOT_RUN",
        "publication": "BLOCKED_A1",
        "validation": generated["validation"],
        "assignments": generated["assignments"],
        "stages": [],
        "metrics": {"budgetSeconds": 3},
    }


def test_automatic_certificate_is_content_bound_and_keeps_explicit_vector_check():
    data = fixture()
    rows = early.checked_initial_candidate(data, 5)["assignments"]
    cert = CandidateCertificate(check_multi)
    report = cert.check(data, rows)
    assert cert.lookup(data, rows) == report
    wrong = list(report["objectiveVector"])
    wrong[0] += 1
    assert cert.lookup(data, rows, wrong) is None
    data["inputVersion"] += 1
    assert cert.lookup(data, rows) is None
    cert.check(data, rows)
    rows[0]["blocks"] = []
    assert cert.lookup(data, rows) is None


def test_initializer_reuses_only_identical_checked_rows():
    result = early.checked_initial_candidate(fixture(), 5)
    metrics = result["metrics"]["candidateCertificate"]
    assert metrics["checkerCalls"] == 1 and metrics["reuseHits"] == 1
    assert result["validation"] == check_multi(fixture(), result["assignments"])


def test_timeout_keeps_checked_prefix_without_claiming_solver_feasible(monkeypatch):
    data = fixture()
    children, roots = controlled_child(monkeypatch, "import time;time.sleep(10)", prefix(data))
    result = boundary.solve_in_process(data, 0.1, early_checkpoint=True)
    assert result["solverStatus"] == "UNKNOWN" and result["candidateStatus"] == "CHECKED"
    assert (
        result["globalSolverStatus"] == "NOT_RUN" and result["validation"]["status"] == "VERIFIED"
    )
    assert result["metrics"]["processBudget"]["childReaped"]
    assert result["termination"] == "PROCESS_DEADLINE"
    assert children[0].poll() is not None and not roots[0].exists()


@pytest.mark.parametrize(
    "damage",
    ["normal-profile", "lineage", "condition", "objective", "publication", "global-status"],
)
def test_checked_hint_is_rejected_on_wrong_scope_or_damaged_content(tmp_path, damage):
    data = fixture()
    value = prefix(data)
    if damage == "lineage":
        value["attempt"] += 1
    if damage == "condition":
        next(a for a in value["assignments"] if a["shift"])["blocks"] = []
    if damage == "objective":
        value["validation"]["objectiveVector"][0] += 1
    if damage == "publication":
        value["publication"] = "ALLOWED"
    if damage == "global-status":
        value["globalSolverStatus"] = "OPTIMAL"
    path = tmp_path / "checkpoint.json"
    boundary.atomic_result(path, value)
    with pytest.raises(ValueError, match="PROCESS_RESULT_"):
        boundary.read_result(path, data, allow_checked_hint=damage != "normal-profile")


def test_crash_still_rejects_a_valid_checked_prefix(monkeypatch):
    data = fixture()
    children, roots = controlled_child(monkeypatch, "raise SystemExit(7)", prefix(data))
    with pytest.raises(boundary.ProcessExecutionError):
        boundary.solve_in_process(data, 1, early_checkpoint=True)
    assert children[0].poll() == 7 and not roots[0].exists()


def test_real_child_runs_original_global_cp_after_checked_start():
    data = fixture()
    before = deepcopy(data)
    baseline = solve_multi(data, 4, hint_strategy="balanced-incumbent-v4", covered_off_hints=True)
    result = boundary.solve_in_process(data, 4, early_checkpoint=True)
    assert data == before
    assert result["solverStatus"] == baseline["solverStatus"] == "OPTIMAL"
    assert result["validation"]["objectiveVector"] == baseline["validation"]["objectiveVector"]
    assert result["metrics"]["earlyCheckpointEnabled"] and result["metrics"]["initialCandidate"]
    assert result["metrics"]["processBudget"]["childReaped"]


@pytest.mark.parametrize("status", ["UNKNOWN", "INFEASIBLE"])
def test_worker_preserves_prefix_on_no_result_but_rejects_model_contradiction(
    monkeypatch, tmp_path, status
):
    from optimizer import multi_model

    data = fixture()
    generated = early.checked_initial_candidate(data, 5)
    (tmp_path / "input.json").write_text(json.dumps(data))

    def create(data, budget, on_checked):
        on_checked(generated["assignments"], generated["validation"])
        assert (tmp_path / "checkpoint.json").exists()
        return generated

    def run(data, budget, **settings):
        assert settings["saved_assignments"] == generated["assignments"] and 0 < budget <= 3
        return {"solverStatus": status, "assignments": None, "metrics": {}, "stages": []}

    monkeypatch.setattr(early, "checked_initial_candidate", create)
    monkeypatch.setattr(multi_model, "solve_multi", run)
    if status == "INFEASIBLE":
        with pytest.raises(RuntimeError, match="CHECKED_CANDIDATE_MODEL_CONTRADICTION"):
            boundary.worker(tmp_path, 3, early_checkpoint=True)
        assert not (tmp_path / "final.json").exists()
    else:
        boundary.worker(tmp_path, 3, early_checkpoint=True)
        result = boundary.read_result(tmp_path / "final.json", data, allow_checked_hint=True)
        assert result["solverStatus"] == "UNKNOWN" and result["candidateStatus"] == "CHECKED"
        assert result["globalSolverStatus"] == "UNKNOWN"


def test_fixed_internal_early_profile_has_no_normal_api_settings(monkeypatch):
    calls = []
    monkeypatch.setattr(
        server, "solve_in_process", lambda data, budget, **kw: calls.append((budget, kw)) or {}
    )
    responses = request(
        "/solve",
        json.dumps({"schemaVersion": "multi-task-v1"}).encode(),
        monkeypatch,
        profile=server.EARLY_CHECKPOINT_PROFILE,
    )
    assert responses == [(200, {"calculationProfile": server.EARLY_CHECKPOINT_PROFILE})]
    assert calls == [
        (
            120,
            {
                "calendar_roster": True,
                "compact_minutes": True,
                "shared_build_facts": True,
                "build_variable_limit": 3500000,
                "common_runs": True,
                "early_checkpoint": True,
            },
        )
    ]
