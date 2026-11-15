"""Literal G0 capacity/role examples from TS-CAP and TS-DEMAND."""
from copy import deepcopy

import pytest

from optimizer.contract import dates
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi


def fixture(count=1):
    data = multi_synthetic(count, tiny=True)
    data['tasks'] = [data['tasks'][0]]
    data['roles'][0]['allowedTasks'] = ['phone']
    data['transitions'] = []
    for staff in data['staff']:
        staff['skills'] = [staff['skills'][0]]
        staff['roleIds'] = []
    for demand in data['demand']:
        demand['taskId'] = 'phone'
    return data


def reference(data):
    return [{'staffId': staff['id'], 'date': day.isoformat(),
             'shift': {'patternId': 'short', 'start': 540, 'end': 660,
                       'breakKind': 'auto', 'break': None, 'workedMinutes': 120,
                       'cancelled': []} if day.day == 1 else None,
             'blocks': [{'start': m, 'end': m + 60, 'taskId': 'phone',
                         'roleId': 'leader' if staff['roleIds'] else None}
                        for m in (540, 600)] if day.day == 1 else []}
            for staff in data['staff'] for day in dates(data)]


def solve_normal(data):
    # The HTTP fallback profile wraps these options in solve_in_process;
    # process lifecycle is covered separately by test_calendar_fallback.
    return solve_multi(data, 5, hint_strategy='balanced-incumbent-v4',
                       bulk_solution_transfer=True, covered_off_hints=True,
                       calendar_fallback=True)


@pytest.mark.parametrize('minimum,required,shortage', [(2, 3, 0), (4, 4, 120000)])
def test_ts_cap02_maximum_not_sum_in_both_directions(minimum, required, shortage):
    data = fixture(9)
    for staff in data['staff'][:3]:
        staff['roleIds'] = ['leader']
    data['roleRequirements'] = [{'id': 'literal-role', 'date': '2026-10-01',
                                'start': 540, 'end': 660, 'taskId': 'phone',
                                'roleId': 'leader', 'minimum': minimum,
                                'ratioNumerator': 1, 'ratioDenominator': 2,
                                'rounding': 'ceil', 'priority': 'first'}]
    # Six ordinary processors / two => three required; the three qualified
    # concurrent role holders are excluded from that denominator.
    report = check_multi(data, reference(data))
    assert report['status'] == 'VERIFIED'
    assert report['roleRequirements'][0]['intervals'] == [
        {'start': 540, 'end': 660, 'ordinaryPeople': 6, 'required': required,
         'actual': 3, 'shortage': required - 3}]
    before = deepcopy(data)
    result = solve_normal(data)
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['objective']['roleFirst'] == shortage
    assert check_multi(data, result['assignments'])['objectiveVector'] == result['validation']['objectiveVector']
    assert data == before


@pytest.mark.parametrize('interruption', ['meeting', 'training', 'break'])
def test_ts_cap03_nonprocessing_time_is_neither_role_numerator_nor_denominator(interruption):
    data = fixture(4)
    data['staff'][0]['roleIds'] = ['leader']
    rows = reference(data)
    if interruption == 'break':
        data['patterns'].append({'id': 'fixed', 'start': 540, 'end': 660,
                                 'breakKind': 'fixed', 'fixedBreak': [570, 600]})
        for index in (0, 1):
            data['staff'][index]['rules'][0].update(monthlyMin=90, monthlyMax=90)
            rows[index * 31]['shift'].update(patternId='fixed', breakKind='fixed',
                                           workedMinutes=90, **{'break': [570, 600]})
    else:
        data['events'] = [{'id': 'literal-event', 'date': '2026-10-01',
                           'start': 570, 'end': 600, 'kind': interruption,
                           'staffIds': [s['id'] for s in data['staff'][:2]]}]
    data['roleRequirements'] = [{'id': 'literal-role', 'date': '2026-10-01',
                                'start': 540, 'end': 660, 'taskId': 'phone',
                                'roleId': 'leader', 'minimum': 0,
                                'ratioNumerator': 1, 'ratioDenominator': 2,
                                'rounding': 'ceil', 'priority': 'first'}]
    report = check_multi(data, rows)
    assert report['status'] == 'VERIFIED'
    assert report['roleRequirements'][0]['intervals'] == [
        {'start': 540, 'end': 570, 'ordinaryPeople': 3, 'required': 2, 'actual': 1, 'shortage': 1},
        {'start': 570, 'end': 600, 'ordinaryPeople': 2, 'required': 1, 'actual': 0, 'shortage': 1},
        {'start': 600, 'end': 660, 'ordinaryPeople': 3, 'required': 2, 'actual': 1, 'shortage': 1}]
    assert [(v['start'], v['end'], v['processingPeople'], v['capacity'])
            for v in report['intervals']] == [(540, 570, 4, 4000), (570, 600, 2, 2000), (600, 660, 4, 4000)]


def test_ts_cap03_exact_ten_minute_preparation_excludes_both_role_counts():
    data = multi_synthetic(4, tiny=True)
    data['staff'][0]['roleIds'] = ['leader']
    for staff in data['staff'][1:]:
        staff['roleIds'] = []
    rows = reference(data)
    for index in range(4):
        rows[index * 31]['blocks'][1]['taskId'] = 'backoffice'
        if index >= 2:
            rows[index * 31]['blocks'][0]['taskId'] = 'backoffice'
    data['roleRequirements'] = [{'id': 'literal-role', 'date': '2026-10-01',
                                'start': 540, 'end': 660, 'taskId': None,
                                'roleId': 'leader', 'minimum': 0,
                                'ratioNumerator': 1, 'ratioDenominator': 2,
                                'rounding': 'ceil', 'priority': 'first'}]
    report = check_multi(data, rows)
    assert report['status'] == 'VERIFIED'
    assert report['roleRequirements'][0]['intervals'] == [
        {'start': 540, 'end': 600, 'ordinaryPeople': 3, 'required': 2, 'actual': 1, 'shortage': 1},
        {'start': 600, 'end': 610, 'ordinaryPeople': 2, 'required': 1, 'actual': 0, 'shortage': 1},
        {'start': 610, 'end': 660, 'ordinaryPeople': 3, 'required': 2, 'actual': 1, 'shortage': 1}]
    assert [report['daily'][i * 31]['preparationMinutes'] for i in range(4)] == [10, 10, 0, 0]


@pytest.mark.parametrize('capacity,shortage', [(500, 120000), (1000, 60000)])
def test_ts_cap01_demand01_headcount_is_not_processing_capacity(capacity, shortage):
    data = fixture()
    data['staff'][0]['skills'][0]['capacity'] = capacity
    for demand in data['demand']:
        demand['direct'] = 1500
    result = solve_normal(data)
    assert result['solverStatus'] == 'OPTIMAL'
    report = check_multi(data, result['assignments'])
    assert report['status'] == 'VERIFIED'
    assert report['generalShortage'] == shortage  # (1.5 - capacity) * 120 minutes
    assert all(v['processingPeople'] == 1 and v['capacity'] == capacity
               and v['required'] == 1500 for v in report['intervals'])


@pytest.mark.parametrize('level,capacity,valid', [(1, 5000, False), (2, 1000, True)])
def test_ts_cap01_high_capacity_cannot_replace_minimum_skill(level, capacity, valid):
    data = fixture()
    data['tasks'][0]['minimumLevel'] = 2
    data['staff'][0]['skills'][0].update(level=level, capacity=capacity)
    report = check_multi(data, reference(data))
    assert (report['status'] == 'VERIFIED') is valid
    if not valid:
        assert any(v.startswith('TASK_ELIGIBILITY:') for v in report['violations'])
    before = deepcopy(data)
    result = solve_normal(data)
    assert result['solverStatus'] == ('OPTIMAL' if valid else 'INFEASIBLE')
    assert data == before


@pytest.mark.parametrize('direct,required,shortage', [(0, 0, 0), (None, 1500, 60000)])
def test_ts_demand02_zero_and_unset_have_different_effective_demand(direct, required, shortage):
    data = fixture()
    for demand in data['demand']:
        demand.update(direct=direct, calculated=1500)
    before = deepcopy(data)
    result = solve_normal(data)
    report = check_multi(data, result['assignments'])
    assert result['solverStatus'] == 'OPTIMAL'
    assert report['status'] == 'VERIFIED'
    assert report['generalShortage'] == shortage
    assert all(v['required'] == required for v in report['intervals'])
    assert data == before
