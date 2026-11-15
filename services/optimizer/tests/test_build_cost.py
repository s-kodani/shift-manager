from copy import deepcopy
import hashlib
import json

import pytest

from optimizer import multi_model
from optimizer.fixtures import multi_synthetic
from optimizer.early_candidate import checked_initial_candidate
from optimizer.parent_certificate import parent_precheck
from optimizer.process_budget import read_result
from optimizer.split_process import envelope
from optimizer.model_handoff import ModelPrepared
from optimizer.operational_fixture import standard_scale_fixture
from optimizer.multi_checker import check_multi


def legacy(staff, day, shift):
    remaining = set(range(shift["start"], shift["end"])) if shift else set()
    if shift:
        for a, b in shift["cancelled"]:
            remaining.difference_update(range(a, b))
    work = bool(shift and shift["workedMinutes"])
    total = 0
    for p in staff["preferences"]:
        if p["date"] != day:
            continue
        ok = {"work": work, "off": not work}.get(p["kind"], False)
        if p["kind"] == "pattern":
            ok = (
                work
                and p["patternId"] == shift["patternId"]
                and len(remaining) == shift["end"] - shift["start"]
            )
        elif p["kind"] == "window":
            ok = work and p["start"] <= min(remaining) and max(remaining) + 1 <= p["end"]
        total += int(not ok)
    return total


def test_exact_scores_for_all_preference_subsets_and_cancellation_boundaries():
    day = "2026-10-01"
    kinds = [
        {"date": day, "kind": "work"},
        {"date": day, "kind": "off"},
        {"date": day, "kind": "pattern", "patternId": "short"},
        {"date": day, "kind": "window", "start": 570, "end": 630},
    ]
    for mask in range(16):
        preferences = [p for i, p in enumerate(kinds) if mask & (1 << i)]
        preferences.append({"date": "2026-10-02", "kind": "work"})
        for cancelled in ([], [[540, 570]], [[630, 660]], [[540, 660]], [[540, 570], [630, 660]]):
            shift = {
                "patternId": "short",
                "start": 540,
                "end": 660,
                "cancelled": cancelled,
                "workedMinutes": 120 - sum(b - a for a, b in cancelled),
            }
            for row in (None, shift):
                staff = {"preferences": preferences}
                assert multi_model.missed_multi(staff, day, row) == legacy(staff, day, row)


def test_empty_or_work_off_preferences_do_not_allocate_minute_sets(monkeypatch):
    def expensive(*a, **kw):
        raise AssertionError("minute set must not be allocated")

    monkeypatch.setattr(multi_model, "set", expensive, raising=False)
    shift = {"patternId": "short", "start": 540, "end": 660, "workedMinutes": 120, "cancelled": []}
    assert multi_model.missed_multi({"preferences": []}, "2026-10-01", shift) == 0
    assert (
        multi_model.missed_multi(
            {"preferences": [{"date": "2026-10-01", "kind": "off"}]}, "2026-10-01", shift
        )
        == 1
    )


@pytest.mark.parametrize("priority", ["coverage", "preference"])
@pytest.mark.parametrize("slot", [30, 60])
def test_preference_fast_path_keeps_full_proto_and_hints(monkeypatch, priority, slot):
    data, _ = standard_scale_fixture(10, slot)
    data["priority"] = priority
    current = multi_model.missed_multi
    traces = []

    def prepared(model, *args):
        traces.append(str(model.proto))
        raise ModelPrepared()

    for score in (legacy, current):
        monkeypatch.setattr(multi_model, "missed_multi", score)
        with pytest.raises(ModelPrepared):
            multi_model.solve_multi(
                data,
                20,
                hint_strategy="balanced-incumbent-v4",
                common_runs=True,
                compact_minutes=True,
                shared_build_facts=True,
                prepared_callback=prepared,
            )
    assert traces[0] == traces[1]


def parent_file(tmp_path):
    data = multi_synthetic(1, 30, tiny=True)
    generated = checked_initial_candidate(data, 5)
    value = envelope(data, generated["assignments"], generated["validation"])
    path = tmp_path / "initial.json"
    raw = json.dumps(value).encode()
    path.write_bytes(raw)
    read_result(path, data, allow_checked_hint=True)  # trusted owner checks before issuing SHA
    return data, value, path, hashlib.sha256(raw).hexdigest()


def test_trusted_parent_reuse_keeps_real_cp_optimum_and_default_fresh_check(tmp_path):
    data, value, path, digest = parent_file(tmp_path)
    callback = parent_precheck(data, path, digest)
    unchanged = deepcopy(data)
    results = [
        multi_model.solve_multi(
            data,
            5,
            hint_strategy="balanced-incumbent-v4",
            saved_assignments=value["assignments"],
            saved_precheck=precheck,
        )
        for precheck in (None, callback)
    ]
    assert data == unchanged and all(r["solverStatus"] == "OPTIMAL" for r in results)
    assert (
        results[0]["validation"]["objectiveVector"] == results[1]["validation"]["objectiveVector"]
    )
    assert all(check_multi(data, r["assignments"])["status"] == "VERIFIED" for r in results)
    assert [r["metrics"]["savedCandidate"]["precheckSource"] for r in results] == [
        "fresh-checker",
        "bound-parent-file",
    ]


@pytest.mark.parametrize("change", ["input", "role", "shift", "vector-report", "file", "lineage"])
def test_parent_certificate_rejects_changed_content_and_preserves_report(tmp_path, change):
    data, value, path, digest = parent_file(tmp_path)
    callback = parent_precheck(data, path, digest)
    rows = deepcopy(value["assignments"])
    if change == "input":
        data["inputVersion"] += 1
    if change == "role":
        next(r for r in rows if r["shift"])["roleIntervals"].append(
            {"start": 540, "end": 570, "roleId": "leader"}
        )
    if change == "shift":
        next(r for r in rows if r["shift"])["shift"]["workedMinutes"] += 30
    if change in ("input", "role", "shift"):
        with pytest.raises(ValueError, match="PARENT_CERTIFICATE_CONTENT"):
            callback(data, rows)
    elif change == "vector-report":
        returned = callback(data, rows)
        returned["objectiveVector"][0] += 1
        assert callback(data, rows) == value["validation"]
    elif change == "file":
        path.write_text("{}")
        with pytest.raises(ValueError, match="PARENT_CERTIFICATE_SHA"):
            parent_precheck(data, path, digest)
    else:
        value["jobId"] = "fictional-wrong"
        raw = json.dumps(value).encode()
        path.write_bytes(raw)
        with pytest.raises(ValueError, match="PARENT_CERTIFICATE_LINEAGE"):
            parent_precheck(data, path, hashlib.sha256(raw).hexdigest())
