"""Hand-counted mandatory-rule oracles for the current multi-task model/checker."""
from copy import deepcopy

import pytest
from jsonschema import ValidationError

from optimizer.contract import dates
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer.multi_contract import validate_multi
from optimizer.multi_model import solve_multi
from optimizer.server import SOLVE_PROFILES


def mandatory_fixture():
    data = multi_synthetic(1, tiny=True)
    data['staff'][0]['preferences'] = [{'date': '2026-10-01', 'kind': 'off'}]
    return data


def solve_normal(data):
    # Use the currently selected HTTP profile options; only the tiny-case
    # budget is shortened. Production's120-second setting is unchanged.
    profile = SOLVE_PROFILES['mvp-joint-covered-off-hints-v1']
    assert profile['hint_strategy'] == 'balanced-incumbent-v4'
    assert profile['bulk_solution_transfer'] is True
    assert profile['covered_off_hints'] is True
    return solve_multi(data, **{**profile, 'budget_seconds': 5})


def one_short_day(data):
    # One two-hour shift on October1, no rest needed at an exact120-minute
    # threshold. Duty allocation covers all120 minutes; shortage stays soft.
    sid = data['staff'][0]['id']
    return [{'staffId': sid, 'date': day.isoformat(),
             'shift': {'patternId': 'short', 'start': 540, 'end': 660,
                       'breakKind': 'auto', 'break': None, 'workedMinutes': 120,
                       'cancelled': []} if day.day == 1 else None,
             'blocks': [{'start': m, 'end': m + 60, 'taskId': 'phone', 'roleId': None}
                        for m in (540, 600)] if day.day == 1 else []}
            for day in dates(data)]


@pytest.mark.parametrize('layer', ['company', 'employment', 'individual'])
@pytest.mark.parametrize('field,strict,violation', [
    ('dailyMax', 60, 'DAILY_HOURS'), ('weeklyMax', 119, 'WEEKLY_HOURS'),
    ('monthlyMax', 119, 'MONTHLY_HOURS'), ('monthlyMin', 121, 'MONTHLY_HOURS'),
    ('minDays', 2, 'MONTHLY_DAYS'), ('minOff', 31, 'MONTHLY_DAYS'),
])
def test_ts_rule02_strict_layer_survives_other_looser_rules(layer, field, strict, violation):
    data = mandatory_fixture()
    original = deepcopy(data['staff'][0]['rules'][0])
    original.update(monthlyMin=60, monthlyMax=1000, minDays=0)
    data['staff'][0]['rules'] = [{**original, 'id': name,
                                **({field: strict} if name == layer else {})}
                               for name in ('company', 'employment', 'individual')]
    expected = f'{violation}:{data["staff"][0]["id"]}'
    report = check_multi(data, one_short_day(data))
    assert report['status'] == 'INVALID'
    assert len(report['violations']) == 1
    assert report['violations'][0].startswith(expected + ':')
    assert report['violations'][0].endswith(':' + layer)
    before = deepcopy(data)
    result = solve_normal(data)
    assert result['solverStatus'] == 'INFEASIBLE'
    assert result['assignments'] is None
    assert data == before


@pytest.mark.parametrize('kind', ['hours', 'days'])
def test_ts_rule04_month_minima_are_independent_and_exclude_prior_surplus(kind):
    data = mandatory_fixture()
    rule = data['staff'][0]['rules'][0]
    rule.update(monthlyMax=1000, monthlyMin=121 if kind == 'hours' else 120,
                minDays=2 if kind == 'days' else 1)
    # Known September work can affect the week, but cannot become October
    # hours or a second October work day. Weekly750 remains satisfied.
    data['history'][0]['workedMinutes'] = 500 if kind == 'hours' else 120
    report = check_multi(data, one_short_day(data))
    prefix = 'MONTHLY_HOURS' if kind == 'hours' else 'MONTHLY_DAYS'
    assert report['status'] == 'INVALID'
    assert report['violations'] == [f'{prefix}:{data["staff"][0]["id"]}:{rule["id"]}']
    before = deepcopy(data)
    result = solve_normal(data)
    assert result['solverStatus'] == 'INFEASIBLE'
    assert result['assignments'] is None
    assert data == before


def test_ts_rule05_all_unavailable_does_not_reduce_minimum_or_become_valid():
    data = mandatory_fixture()
    data['staff'][0]['unavailable'] = [{'date': d.isoformat(), 'start': 0, 'end': 1440}
                                      for d in dates(data)]
    before = deepcopy(data)
    empty = one_short_day(data)
    for row in empty:
        row['shift'], row['blocks'] = None, []
    report = check_multi(data, empty)
    assert report['status'] == 'INVALID'
    assert {v.split(':')[0] for v in report['violations']} == {'MONTHLY_HOURS', 'MONTHLY_DAYS'}
    result = solve_normal(data)
    assert result['solverStatus'] == 'INFEASIBLE'
    assert result['assignments'] is None
    assert data == before


def test_ts_rule07_overnight_pattern_is_rejected_by_current_input_contract():
    data = mandatory_fixture()
    data['patterns'][0].update(start=1320, end=360)
    with pytest.raises((ValueError, ValidationError)):
        validate_multi(data)


def four_hour_reference():
    data = mandatory_fixture()
    data['patterns'][0]['end'] = 780
    data['staff'][0]['contract']['end'] = 780
    data['staff'][0]['rules'][0].update(dailyMax=300, weeklyMax=750,
                                       monthlyMin=120, monthlyMax=1000)
    data['breakRule']['threshold'] = 240
    rows = one_short_day(data)
    rows[0]['shift'].update(end=780, workedMinutes=240)
    rows[0]['blocks'] = [{'start': m, 'end': m + 60, 'taskId': 'phone', 'roleId': None}
                         for m in (540, 600, 660, 720)]
    return data, rows


# Literal expected outcomes come from one240-minute October shift,30 October
# off days and the stated September facts, not from a production predicate.
@pytest.mark.parametrize('field,value,prior_minutes,violation', [
    ('dailyMax', 239, 0, 'DAILY_HOURS'), ('dailyMax', 240, 0, None),
    ('dailyMax', 241, 0, None),
    ('weeklyMax', 299, 60, 'WEEKLY_HOURS'), ('weeklyMax', 300, 60, None),
    ('weeklyMax', 301, 60, None),
    ('monthlyMax', 239, 0, 'MONTHLY_HOURS'), ('monthlyMax', 240, 0, None),
    ('monthlyMax', 241, 0, None),
    ('monthlyMin', 239, 500, None), ('monthlyMin', 240, 500, None),
    ('monthlyMin', 241, 500, 'MONTHLY_HOURS'),
    ('minDays', 0, 120, None), ('minDays', 1, 120, None),
    ('minDays', 2, 120, 'MONTHLY_DAYS'),
    ('minOff', 29, 0, None), ('minOff', 30, 0, None),
    ('minOff', 31, 0, 'MONTHLY_DAYS'),
    ('contract-end', 750, 0, 'CONTRACT'), ('contract-end', 780, 0, None),
    ('contract-end', 810, 0, None),
    ('unavailable-start', 779, 0, 'UNAVAILABLE'),
    ('unavailable-start', 780, 0, None), ('unavailable-start', 781, 0, None),
])
def test_ts_rule01_04_06_07_boundary_oracles(field, value, prior_minutes, violation):
    data, rows = four_hour_reference()
    staff, rule = data['staff'][0], data['staff'][0]['rules'][0]
    data['history'][0]['workedMinutes'] = prior_minutes
    if field == 'contract-end':
        staff['contract']['end'] = value
    elif field == 'unavailable-start':
        staff['unavailable'].append({'date': '2026-10-01', 'start': value, 'end': value + 1})
    else:
        rule[field] = value
        if field == 'minOff':
            rule['minDays'] = 0  #31 off days is legal input, but cannot meet120 work minutes.
    report = check_multi(data, rows)
    if violation:
        assert report['status'] == 'INVALID'
        assert len(report['violations']) == 1
        assert report['violations'][0].startswith(violation + ':')
    else:
        assert report['status'] == 'VERIFIED'
        assert report['violations'] == []
    before = deepcopy(data)
    result = solve_normal(data)
    assert data == before
    if violation:
        assert result['solverStatus'] == 'INFEASIBLE'
        assert result['assignments'] is None
    else:
        assert result['solverStatus'] in ('OPTIMAL', 'FEASIBLE')
        assert check_multi(data, result['assignments'])['status'] == 'VERIFIED'


@pytest.mark.parametrize('week_start,violation', [(0, False), (6, True)])
def test_ts_rule03_week_start_boundary_oracle(week_start, violation):
    data, rows = four_hour_reference()
    data['weekStart'] = week_start
    data['staff'][0]['rules'][0]['weeklyMax'] = 240
    next(h for h in data['history'] if h['date'] == '2026-09-27')['workedMinutes'] = 60
    # September27 is Sunday: excluded by Monday's September28 week, included
    # by Sunday's September27 week. The same October1 shift is240 minutes.
    report = check_multi(data, rows)
    assert report['status'] == ('INVALID' if violation else 'VERIFIED')
    assert [v.split(':')[0] for v in report['violations']] == (['WEEKLY_HOURS'] if violation else [])
    result = solve_normal(data)
    if violation:
        assert result['solverStatus'] == 'INFEASIBLE'
    else:
        assert result['validation']['status'] == 'VERIFIED'


@pytest.mark.parametrize('maximum,valid', [(1, False), (2, True), (3, True)])
def test_ts_rule06_preceding_month_consecutive_boundary_oracle(maximum, valid):
    data, rows = four_hour_reference()
    data['history'][0]['workedMinutes'] = 60  # September30, followed by October1 work.
    data['staff'][0]['rules'][0]['maxConsecutive'] = maximum
    report = check_multi(data, rows)
    assert report['status'] == ('VERIFIED' if valid else 'INVALID')
    assert [v.split(':')[0] for v in report['violations']] == ([] if valid else ['CONSECUTIVE'])
    result = solve_normal(data)
    if valid:
        assert result['validation']['status'] == 'VERIFIED'
    else:
        assert result['solverStatus'] == 'INFEASIBLE'


@pytest.mark.parametrize('basis,threshold,valid', [
    ('worked', 209, True), ('worked', 210, False),
    ('elapsed', 209, True), ('elapsed', 210, True),
])
def test_ts_rule09_worked_and_elapsed_break_boundary_oracle(basis, threshold, valid):
    data, rows = four_hour_reference()
    data['breakRule'].update(basis=basis, threshold=threshold)
    data['staff'][0]['rules'][0].update(monthlyMin=210, monthlyMax=210)
    rows[0]['shift'].update(breakKind='auto', workedMinutes=210)
    rows[0]['shift']['break'] = [600, 630]
    # Attendance240, rest30, work210. At a worked threshold210 the given
    # rest is unnecessary, while removing it makes240 work require30: no
    # self-consistent automatic break. Elapsed240 still requires30.
    report = check_multi(data, rows)
    assert report['status'] == ('VERIFIED' if valid else 'INVALID')
    assert [v.split(':')[0] for v in report['violations']] == ([] if valid else ['BREAK_QUANTITY'])
    result = solve_normal(data)
    if valid:
        assert result['validation']['status'] == 'VERIFIED'
        shift = next(a['shift'] for a in result['assignments'] if a['shift'])
        assert shift['break'][1] - shift['break'][0] == 30
        assert shift['workedMinutes'] == 210
    else:
        assert result['solverStatus'] == 'INFEASIBLE'
        assert result['assignments'] is None


@pytest.mark.parametrize('interruption', ['break', 'training', 'meeting'])
def test_ts_rule08_10_11_paid_minutes_and_continuation_oracle(interruption):
    data, rows = four_hour_reference()
    sid = data['staff'][0]['id']
    data['tasks'][0]['minimumMinutes'] = 180
    rows[0]['blocks'] = [b for b in rows[0]['blocks'] if b['start'] != 600]
    if interruption == 'break':
        data['patterns'][0].update(breakKind='fixed', fixedBreak=[600, 660])
        data['breakRule'].update(threshold=120, requiredMinutes=30)
        data['staff'][0]['rules'][0].update(monthlyMin=180, monthlyMax=180)
        rows[0]['shift'].update(breakKind='fixed', workedMinutes=180)
        rows[0]['shift']['break'] = [600, 660]
    else:
        data['staff'][0]['rules'][0].update(monthlyMin=240, monthlyMax=240)
        data['events'] = [{'id': 'interruption', 'date': '2026-10-01', 'start': 600,
                           'end': 660, 'kind': interruption, 'staffIds': [sid]}]
    report = check_multi(data, rows)
    assert report['status'] == 'VERIFIED'
    assert report['daily'][0]['runs'] == [['phone', 180]]
    assert report['daily'][0]['processedMinutes'] == 180
    assert report['daily'][0]['workedMinutes'] == (180 if interruption == 'break' else 240)
    assert report['daily'][0]['eventMinutes'] == (0 if interruption == 'break' else 60)
    result = solve_normal(data)
    assert result['validation']['status'] == 'VERIFIED'
    if interruption == 'break':
        # Fixed60 is legal when30 is needed; the exact same automatic60 is not.
        data['patterns'][0]['breakKind'] = 'auto'
        del data['patterns'][0]['fixedBreak']
        rows[0]['shift']['breakKind'] = 'auto'
        assert any(v.startswith('BREAK_QUANTITY:') for v in check_multi(data, rows)['violations'])
        assert solve_normal(data)['solverStatus'] == 'INFEASIBLE'


def test_ts_rule11_other_business_splits_same_task_runs():
    data, rows = four_hour_reference()
    data['patterns'][0]['end'] = 720
    data['breakRule']['threshold'] = 180
    data['staff'][0]['rules'][0].update(monthlyMin=180, monthlyMax=180)
    data['tasks'][0]['minimumMinutes'] = 120
    data['transitions'].append({'fromTaskId': 'backoffice', 'toTaskId': 'phone', 'minutes': 0})
    rows[0]['shift'].update(end=720, workedMinutes=180)
    rows[0]['blocks'] = [{'start': m, 'end': m + 60,
                         'taskId': 'backoffice' if m == 600 else 'phone', 'roleId': None}
                        for m in (540, 600, 660)]
    # Phone60 -> backoffice60 -> phone60 is not one phone120 run.
    report = check_multi(data, rows)
    assert report['status'] == 'INVALID'
    assert [v.split(':')[0] for v in report['violations']] == ['MINIMUM_RUN']
    result = solve_normal(data)
    assert result['validation']['status'] == 'VERIFIED'
    assert all(amount >= 120 for task, amount in result['validation']['daily'][0]['runs']
               if task == 'phone')


def test_ts_rule08_12_directional_preparation_is_paid_but_has_no_processing_capacity():
    data = mandatory_fixture()
    data['transitions'] = [{'fromTaskId': 'phone', 'toTaskId': 'backoffice', 'minutes': 30},
                           {'fromTaskId': 'backoffice', 'toTaskId': 'phone', 'minutes': 0}]
    forward = one_short_day(data)
    forward[0]['blocks'][1]['taskId'] = 'backoffice'
    report = check_multi(data, forward)
    assert report['status'] == 'VERIFIED'
    assert report['daily'][0]['workedMinutes'] == 120
    assert report['daily'][0]['preparationMinutes'] == 30
    assert report['daily'][0]['processedMinutes'] == 90
    assert report['daily'][0]['runs'] == [['phone', 60], ['backoffice', 60]]
    assert report['generalShortage'] == 30000
    task = [r for r in report['intervals'] if r['taskId'] == 'backoffice']
    assert [(r['start'], r['end'], r['capacity']) for r in task] == [(600, 630, 0), (630, 660, 1000)]
    reverse = one_short_day(data)
    reverse[0]['blocks'][0]['taskId'] = 'backoffice'
    reverse_report = check_multi(data, reverse)
    assert reverse_report['status'] == 'VERIFIED'
    assert reverse_report['daily'][0]['preparationMinutes'] == 0
    assert reverse_report['daily'][0]['processedMinutes'] == 120
    result = solve_normal(data)
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['generalShortage'] == 30000
