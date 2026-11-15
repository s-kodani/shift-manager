import hashlib
import json
from pathlib import Path
import runpy
import sys

import pytest

from optimizer import split_process, process_budget
from optimizer.early_candidate import checked_initial_candidate
from optimizer.fixtures import multi_synthetic
from optimizer.model_handoff import LINEAGE
from optimizer.multi_model import solve_multi

SCRIPT = Path(__file__).resolve().parents[3] / "scripts/handoff-diagnostic-stage.py"


def setup(tmp_path, monkeypatch, stage, seconds):
    data = multi_synthetic(1, 30, tiny=True)
    (tmp_path / "input.json").write_text(json.dumps(data))
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), str(tmp_path), stage, str(seconds)])
    return data


def test_stage_budget_cannot_be_enlarged(monkeypatch, tmp_path):
    setup(tmp_path, monkeypatch, "build", 181)
    monkeypatch.setattr(split_process, "run_stage", lambda *a, **k: pytest.fail("must not start"))
    with pytest.raises(AssertionError):
        runpy.run_path(str(SCRIPT))


def test_changed_initial_after_fresh_check_is_rejected(monkeypatch, tmp_path):
    data = setup(tmp_path, monkeypatch, "initial", 72)
    candidate = checked_initial_candidate(data, 5)
    process_budget.atomic_result(
        tmp_path / "initial.json",
        split_process.envelope(data, candidate["assignments"], candidate["validation"]),
    )
    monkeypatch.setattr(
        split_process, "run_stage", lambda *a, **k: {"name": "initial", "expired": False}
    )
    original = process_budget.read_result

    def changed(path, data, **settings):
        result = original(path, data, **settings)
        path.write_text("{}")
        return result

    monkeypatch.setattr(process_budget, "read_result", changed)
    with pytest.raises(AssertionError):
        runpy.run_path(str(SCRIPT))


def test_prepared_model_for_other_input_is_rejected(monkeypatch, tmp_path):
    data = setup(tmp_path, monkeypatch, "build", 180)
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    raw = json.dumps({"inputHash": "wrong", "lineage": {k: data[k] for k in LINEAGE}}).encode()
    (bundle / "manifest.json").write_bytes(raw)
    (tmp_path / "ready.json").write_text(
        json.dumps({"status": "PREPARED", "manifestSha256": hashlib.sha256(raw).hexdigest()})
    )
    monkeypatch.setattr(
        split_process, "run_stage", lambda *a, **k: {"name": "build", "expired": False}
    )
    with pytest.raises(AssertionError):
        runpy.run_path(str(SCRIPT))


def test_successful_cp_result_is_checked_and_summary_is_bounded(monkeypatch, tmp_path, capsys):
    data = setup(tmp_path, monkeypatch, "solve", 90)
    result = solve_multi(data, 5)
    process_budget.atomic_result(tmp_path / "cp-final.json", result)
    monkeypatch.setattr(
        split_process, "run_stage", lambda *a, **k: {"name": "solve", "expired": False}
    )
    runpy.run_path(str(SCRIPT))
    output = json.loads(capsys.readouterr().out)
    assert output["solverStatus"] == "OPTIMAL" and output["validation"]["status"] == "VERIFIED"
    assert output["validation"]["objectiveVector"] == result["validation"]["objectiveVector"]
    assert "preferences" not in output["validation"]
    assert output["validation"]["preferenceItems"] == len(result["validation"]["preferences"])
