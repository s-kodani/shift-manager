from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from optimizer.fixtures import multi_synthetic
from optimizer.model_handoff import ModelPrepared
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi
from optimizer.operational_fixture import standard_scale_fixture
from test_saved_candidate import source


def canonical_without_names(model):
    copied = cp_model.CpModel()
    copied.proto.copy_from(model.proto)
    for variable in copied.proto.variables:
        variable.name = ""
    return str(copied.proto)


@pytest.mark.parametrize("slot", [30, 60])
@pytest.mark.parametrize("priority", ["coverage", "preference"])
def test_only_names_change_in_complete_proto_and_hints(slot, priority):
    data, _ = standard_scale_fixture(10, slot)
    data["priority"] = priority
    unchanged = deepcopy(data)
    traces = []

    def prepared(model, *parts):
        traces.append((canonical_without_names(model), parts[-1]))
        if not parts[-1]["debugNamesEnabled"]:
            assert all(not v.name or v.name.lstrip("-").isdigit() for v in model.proto.variables)
        raise ModelPrepared()

    for names in (True, False):
        with pytest.raises(ModelPrepared):
            solve_multi(
                data,
                20,
                hint_strategy="balanced-incumbent-v4",
                common_runs=True,
                compact_minutes=True,
                shared_build_facts=True,
                debug_names=names,
                prepared_callback=prepared,
            )
    assert data == unchanged and traces[0][0] == traces[1][0]
    assert [settings["debugNamesEnabled"] for _, settings in traces] == [True, False]


@pytest.mark.parametrize("slot", [30, 60])
@pytest.mark.parametrize("priority", ["coverage", "preference"])
def test_real_cp_and_checker_keep_optimum(slot, priority):
    data = multi_synthetic(1, slot, tiny=True)
    data["priority"] = priority
    unchanged = deepcopy(data)
    results = [
        solve_multi(
            data, 5, hint_strategy="balanced-incumbent-v4", common_runs=True, debug_names=names
        )
        for names in (True, False)
    ]
    assert data == unchanged and all(r["solverStatus"] == "OPTIMAL" for r in results)
    assert results[0]["assignments"] == results[1]["assignments"]
    assert (
        results[0]["validation"]["objectiveVector"] == results[1]["validation"]["objectiveVector"]
    )
    assert all(check_multi(data, r["assignments"])["status"] == "VERIFIED" for r in results)


def test_saved_fixed_event_roles_candidate_keeps_full_model_and_real_cp():
    data, candidate = source()
    unchanged = deepcopy(data)
    traces = []

    def prepared(model, *parts):
        traces.append(canonical_without_names(model))
        raise ModelPrepared()

    for names in (True, False):
        with pytest.raises(ModelPrepared):
            solve_multi(
                data,
                10,
                hint_strategy="balanced-incumbent-v4",
                saved_assignments=candidate,
                common_runs=False,
                debug_names=names,
                prepared_callback=prepared,
            )
    assert traces[0] == traces[1]
    results = [
        solve_multi(
            data,
            5,
            hint_strategy="balanced-incumbent-v4",
            saved_assignments=candidate,
            debug_names=names,
        )
        for names in (True, False)
    ]
    assert all(r["solverStatus"] == "OPTIMAL" for r in results) and data == unchanged
    assert (
        results[0]["validation"]["objectiveVector"] == results[1]["validation"]["objectiveVector"]
    )
    assert all(check_multi(data, r["assignments"])["status"] == "VERIFIED" for r in results)


@pytest.mark.parametrize("names", [0, 1, None, "false"])
def test_name_setting_is_boolean(names):
    with pytest.raises(ValueError, match="DEBUG_NAME_SETTING"):
        solve_multi({}, debug_names=names)
