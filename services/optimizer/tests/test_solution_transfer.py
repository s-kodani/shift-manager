from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from optimizer.multi_checker import check_multi
from optimizer.multi_model import complete_solution_values, replace_complete_hints, solve_multi
from test_run_bounds import CASES, enumerated_assignments, fixture
from test_saved_candidate import source


def test_complete_response_values_and_hint_proto_match_public_per_variable_api():
    model = cp_model.CpModel()
    flag = model.new_bool_var('flag')
    signed = model.new_int_var(-10, 5, 'signed')
    constant = model.new_constant(7)
    model.add(flag == 1)
    model.add(signed == -3)
    solver = cp_model.CpSolver()
    assert solver.solve(model) == cp_model.OPTIMAL
    expected = [solver.value(model.get_int_var_from_proto_index(i))
                for i in range(len(model.proto.variables))]
    assert expected == [1, -3, 7]
    assert solver.value(flag.Not()) == 0
    assert solver.value(constant) == 7
    assert complete_solution_values(model, solver, True) == complete_solution_values(model, solver, False) == expected
    old, new = model.clone(), model.clone()
    # A constant can be introduced by a later protective bound after solve.
    for m in (old, new):
        m.new_constant(19)
        m.add_hint(m.get_int_var_from_proto_index(0), 0)  # stale hint is replaced, not duplicated.
    normal, bulk = expected.copy(), expected.copy()
    replace_complete_hints(old, normal, False)
    replace_complete_hints(new, bulk, True)
    assert normal == bulk == [1, -3, 7, 19]
    assert str(old.proto) == str(new.proto)
    assert list(new.proto.solution_hint.vars) == [0, 1, 2, 3]


@pytest.mark.parametrize('bulk', [False, True])
def test_unsolved_new_variable_and_wrong_vector_length_are_rejected_without_erasing_hints(bulk):
    model = cp_model.CpModel()
    model.new_bool_var('unknown')
    model.add_hint(model.get_int_var_from_proto_index(0), 1)
    unchanged = str(model.proto)
    with pytest.raises(ValueError, match='UNSOLVED_NEW_VARIABLE'):
        replace_complete_hints(model, [], bulk)
    with pytest.raises(ValueError, match='SOLUTION_VECTOR_LENGTH'):
        replace_complete_hints(model, [0, 1], bulk)
    assert str(model.proto) == unchanged


def test_bulk_read_rejects_a_response_from_a_different_model():
    old = cp_model.CpModel()
    old.new_constant(7)
    solver = cp_model.CpSolver()
    assert solver.solve(old) == cp_model.OPTIMAL
    changed = old.clone()
    changed.new_bool_var('not-solved')
    with pytest.raises(ValueError, match='SOLUTION_VECTOR_LENGTH'):
        complete_solution_values(changed, solver, True)


def test_empty_model_keeps_absent_hint_field_identical():
    old, new = cp_model.CpModel(), cp_model.CpModel()
    replace_complete_hints(old, [], False)
    replace_complete_hints(new, [], True)
    assert str(old.proto) == str(new.proto)


@pytest.mark.parametrize('slot_minutes', [30, 60])
@pytest.mark.parametrize('case', CASES)
def test_all_cp_calls_keep_identical_proto_and_independent_optimum(monkeypatch, case, slot_minutes):
    data, shift, intervals = fixture(case, slot_minutes)
    original_data = deepcopy(data)
    golden = []
    for rows in enumerated_assignments(data, shift, intervals):
        checked = check_multi(data, rows)
        if checked['status'] == 'VERIFIED':
            golden.append(checked['objectiveVector'])
    assert golden
    original_solve = cp_model.CpSolver.solve
    traces = []
    active_trace = []

    def observe(solver, model, *args, **kwargs):
        # Preserve every constraint, objective and ordered hint at every call.
        before = str(model.proto)
        status = original_solve(solver, model, *args, **kwargs)
        values = (list(solver.response_proto.solution)
                  if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None)
        active_trace.append((before, status, values))
        return status

    monkeypatch.setattr(cp_model.CpSolver, 'solve', observe)
    for bulk in (False, True):
        active_trace = []
        result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', bulk_solution_transfer=bulk)
        assert result['solverStatus'] == 'OPTIMAL'
        assert check_multi(data, result['assignments'])['objectiveVector'] == min(golden)
        assert result['metrics']['bulkSolutionTransferEnabled'] is bulk
        assert result['metrics']['initialIncumbent']['solutionValueCount'] > 0
        assert result['metrics']['initialIncumbent']['valueReadSeconds'] >= 0
        assert result['metrics']['initialIncumbent']['hintBuildSeconds'] >= 0
        traces.append(active_trace)
    assert traces[0] == traces[1]
    assert data == original_data


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
def test_saved_candidate_competition_and_later_hints_keep_all_cp_models_identical(monkeypatch, priority):
    data, candidate = source()
    data['priority'] = priority
    original_solve = cp_model.CpSolver.solve
    active_trace, traces = [], []

    def observe(solver, model, *args, **kwargs):
        active_trace.append(str(model.proto))
        return original_solve(solver, model, *args, **kwargs)

    monkeypatch.setattr(cp_model.CpSolver, 'solve', observe)
    results = []
    for bulk in (False, True):
        active_trace = []
        result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4',
                             saved_assignments=candidate, bulk_solution_transfer=bulk)
        assert result['solverStatus'] == 'OPTIMAL'
        assert result['validation']['status'] == 'VERIFIED'
        results.append(result['validation']['objectiveVector'])
        traces.append(active_trace)
    assert traces[0] == traces[1] and results[0] == results[1]


def test_main_timeout_retains_checked_seed_and_uses_complete_bulk_hints(monkeypatch):
    original = cp_model.CpSolver.solve
    main_hint = []

    def timeout_main(solver, model, *args, **kwargs):
        if solver.parameters.fix_variables_to_their_hinted_value:
            return original(solver, model, *args, **kwargs)
        main_hint.extend(model.proto.solution_hint.vars)
        return cp_model.UNKNOWN

    monkeypatch.setattr(cp_model.CpSolver, 'solve', timeout_main)
    data, _, _ = fixture('plain', 30)
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', bulk_solution_transfer=True)
    assert result['solverStatus'] == 'FEASIBLE'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['metrics']['initialIncumbent']['adopted']
    assert main_hint == list(range(result['metrics']['variables']))


def test_invalid_transfer_setting_and_unfinished_model_are_not_success():
    data, _, _ = fixture('plain', 30)
    with pytest.raises(ValueError, match='BULK_SOLUTION_TRANSFER_SETTING'):
        solve_multi(data, bulk_solution_transfer=1)
    result = solve_multi(data, 0, bulk_solution_transfer=True)
    assert result['solverStatus'] == 'UNKNOWN'
    assert result['validation']['status'] == 'NOT_RUN'
    assert result['metrics']['bulkSolutionTransferEnabled'] is True
