from copy import deepcopy
from itertools import product

import pytest

from optimizer.contract import dates
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi


def role_tie_fixture():
    data = multi_synthetic(3, tiny=True)
    data['patterns'][0]['end'] = 600
    data['transitions'] = []
    data['tasks'].append({'id': 'management', 'kind': 'dedicated',
                          'minimumLevel': 1, 'minimumMinutes': 60})
    for i, staff in enumerate(data['staff']):
        staff['rules'][0].update(monthlyMin=60, monthlyMax=60)
        staff['skills'] = [{'taskId': 'phone', 'level': 1, 'capacity': 3000 if i == 2 else 1000},
                           {'taskId': 'management', 'level': 1, 'capacity': 0}]
        staff['roleIds'] = [] if i == 2 else ['leader']
    data['demand'] = [{'date': '2026-10-01', 'start': 540, 'end': 600,
                      'taskId': 'phone', 'direct': 3000, 'calculated': 999000}]
    data['roleRequirements'] = [{'id': 'fictional-phone-leader', 'date': '2026-10-01', 'start': 540, 'end': 600,
                                'taskId': 'phone', 'roleId': 'leader', 'minimum': 1,
                                'ratioNumerator': 1, 'ratioDenominator': 1,
                                'rounding': 'ceil', 'priority': 'first'}]
    return data


def assignment(data, options):
    return [{'staffId': staff['id'], 'date': day.isoformat(),
             'shift': {'patternId': 'short', 'start': 540, 'end': 600,
                       'breakKind': 'auto', 'break': None, 'workedMinutes': 60,
                       'cancelled': []} if day.day == 1 else None,
             'blocks': [{'start': 540, 'end': 600, 'taskId': options[i][0],
                         'roleId': options[i][1]}] if day.day == 1 else []}
            for i, staff in enumerate(data['staff']) for day in dates(data)]


def test_qualified_role_tie_improves_initial_coverage_without_relaxing_constraints(monkeypatch):
    from optimizer import multi_model
    original = multi_model.cp_model.CpSolver.solve
    def initial_only(solver, *args, **kwargs):
        return (original(solver, *args, **kwargs) if solver.parameters.fix_variables_to_their_hinted_value
                else multi_model.cp_model.UNKNOWN)
    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', initial_only)
    data = role_tie_fixture()
    unchanged = deepcopy(data)
    old = solve_multi(data, 5, hint_strategy='balanced-incumbent-v2')
    new = solve_multi(data, 5, hint_strategy='balanced-incumbent-v3')
    assert data == unchanged
    for result in (old, new):
        assert result['solverStatus'] == 'FEASIBLE'
        assert result['validation']['status'] == 'VERIFIED'
        assert result['metrics']['initialIncumbent']['adopted']
        assert check_multi(data, result['assignments'])['objectiveVector'] == result['validation']['objectiveVector']
    # v2: 2 qualified staff process 2000 capacity; only one holds the role.
    # A third general processor raises the ratio requirement, so it goes to
    # explicitly registered management. Shortage: 1000 capacity * 60 minutes.
    assert old['validation']['objectiveVector'] == [0, 60000, 0, 0]
    # v3: both qualified processors hold a single role; the third may process
    # phone without a role shortage. All 5000 capacity exceeds demand by 2000.
    assert new['validation']['objectiveVector'] == [0, 0, 0, 120000]


@pytest.mark.parametrize('scope', ['phone', None])
@pytest.mark.parametrize('rounding', ['ceil', 'floor'])
@pytest.mark.parametrize('encoding', ['explicit-v1', 'implicit-none-v1'])
@pytest.mark.parametrize('strategy', ['balanced-incumbent-v3', 'balanced-incumbent-v4'])
@pytest.mark.parametrize('main_presolve', [True, False])
@pytest.mark.parametrize('tight_run_bounds', [False, True])
@pytest.mark.parametrize('bulk_solution_transfer', [False, True])
def test_role_tie_strategy_matches_exhaustive_task_role_choices(scope, rounding, encoding, strategy, main_presolve,
                                                             tight_run_bounds, bulk_solution_transfer):
    data = role_tie_fixture()
    data['roleRequirements'][0].update(taskId=scope, rounding=rounding)
    qualified = [('phone', 'leader'), ('phone', None), ('management', None)]
    unqualified = [('phone', None), ('management', None)]
    vectors = []
    for options in product(qualified, qualified, unqualified):
        report = check_multi(data, assignment(data, options))
        if report['status'] == 'VERIFIED':
            vectors.append(report['objectiveVector'])
    result = solve_multi(data, 5, hint_strategy=strategy, role_encoding=encoding,
                         main_presolve=main_presolve, tight_run_bounds=tight_run_bounds,
                         bulk_solution_transfer=bulk_solution_transfer)
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['objectiveVector'] == min(vectors) == [0, 0, 0, 60000]


def test_implicit_no_role_reduces_variables_while_preserving_the_optimal_schedule():
    data = role_tie_fixture()
    results = [solve_multi(data, 5, hint_strategy='balanced-incumbent-v3', role_encoding=encoding)
               for encoding in ('explicit-v1', 'implicit-none-v1')]
    for result in results:
        assert result['solverStatus'] == 'OPTIMAL'
        assert check_multi(data, result['assignments'])['objectiveVector'] == [0, 0, 0, 60000]
    assert results[1]['metrics']['variables'] < results[0]['metrics']['variables']


def test_unknown_role_encoding_is_rejected_before_construction():
    with pytest.raises(ValueError, match='UNKNOWN_ROLE_ENCODING'):
        solve_multi(role_tie_fixture(), role_encoding='unknown')
