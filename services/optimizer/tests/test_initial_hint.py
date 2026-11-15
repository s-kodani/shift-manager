from copy import deepcopy

import pytest

from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi
from optimizer.operational_fixture import operational_fixture


@pytest.mark.parametrize('strategy', ['legacy-first-v1', 'balanced-coverage-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4'])
@pytest.mark.parametrize('required', [120, 150])
def test_infeasible_starting_values_do_not_override_monthly_limits(strategy, required):
    data = multi_synthetic(1, tiny=True)
    data['patterns'].append({'id': 'long', 'start': 540, 'end': 720, 'breakKind': 'auto'})
    data['staff'][0]['rules'][0].update(monthlyMin=required, monthlyMax=required)
    result = solve_multi(data, 5, hint_strategy=strategy)
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['status'] == 'VERIFIED'
    assert sum(day['workedMinutes'] for day in result['validation']['daily']) == required
    assert result['assignments'][0]['shift']['patternId'] == ('short' if required == 120 else 'long')
    if strategy in ('balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4') and required == 120:
        assert result['metrics']['initialIncumbent']['status'] == 'INFEASIBLE'
        assert result['metrics']['initialIncumbent']['adopted'] is False


@pytest.mark.parametrize('slot', [30, 60])
def test_handwritten_operational_reference_is_valid_and_preserves_fixed_exception(slot):
    data, reference = operational_fixture(20, slot)
    report = check_multi(data, reference)
    assert report['status'] == 'VERIFIED'
    assert any(day['preparationMinutes'] == 10 for day in report['daily'])
    assert any(day['eventMinutes'] == 30 for day in report['daily'])
    assert report['roleRequirements']
    altered = deepcopy(reference)
    locked = next(day for day in altered if day['staffId'] == 'fictional-000' and day['date'] == '2026-10-02')
    locked['shift']['break'] = [600, 630]
    assert check_multi(data, altered)['status'] == 'INVALID'


def test_main_timeout_retains_checked_incumbent_without_claiming_restricted_optimum(monkeypatch):
    from optimizer import multi_model
    original = multi_model.cp_model.CpSolver.solve

    def timeout_main(solver, *args, **kwargs):
        if solver.parameters.fix_variables_to_their_hinted_value:
            return original(solver, *args, **kwargs)
        return multi_model.cp_model.UNKNOWN

    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', timeout_main)
    result = solve_multi(multi_synthetic(1, tiny=True), 5, hint_strategy='balanced-incumbent-v1')
    assert result['metrics']['initialIncumbent']['adopted'] is True
    assert result['solverStatus'] == 'FEASIBLE'
    assert result['stages'][0]['status'] == 'UNKNOWN'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['objectiveVector'] == result['metrics']['initialIncumbent']['objectiveVector']


@pytest.mark.parametrize('rejection', ['INVALID', 'OBJECTIVE_MISMATCH'])
def test_independent_seed_rejection_leaves_original_search_available(monkeypatch, rejection):
    from optimizer import multi_model
    calls = 0

    def reject_seed(data, assignments):
        nonlocal calls
        calls += 1
        report = check_multi(data, assignments)
        if calls == 1:
            if rejection == 'INVALID':
                report['status'] = 'INVALID'
                report['violations'] = ['INJECTED_SEED_REJECTION']
            else:
                report['objectiveVector'][0] += 1
        return report

    monkeypatch.setattr(multi_model, 'check_multi', reject_seed)
    result = solve_multi(multi_synthetic(1, tiny=True), 5, hint_strategy='balanced-incumbent-v1')
    assert result['metrics']['initialIncumbent']['adopted'] is False
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['generalShortage'] == 10000


@pytest.mark.parametrize('strategy', ['legacy-first-v1', 'balanced-coverage-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4'])
def test_later_improvement_of_unproven_higher_objective_is_protected(monkeypatch, strategy):
    from optimizer import multi_model
    data = multi_synthetic(1, tiny=True)
    data['tasks'].append({'id': 'management', 'kind': 'dedicated', 'minimumLevel': 1, 'minimumMinutes': 60})
    data['staff'][0]['skills'].append({'taskId': 'management', 'level': 1, 'capacity': 0})
    original = multi_model.cp_model.CpSolver.solve
    calls = 0

    def restrict_copy(model, tasks):
        restricted = model.clone()
        for index, variable in enumerate(model.proto.variables):
            if variable.name.startswith('t:'):
                _, start, task = variable.name.rsplit(':', 2)
                restricted.add(restricted.get_int_var_from_proto_index(index) == int(task == tasks[int(start)]))
        return restricted

    def controlled_stages(solver, model, *args, **kwargs):
        nonlocal calls
        if solver.parameters.fix_variables_to_their_hinted_value:
            return original(solver, model, *args, **kwargs)
        calls += 1
        if calls <= 2:
            # Native CP-SAT produces a feasible incumbent, then improves its
            # unproven higher objective during the lower stage. The forced
            # copies cannot prove global optimality, hence FEASIBLE only.
            tasks = {540: 'phone', 600: 'phone' if calls == 1 else 'backoffice'}
            status = original(solver, restrict_copy(model, tasks), *args, **kwargs)
            assert status in (multi_model.cp_model.OPTIMAL, multi_model.cp_model.FEASIBLE)
            return multi_model.cp_model.FEASIBLE
        if calls == 3:
            # This alternative has the old 60000 shortage and equally zero
            # surplus. It must be excluded after the improvement to 10000.
            probe = multi_model.cp_model.CpSolver()
            status = original(probe, restrict_copy(model, {540: 'management', 600: 'backoffice'}))
            assert status == multi_model.cp_model.INFEASIBLE
        return original(solver, model, *args, **kwargs)

    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', controlled_stages)
    result = solve_multi(data, 5, hint_strategy=strategy)
    assert result['solverStatus'] == 'FEASIBLE'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['stages'][0]['value'] == 60000
    assert result['stages'][0]['finalValue'] == 10000
    assert result['validation']['generalShortage'] == 10000


@pytest.mark.parametrize('strategy', ['legacy-first-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4'])
def test_empty_task_eligibility_and_zero_minimum_allow_all_off_across_month(strategy):
    data = multi_synthetic(1)
    staff = data['staff'][0]
    staff['contract']['weekdays'] = list(range(7))
    staff['rules'][0].update(monthlyMin=0, minDays=0)
    staff['preferences'] = []
    for skill in staff['skills']:
        skill['level'] = 0
    data['demand'] = []
    result = solve_multi(data, 5, hint_strategy=strategy)
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['status'] == 'VERIFIED'
    assert all(day['shift'] is None and not day['blocks'] for day in result['assignments'])
    assert result['validation']['objectiveVector'] == [0, 0, 0]


def test_interval_hint_does_not_count_rest_as_full_slot_supply(monkeypatch):
    from optimizer import multi_model
    original = multi_model.cp_model.CpSolver.solve
    def keep_initial_only(solver, *args, **kwargs):
        return original(solver, *args, **kwargs) if solver.parameters.fix_variables_to_their_hinted_value else multi_model.cp_model.UNKNOWN
    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', keep_initial_only)
    data = multi_synthetic(3, tiny=True)
    data['patterns'] = [{'id': 'long', 'start': 540, 'end': 720, 'breakKind': 'auto'}]
    data['transitions'] = []
    data['tasks'].append({'id': 'management', 'kind': 'dedicated', 'minimumLevel': 1, 'minimumMinutes': 60})
    for i, staff in enumerate(data['staff']):
        staff['rules'][0].update(monthlyMin=150, monthlyMax=150)
        staff['skills'].append({'taskId': 'management', 'level': 1, 'capacity': 0})
        start = 570 if i < 2 else 630
        data['locks'].append({'id': f'fictional-lock-{i}', 'staffId': staff['id'], 'date': '2026-10-01',
                              'parts': ['pattern', 'time', 'break'],
                              'shift': {'patternId': 'long', 'start': 540, 'end': 720, 'breakKind': 'auto',
                                        'break': [start, start + 30], 'workedMinutes': 150, 'cancelled': []}})
    data['demand'] = [{'date': '2026-10-01', 'start': start, 'end': start + 60, 'taskId': task,
                       'direct': 1000, 'calculated': 0}
                      for start in (540, 600, 660) for task in ('phone', 'backoffice')]
    old = solve_multi(data, 5, hint_strategy='balanced-incumbent-v1')
    new = solve_multi(data, 5, hint_strategy='balanced-incumbent-v2')
    for result in (old, new):
        assert result['solverStatus'] == 'FEASIBLE' and result['validation']['status'] == 'VERIFIED'
        assert result['metrics']['initialIncumbent']['adopted']
    # Both original processors rest 09:30-10:00: 2 * 30 * 1000 shortage.
    # The third worker can cover one task during that half-slot, removing 30000.
    assert old['validation']['objectiveVector'] == [60000, 0, 0]
    assert new['validation']['objectiveVector'] == [30000, 0, 120000]
