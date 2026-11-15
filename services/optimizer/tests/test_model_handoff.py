from copy import deepcopy
from pathlib import Path
import hashlib
import json
import subprocess
import sys

import pytest
from ortools.sat.python import cp_model

from optimizer.fixtures import multi_synthetic
from optimizer.multi_model import solve_multi
from optimizer.model_handoff import (
    save_bundle,
    load_bundle,
    solve_probe,
    ModelPrepared,
    expression_record,
)
from optimizer.multi_checker import check_multi
from test_saved_candidate import source


def capture(root, data, *, export_mode="chunked-native-v1", **settings):
    recorded = {}

    def prepared(*parts):
        recorded["sha"] = save_bundle(root, data, *parts, export_mode=export_mode)
        recorded["proto"] = str(parts[0].proto)
        raise ModelPrepared()

    with pytest.raises(ModelPrepared):
        solve_multi(
            data, 10, hint_strategy="balanced-incumbent-v4", prepared_callback=prepared, **settings
        )
    return recorded


@pytest.mark.parametrize("slot", [30, 60])
@pytest.mark.parametrize("priority", ["coverage", "preference"])
@pytest.mark.parametrize("export_mode", ["chunked-native-v1", "whole-native-v1"])
def test_exact_proto_hints_objectives_and_checker_after_restore(
    tmp_path, slot, priority, export_mode
):
    data = multi_synthetic(1, slot, tiny=True)
    data["priority"] = priority
    unchanged = deepcopy(data)
    root = tmp_path / "bundle"
    saved = capture(root, data, common_runs=True, export_mode=export_mode)
    model, layout, objectives, manifest = load_bundle(root, data, saved["sha"])
    assert str(model.proto) == saved["proto"] and data == unchanged
    baseline = solve_multi(data, 5, hint_strategy="balanced-incumbent-v4", common_runs=True)
    result = solve_probe(root, data, saved["sha"], 5)
    assert result["solverStatus"] == baseline["solverStatus"] == "OPTIMAL"
    assert result["validation"]["objectiveVector"] == baseline["validation"]["objectiveVector"]
    assert check_multi(data, result["assignments"])["status"] == "VERIFIED"
    assert manifest["variables"] == len(model.proto.variables)
    assert [x[0] for x in objectives] == result["validation"]["objectiveOrder"]
    # Two-task aliases include negative literals and survive the handoff.
    assert any(i < 0 for row in layout["rows"] for _b, items in row["tasks"] for _t, i in items)


def test_events_roles_and_saved_candidate_survive_real_child(tmp_path):
    data, candidate = source()
    root = tmp_path / "bundle"
    saved = capture(root, data, saved_assignments=candidate, common_runs=True)
    path = tmp_path / "input.json"
    path.write_text(json.dumps(data))
    child = subprocess.run(
        [sys.executable, "-m", "optimizer.model_handoff", str(root), str(path), saved["sha"], "5"],
        capture_output=True,
        text=True,
        timeout=15,
        cwd=Path(__file__).resolve().parents[1],
    )
    assert child.returncode == 0, child.stderr
    result = json.loads(child.stdout)
    assert (
        result["solverStatus"] == "OPTIMAL"
        and check_multi(data, result["assignments"])["status"] == "VERIFIED"
    )
    baseline = solve_multi(
        data,
        5,
        hint_strategy="balanced-incumbent-v4",
        saved_assignments=candidate,
        common_runs=True,
    )
    assert result["validation"]["objectiveVector"] == baseline["validation"]["objectiveVector"]


@pytest.mark.parametrize("damage", ["input", "manifest", "model", "layout", "missing", "symlink"])
def test_untrusted_or_changed_bundle_is_rejected(tmp_path, damage):
    data = multi_synthetic(1, 30, tiny=True)
    root = tmp_path / "bundle"
    saved = capture(root, data)
    if damage == "input":
        data["attempt"] += 1
    if damage == "manifest":
        (root / "manifest.json").write_text("{}")
    if damage == "model":
        (root / "model.pb.txt").write_text("invalid")
    if damage == "layout":
        (root / "layout.json").write_text("{}")
    if damage == "missing":
        (root / "layout.json").unlink()
    if damage == "symlink":
        other = tmp_path / "external"
        other.write_text((root / "layout.json").read_text())
        (root / "layout.json").unlink()
        (root / "layout.json").symlink_to(other)
    with pytest.raises(ValueError, match="MODEL_HANDOFF_"):
        load_bundle(root, data, saved["sha"])


@pytest.mark.parametrize("damage", ["index", "order", "pool", "settings", "export-mode"])
def test_even_pinned_but_invalid_metadata_is_rejected(tmp_path, damage):
    data = multi_synthetic(1, 30, tiny=True)
    root = tmp_path / "bundle"
    capture(root, data)
    layout = json.loads((root / "layout.json").read_text())
    if damage == "index":
        layout["rows"][0]["x"][0] = 999999
    if damage == "order":
        layout["objectives"].reverse()
    if damage == "pool":
        layout["activeSlotPools"][0] = [7]
    if damage == "settings":
        layout["settings"]["mainPresolveEnabled"] = "yes"
    if damage == "export-mode":
        layout["settings"]["modelExportMode"] = "unknown"
    raw = json.dumps(layout).encode()
    (root / "layout.json").write_bytes(raw)
    manifest = json.loads((root / "manifest.json").read_text())
    manifest["files"]["layout.json"] = {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
    }
    raw = json.dumps(manifest).encode()
    (root / "manifest.json").write_bytes(raw)
    with pytest.raises(ValueError, match="MODEL_HANDOFF_"):
        load_bundle(root, data, hashlib.sha256(raw).hexdigest())


def test_partial_cancellation_fixed_time_is_preserved(tmp_path):
    data = multi_synthetic(1, 30, tiny=True)
    baseline = solve_multi(data, 3)
    data["mode"] = "reallocation"
    data["published"] = [
        {"staffId": r["staffId"], "date": r["date"], "shift": deepcopy(r["shift"])}
        for r in baseline["assignments"]
    ]
    shift = next(r["shift"] for r in data["published"] if r["shift"])
    shift["cancelled"] = [[540, 570]]
    shift["workedMinutes"] = 90
    data["staff"][0]["rules"][0].update(monthlyMin=90, monthlyMax=90)
    root = tmp_path / "bundle"
    saved = capture(root, data, common_runs=True)
    result = solve_probe(root, data, saved["sha"], 5)
    assert [r["shift"] for r in result["assignments"]] == [r["shift"] for r in data["published"]]
    assert check_multi(data, result["assignments"])["status"] == "VERIFIED"


@pytest.mark.parametrize("seconds", [0, 91, float("nan"), float("inf"), True])
def test_budget_cannot_be_unbounded(seconds):
    with pytest.raises(ValueError, match="MODEL_HANDOFF_BUDGET"):
        solve_probe(None, {}, "", seconds)


@pytest.mark.parametrize("value", [0, 1])
def test_negative_coefficient_and_constant_offset_are_exact(value):
    model = cp_model.CpModel()
    x = model.new_bool_var("fictional-offset")
    expression = 7 * x.Not() + 3
    record = expression_record("fixture", expression)
    assert record == {"name": "fixture", "vars": [x.index], "coeffs": [-7], "offset": 10}
    assert expression_record("constant", 3) == {
        "name": "constant",
        "vars": [],
        "coeffs": [],
        "offset": 3,
    }
    model.add(x == value)
    solver = cp_model.CpSolver()
    assert solver.solve(model) == cp_model.OPTIMAL
    assert solver.value(expression) == (10 if value == 0 else 3)
