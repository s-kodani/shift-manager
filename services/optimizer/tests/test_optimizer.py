from copy import deepcopy
from itertools import product

import pytest
from jsonschema import ValidationError

from optimizer.checker import cancellation_evaluation, check, task_timeline
from optimizer.contract import dates, validate_input
from optimizer.fixtures import synthetic
from optimizer.model import solve


def tiny():
    d = synthetic(1)
    d['patterns'] = [d['patterns'][0]]
    s = d['staff'][0]
    s['unavailable'] = [{'date': day.isoformat(), 'start': 0, 'end': 1440}
                        for day in dates(d)[2:]]
    s['rules'][0].update(monthlyMax=120, monthlyMin=120, minDays=1)
    d['demand'] = [x for x in d['demand'] if x['date'] == '2026-10-01' and x['start'] < 660]
    return d


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
def test_independent_full_enumeration(priority):
    data = tiny()
    data['priority'] = priority
    ds = dates(data)
    shift = {'patternId': 'short', 'start': 540, 'end': 660,
             'breakKind': 'auto', 'break': None, 'workedMinutes': 120}
    expected = []
    for values in product([None, shift], repeat=2):
        assignment = [{'staffId': data['staff'][0]['id'], 'date': day.isoformat(),
                       'shift': values[n] if n < 2 else None} for n, day in enumerate(ds)]
        report = check(data, assignment)
        if report['status'] == 'VERIFIED':
            o = report['objective']
            expected.append((o['missed'], o['shortage'], o['surplus']) if priority == 'preference'
                            else (o['shortage'], o['missed'], o['surplus']))
    result = solve(data)
    assert result['solverStatus'] == 'OPTIMAL'
    o = result['validation']['objective']
    actual = (o['missed'], o['shortage'], o['surplus']) if priority == 'preference' else (o['shortage'], o['missed'], o['surplus'])
    assert actual == min(expected)
    assert result['publication'] == 'BLOCKED_POC'
    for stage in result['stages']:
        assert stage['value'] == o[stage['name']]


def test_minimum_not_lowered_for_unavailability():
    d = tiny()
    d['staff'][0]['unavailable'] = [{'date': day.isoformat(), 'start': 0, 'end': 1440} for day in dates(d)]
    assert solve(d)['solverStatus'] == 'INFEASIBLE'
    assert d['staff'][0]['rules'][0]['monthlyMin'] == 120


def test_unknown_not_infeasible_and_missing_history():
    assert solve(tiny(), 0)['solverStatus'] == 'UNKNOWN'
    d = tiny()
    d['history'] = []
    result = solve(d)
    assert result['validation']['status'] == 'HISTORY_UNVERIFIED'
    assert result['publication'] == 'BLOCKED_POC'


def test_mutated_solution_is_rejected_by_checker():
    d = tiny()
    result = solve(d)
    altered = deepcopy(result['assignments'])
    shift = next(a['shift'] for a in altered if a['shift'])
    shift['workedMinutes'] = 999
    assert check(d, altered)['status'] == 'INVALID'
    altered.append(altered[0])
    assert check(d, altered)['violations'] == ['ASSIGNMENT_KEYS']


@pytest.mark.parametrize('slot', [30, 60])
def test_shortage_is_exact_and_direct_zero_overrides_calculated(slot):
    d = tiny()
    d['slotMinutes'] = slot
    d['demand'] = [{'date': '2026-10-01', 'start': m, 'end': m + slot,
                    'direct': 0, 'calculated': 10000} for m in range(540, 660, slot)]
    result = solve(d)
    assert result['validation']['objective']['shortage'] == 0
    assert result['validation']['objective']['surplus'] == 60000


def test_unsupported_fields_and_bad_period_rejected():
    d = tiny()
    d['roles'] = []
    with pytest.raises(ValidationError):
        validate_input(d)
    d = tiny()
    d['patterns'][0]['end'] = 500
    with pytest.raises((ValidationError, ValueError)):
        validate_input(d)
    d = tiny()
    d['history'].append({'staffId': d['staff'][0]['id'], 'date': '2026-11-01', 'workedMinutes': 120})
    with pytest.raises(ValueError, match='INVALID_HISTORY'):
        validate_input(d)


def test_hierarchy_and_previous_week_consecutive_boundary():
    d = tiny()
    d['staff'][0]['rules'].append({**d['staff'][0]['rules'][0], 'id': 'stricter', 'dailyMax': 60})
    assert solve(d)['solverStatus'] == 'INFEASIBLE'
    d = tiny()
    d['staff'][0]['rules'][0].update(maxConsecutive=1)
    d['history'][0]['workedMinutes'] = 120
    # Sep 30 work prohibits Oct 1; Oct 2 remains available.
    result = solve(d)
    assert result['assignments'][0]['shift'] is None
    assert result['validation']['status'] == 'VERIFIED'
    d['staff'][0]['rules'][0]['weeklyMax'] = 120
    assert solve(d)['solverStatus'] == 'INFEASIBLE'


def test_break_quantity_range_and_self_consistency():
    d = synthetic(1)
    d['patterns'] = [d['patterns'][1]]
    s = d['staff'][0]
    s['rules'][0].update(monthlyMin=150, monthlyMax=150)
    result = solve(d)
    assert result['validation']['status'] == 'VERIFIED'
    shift = next(a['shift'] for a in result['assignments'] if a['shift'])
    assert shift['break'][1] - shift['break'][0] == 30
    d['breakRule'].update(afterStart=150, beforeEnd=30)
    assert solve(d)['solverStatus'] == 'INFEASIBLE'
    d = tiny()
    d['breakRule'].update(basis='worked', threshold=90)
    # 120 attendance/no break requires 30; 30 break yields 90 worked requiring 0.
    assert solve(d)['solverStatus'] == 'INFEASIBLE'


def test_om_01_13_14_15_16_17_timeline_reference():
    r = task_timeline(540, 660, [(540, 600, 'A'), (600, 660, 'B')], [],
                      {('A', 'B'): 10}, {'A': 60, 'B': 60}, 60)
    assert r == {'processed': {'A': 60, 'B': 50}, 'preparation': 10,
                 'runs': [['A', 60], ['B', 60]], 'errors': []}
    r = task_timeline(540, 630, [(540, 630, 'A')], [(570, 600)], {}, {'A': 60}, 30)
    assert r['runs'] == [['A', 60]] and r['processed'] == {'A': 60}
    r = task_timeline(540, 660, [(540, 600, 'A'), (600, 660, 'B')], [(610, 630)], {('A', 'B'): 20}, {}, 60)
    assert 'PREPARATION_INTERRUPTED' in r['errors']
    with pytest.raises(ValueError):
        task_timeline(540, 600, [(540, 600, 'A')], [], {('A', 'B'): 40}, {}, 30)
    r = task_timeline(540, 570, [], [], {}, {}, 30)
    assert r['errors'] == ['WAITING']
    # Attendance may start halfway through a 60-minute task slot (Q106).
    r = task_timeline(570, 630, [(570, 630, 'A')], [], {}, {'A': 60}, 60)
    assert r['errors'] == [] and r['processed'] == {'A': 60}


def test_fixed_break_can_exceed_required_but_auto_cannot():
    d = tiny()
    d['patterns'] = [{'id': 'long', 'start': 540, 'end': 720, 'breakKind': 'fixed', 'fixedBreak': [570, 630]}]
    result = solve(d)
    assert result['validation']['status'] == 'VERIFIED'
    # Keep the same attendance/rest; only the automatic-break meaning changes.
    d['patterns'][0]['breakKind'] = 'auto'
    del d['patterns'][0]['fixedBreak']
    assignment = deepcopy(result['assignments'])
    for a in assignment:
        if a['shift']:
            a['shift']['breakKind'] = 'auto'
    assert any(v.startswith('BREAK_QUANTITY:') for v in check(d, assignment)['violations'])


def test_om_18_half_day_auto_fixed_and_double_deduction():
    rule = {'basis': 'elapsed', 'threshold': 240, 'requiredMinutes': 30}
    args = (540, 1080, [(780, 840)], [(540, 780)])
    auto = cancellation_evaluation(*args, 'auto', rule)
    assert auto == {'worked': 240, 'attendance': 300, 'rest': 60, 'required': 30,
                    'breakValid': False, 'workDay': True}
    assert cancellation_evaluation(*args, 'fixed', rule)['breakValid']
    r = cancellation_evaluation(540, 1080, [(720, 780)], [(540, 780)], 'auto', rule)
    assert r['worked'] == 300 and r['rest'] == 0
