from copy import deepcopy
from itertools import product

import pytest
from jsonschema import ValidationError

from optimizer.contract import dates
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer.multi_contract import validate_multi
from optimizer.multi_model import solve_multi


def assignments(data, blocks, shift=None):
    if shift is None:
        p = data['patterns'][0]
        shift = {'patternId': p['id'], 'start': p['start'], 'end': p['end'],
                 'breakKind': p['breakKind'], 'break': p.get('fixedBreak'),
                 'workedMinutes': p['end'] - p['start'] - (p['fixedBreak'][1] - p['fixedBreak'][0] if 'fixedBreak' in p else 0),
                 'cancelled': []}
    return [{'staffId': s['id'], 'date': day.isoformat(),
             'shift': deepcopy(shift) if day.day == 1 else None,
             'blocks': deepcopy(blocks) if day.day == 1 else []}
            for s in data['staff'] for day in dates(data)]


def block(start, end, task='phone', role=None):
    return {'start': start, 'end': end, 'taskId': task, 'roleId': role}


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
@pytest.mark.parametrize('strategy', ['legacy-first-v1', 'balanced-coverage-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4'])
@pytest.mark.parametrize('tight_run_bounds', [False, True])
@pytest.mark.parametrize('bulk_solution_transfer', [False, True])
def test_joint_model_matches_independent_full_enumeration(priority, strategy, tight_run_bounds,
                                                        bulk_solution_transfer):
    d = multi_synthetic(1, tiny=True)
    d['priority'] = priority
    d['staff'][0]['preferences'] = [{'date': '2026-10-01', 'kind': 'off'},
                                     {'date': '2026-10-01', 'kind': 'pattern', 'patternId': 'short'}]
    expected = []
    for values in product(['phone', 'backoffice'], repeat=2):
        report = check_multi(d, assignments(d, [block(540, 600, values[0]), block(600, 660, values[1])]))
        if report['status'] == 'VERIFIED':
            expected.append(report['objectiveVector'])
    r = solve_multi(d, 5, hint_strategy=strategy, tight_run_bounds=tight_run_bounds,
                    bulk_solution_transfer=bulk_solution_transfer)
    assert r['solverStatus'] == 'OPTIMAL'
    assert r['validation']['status'] == 'VERIFIED'
    assert r['validation']['objectiveVector'] == min(expected)
    assert r['validation']['generalShortage'] == 10000  # ten exact preparation minutes
    assert r['validation']['daily'][0]['preparationMinutes'] == 10
    assert r['publication'] == 'BLOCKED_A1'
    assert all(s['value'] == s['finalValue'] for s in r['stages'])


def test_om13_meeting_bridges_minimum_run_without_capacity():
    d = multi_synthetic(1, 30, tiny=True)
    d['patterns'][0]['end'] = 630
    d['staff'][0]['rules'][0].update(monthlyMin=90, monthlyMax=90)
    d['events'] = [{'id': 'meeting', 'date': '2026-10-01', 'start': 570, 'end': 600,
                    'kind': 'meeting', 'staffIds': [d['staff'][0]['id']]}]
    d['demand'] = [{'taskId': 'phone', 'date': '2026-10-01', 'start': m, 'end': m+30,
                    'direct': 1000, 'calculated': None} for m in range(540, 630, 30)]
    r = solve_multi(d, 5)
    report = r['validation']
    assert report['status'] == 'VERIFIED'
    assert report['daily'][0]['runs'] == [['phone', 60]]
    assert report['daily'][0]['eventMinutes'] == 30
    assert report['generalShortage'] == 30000


def test_om14_preparation_interrupted_rejected_by_model_and_checker():
    d = multi_synthetic(1, tiny=True)
    d['transitions'][0]['minutes'] = 20
    for t in d['tasks']:
        t['minimumMinutes'] = 0
    d['staff'][0]['rules'][0].update(monthlyMin=100, monthlyMax=100)
    d['events'] = [{'id': 'training', 'date': '2026-10-01', 'start': 610, 'end': 630,
                    'kind': 'training', 'staffIds': [d['staff'][0]['id']]}]
    bad = assignments(d, [block(540, 600), block(600, 660, 'backoffice')])
    bad[0]['shift']['workedMinutes'] = 120  # events are paid work, still 120!
    d['staff'][0]['rules'][0].update(monthlyMin=120, monthlyMax=120)
    assert any(x.startswith('PREPARATION_INTERRUPTED:') for x in check_multi(d, bad)['violations'])
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    assert not (r['assignments'][0]['blocks'][0]['taskId'] == 'phone' and r['assignments'][0]['blocks'][1]['taskId'] == 'backoffice')


def test_om15_equal_slot_preparation_has_zero_capacity_and_larger_rejected():
    d = multi_synthetic(1, 30, tiny=True)
    for t in d['tasks']:
        t['minimumMinutes'] = 30
    d['transitions'][0]['minutes'] = 30
    a = assignments(d, [block(540, 570), block(570, 600), block(600, 630, 'backoffice'), block(630, 660, 'backoffice')])
    report = check_multi(d, a)
    assert report['status'] == 'VERIFIED'
    assert report['daily'][0]['preparationMinutes'] == 30
    assert report['generalShortage'] == 30000
    r = solve_multi(d, 5)
    assert r['validation']['objectiveVector'] <= report['objectiveVector']
    d['transitions'][0]['minutes'] = 40
    with pytest.raises(ValueError, match='PREPARATION_EXCEEDS_SLOT'):
        validate_multi(d)


def test_om16_initial_task_no_preparation_and_17_waiting_rejected():
    d = multi_synthetic(1, tiny=True)
    d['demand'] = []
    reference = check_multi(d, assignments(d, [block(540, 600), block(600, 660)]))
    assert reference['daily'][0]['preparationMinutes'] == 0
    assert reference['objective']['surplus'] == 120000
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    # A real task switch may reduce processing surplus; it is still paid work.
    assert r['validation']['objective']['surplus'] == 110000
    bad = deepcopy(r['assignments'])
    bad[0]['blocks'] = []
    assert any(x.startswith('WAITING:') for x in check_multi(d, bad)['violations'])


def role_req(role='leader', scope='phone', rounding='ceil', minimum=1, numerator=1, denominator=10):
    return {'id': 'role-' + role, 'date': '2026-10-01', 'start': 540, 'end': 660,
            'taskId': scope, 'roleId': role, 'minimum': minimum, 'ratioNumerator': numerator,
            'ratioDenominator': denominator, 'rounding': rounding, 'priority': 'first'}


@pytest.mark.parametrize('rounding,required', [('ceil', 2), ('floor', 1)])
def test_om03_04_qualified_roles_denominator_and_maximum(rounding, required):
    d = multi_synthetic(15, tiny=True)
    d['tasks'].append({'id': 'management', 'kind': 'dedicated', 'minimumLevel': 1, 'minimumMinutes': 0})
    a = assignments(d, [block(540, 600), block(600, 660)])
    for index in (12, 13):
        for b in a[index * 31]['blocks']:
            b['roleId'] = 'leader'
    d['staff'][14]['skills'].append({'taskId': 'management', 'level': 1, 'capacity': 0})
    for b in a[14 * 31]['blocks']:
        b['taskId'] = 'management'
    d['roleRequirements'] = [role_req(rounding=rounding)]
    r = check_multi(d, a)
    assert r['status'] == 'VERIFIED'
    assert r['roleRequirements'][0]['requiredPeak'] == required  # denominator 12, not 14/15
    assert r['objective']['roleFirst'] == 0
    assert r['daily'][14 * 31]['processedMinutes'] == 0
    phone = next(x for x in r['intervals'] if x['taskId'] == 'phone' and x['start'] == 540)
    assert phone['processingPeople'] == 14  # dedicated management is excluded
    assert phone['ordinaryPeople'] == 12
    assert phone['rolePeople']['leader'] == 2
    assert r['roleRequirements'][0]['intervals'] == [
        {'start': 540, 'end': 660, 'ordinaryPeople': 12,
         'required': required, 'actual': 2, 'shortage': 0}]


def test_explanation_people_are_not_capacity_and_split_even_when_capacity_is_equal():
    d = multi_synthetic(3, tiny=True)
    p = d['patterns'][0]
    d['patterns'] = [dict(p, id='early', end=600), dict(p, id='late', start=600)]
    d['demand'] = [{'date': '2026-10-01', 'start': start, 'end': start + 60,
                    'taskId': 'phone', 'direct': 1000, 'calculated': None}
                   for start in (540, 600)]
    a = assignments(d, [])
    for index, s in enumerate(d['staff']):
        s['rules'][0].update(monthlyMin=60, monthlyMax=60)
        s['skills'][0]['capacity'] = 1000 if index == 0 else 500
        chosen = d['patterns'][0 if index == 0 else 1]
        a[index * 31]['shift'].update(patternId=chosen['id'], start=chosen['start'],
                                     end=chosen['end'], workedMinutes=60)
        a[index * 31]['blocks'] = [block(chosen['start'], chosen['end'])]
    report = check_multi(d, a)
    assert report['status'] == 'VERIFIED'
    assert [(x['start'], x['end'], x['capacity'], x['processingPeople'])
            for x in report['intervals']] == [(540, 600, 1000, 1), (600, 660, 1000, 2)]
    assert report['generalShortage'] == 0


def test_role_model_one_person_cannot_fulfil_two_roles():
    d = multi_synthetic(1, tiny=True)
    d['roles'].append({'id': 'sv', 'allowedTasks': ['phone', 'backoffice']})
    d['staff'][0]['roleIds'].append('sv')
    d['roleRequirements'] = [role_req(scope=None, numerator=0), role_req('sv', None, numerator=0)]
    d['demand'] = []
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    assert r['validation']['objective']['roleFirst'] == 120000
    bad = deepcopy(r['assignments'])
    bad[0]['blocks'][0]['roleId'] = ['sv', 'leader']
    assert check_multi(d, bad)['violations'] == ['OUTPUT_SHAPE']


def test_direct_zero_and_skill_eligibility_separate_from_capacity():
    d = multi_synthetic(1, tiny=True)
    for q in d['demand']:
        q['direct'] = 0
    r = solve_multi(d, 5)
    assert r['validation']['generalShortage'] == 0
    d['staff'][0]['skills'][0]['level'] = 0
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    assert all(b['taskId'] == 'backoffice' for b in r['assignments'][0]['blocks'])
    d['staff'][0]['skills'][1]['level'] = 0
    assert solve_multi(d, 5)['solverStatus'] == 'INFEASIBLE'


def test_fixed_unavailability_exception_only_exact_day_and_interval():
    d = multi_synthetic(1, tiny=True)
    a = assignments(d, [block(540, 600), block(600, 660)])
    sid = d['staff'][0]['id']
    d['locks'] = [{'id': 'lock', 'staffId': sid, 'date': '2026-10-01',
                   'parts': ['pattern', 'time', 'break'], 'shift': a[0]['shift']}]
    d['staff'][0]['unavailable'].append({'date': '2026-10-01', 'start': 540, 'end': 600})
    assert solve_multi(d, 5)['solverStatus'] == 'INFEASIBLE'
    d['exceptions'] = [{'id': 'exception', 'staffId': sid, 'date': '2026-10-01', 'lockId': 'lock',
                        'start': 540, 'end': 600, 'reason': 'Fictional approved coverage'}]
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    d['exceptions'][0]['end'] = 570
    assert solve_multi(d, 5)['solverStatus'] == 'INFEASIBLE'
    d['exceptions'][0]['end'] = 600
    d['staff'][0]['rules'][0]['monthlyMin'] = 240
    d['staff'][0]['rules'][0]['monthlyMax'] = 240
    assert solve_multi(d, 5)['solverStatus'] == 'INFEASIBLE'


def test_manual_unavailability_exception_does_not_create_a_lock_or_relax_other_rules():
    d = multi_synthetic(1, tiny=True)
    a = assignments(d, [block(540, 600), block(600, 660)])
    sid = d['staff'][0]['id']
    d['staff'][0]['unavailable'] = [{'date': '2026-10-01', 'start': 540, 'end': 600}]
    assert check_multi(d, a)['status'] == 'INVALID'
    d['exceptions'] = [{'id': 'manual', 'lockId': None, 'staffId': sid, 'date': '2026-10-01',
                        'start': 540, 'end': 600, 'reason': 'Fictional approved manual placement'}]
    assert check_multi(d, a)['status'] == 'VERIFIED'
    assert d['locks'] == []
    d['exceptions'][0]['end'] = 570
    assert any(x.startswith('UNAVAILABLE:') for x in check_multi(d, a)['violations'])
    d['exceptions'][0]['end'] = 600
    d['staff'][0]['rules'][0]['monthlyMin'] = 240
    assert any(x.startswith('MONTHLY_HOURS:') for x in check_multi(d, a)['violations'])


def test_unfixed_manual_exception_requires_real_placement_and_cannot_reach_automatic_solver():
    d = multi_synthetic(1, tiny=True)
    a = assignments(d, [block(540, 600), block(600, 660)])
    sid = d['staff'][0]['id']
    d['exceptions'] = [{'id': 'manual', 'lockId': None, 'staffId': sid, 'date': '2026-10-01',
                        'start': 540, 'end': 600, 'reason': 'Fictional approved manual placement'}]
    with pytest.raises(ValueError, match='UNFIXED_EXCEPTION_REQUIRES_MANUAL_CHECK'):
        solve_multi(d, 5)
    d['exceptions'][0]['end'] = 690
    assert any(x.startswith('MANUAL_EXCEPTION_PLACEMENT:') for x in check_multi(d, a)['violations'])
    d['exceptions'][0]['end'] = 600
    d['exceptions'][0]['date'] = '2026-10-02'
    assert any(x.startswith('MANUAL_EXCEPTION_PLACEMENT:') for x in check_multi(d, a)['violations'])
    d['exceptions'][0]['reason'] = '  '
    with pytest.raises(ValueError, match='MANUAL_EXCEPTION_REQUIRES_REASON'):
        check_multi(d, a)


def test_published_reallocation_maintains_times_and_cancellation():
    d = multi_synthetic(1, tiny=True)
    d['mode'] = 'reallocation'
    d['published'] = [{k: v for k, v in a.items() if k != 'blocks'} for a in assignments(d, [])]
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    bad = deepcopy(r['assignments'])
    bad[0]['shift']['end'] = 630
    assert any(x.startswith('PUBLISHED_MAINTENANCE:') for x in check_multi(d, bad)['violations'])
    bad = deepcopy(r['assignments'])
    bad[1]['shift'] = deepcopy(bad[0]['shift'])
    assert any(x.startswith('PUBLISHED_MAINTENANCE:') for x in check_multi(d, bad)['violations'])


@pytest.mark.parametrize('kind,valid', [('fixed', True), ('auto', False)])
def test_om18_19_half_day_rest_and_remaining_preferences(kind, valid):
    d = multi_synthetic(1, tiny=True)
    p = d['patterns'][0]
    p.update(end=1080, breakKind=kind)
    if kind == 'fixed':
        p['fixedBreak'] = [780, 840]
    d['staff'][0]['contract']['end'] = 1080
    d['staff'][0]['rules'][0].update(dailyMax=540, weeklyMax=540, monthlyMin=240, monthlyMax=240)
    d['staff'][0]['preferences'] = [{'date': '2026-10-01', 'kind': 'pattern', 'patternId': 'short'},
                                    {'date': '2026-10-01', 'kind': 'window', 'start': 780, 'end': 1080}]
    d['breakRule'].update(threshold=240, requiredMinutes=30)
    shift = {'patternId': 'short', 'start': 540, 'end': 1080, 'breakKind': kind, 'break': [780, 840],
             'workedMinutes': 240, 'cancelled': [[540, 780]]}
    a = assignments(d, [block(m, m+60) for m in range(840, 1080, 60)], shift)
    d['mode'] = 'reallocation'
    d['published'] = [{k: v for k, v in x.items() if k != 'blocks'} for x in a]
    report = check_multi(d, a)
    assert (report['status'] == 'VERIFIED') == valid
    assert [p['fulfilled'] for p in report['preferences']] == [False, True]
    r = solve_multi(d, 5)
    assert (r['solverStatus'] != 'INFEASIBLE') == valid
    assert shift['breakKind'] == kind and shift['start'] == 540


def test_history_unknown_and_output_mutation():
    d = multi_synthetic(1, tiny=True)
    assert solve_multi(d, 0)['solverStatus'] == 'UNKNOWN'
    d['history'] = []
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'HISTORY_UNVERIFIED'
    bad = deepcopy(r['assignments'])
    bad[0]['shift']['workedMinutes'] = 999
    assert any(x.startswith('WORKED_MINUTES:') for x in check_multi(d, bad)['violations'])
    bad = deepcopy(r['assignments'])
    bad[0]['blocks'][0]['end'] += 30
    assert any(x.startswith('TASK_SLOT:') for x in check_multi(d, bad)['violations'])
    bad = deepcopy(r['assignments'])
    bad[0]['blocks'][0]['start'] = 540.0
    assert check_multi(d, bad)['violations'] == ['OUTPUT_SHAPE']


def test_event_conflicting_fixed_break_infeasible():
    d = multi_synthetic(1, tiny=True)
    d['patterns'][0].update(breakKind='fixed', fixedBreak=[570, 600])
    d['staff'][0]['rules'][0].update(monthlyMin=90, monthlyMax=90)
    d['events'] = [{'id': 'meeting', 'date': '2026-10-01', 'start': 570, 'end': 600,
                    'kind': 'meeting', 'staffIds': [d['staff'][0]['id']]}]
    assert solve_multi(d, 5)['solverStatus'] == 'INFEASIBLE'


def test_strict_contract_no_business_locks_or_extra_fields():
    d = multi_synthetic(1, tiny=True)
    d['taskLocks'] = []
    with pytest.raises(ValidationError):
        validate_multi(d)
    d = multi_synthetic(1, tiny=True)
    d['capacityScale'] = 1000.5
    with pytest.raises(ValidationError):
        validate_multi(d)
    d = multi_synthetic(1, tiny=True)
    d['exceptions'] = [{'id': 'exception', 'staffId': d['staff'][0]['id'], 'date': '2026-10-01',
                        'lockId': 'missing', 'start': 540, 'end': 600, 'reason': 'Fictional'}]
    with pytest.raises(ValueError, match='INVALID_FIXED_EXCEPTION'):
        validate_multi(d)


def test_roles_can_change_at_real_processing_boundary_inside_task_slot():
    d = multi_synthetic(1, tiny=True)
    d['roles'].append({'id': 'sv', 'allowedTasks': ['phone', 'backoffice']})
    d['staff'][0]['roleIds'].append('sv')
    d['roleRequirements'] = [role_req(scope=None, numerator=0), role_req('sv', None, numerator=0)]
    d['roleRequirements'][0].update(start=540, end=570)
    d['roleRequirements'][1].update(start=570, end=600)
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    assert r['validation']['objective']['roleFirst'] == 0
    assert {'sv', 'leader'} <= {x['roleId'] for x in r['assignments'][0]['roleIntervals']}
    bad = deepcopy(r['assignments'])
    bad[0]['roleIntervals'].append(deepcopy(bad[0]['roleIntervals'][0]))
    assert any(x.startswith('ROLE_OVERLAP:') for x in check_multi(d, bad)['violations'])


def test_no_phantom_switch_across_fully_occupied_slot():
    d = multi_synthetic(1, 30, tiny=True)
    d['events'] = [{'id': 'training', 'date': '2026-10-01', 'start': 570, 'end': 600,
                    'kind': 'training', 'staffIds': [d['staff'][0]['id']]}]
    for t in d['tasks']:
        t['minimumMinutes'] = 90
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    assert len(r['validation']['daily'][0]['runs']) == 1
    bad = deepcopy(r['assignments'])
    bad[0]['blocks'].append(block(570, 600, 'backoffice'))
    assert any(x.startswith('PHANTOM_TASK:') for x in check_multi(d, bad)['violations'])


def test_role_settings_follow_company_and_scope_and_do_not_double_penalize():
    d = multi_synthetic(1, tiny=True)
    d['roleRequirements'] = [role_req(), {**role_req(), 'id': 'duplicate'}]
    with pytest.raises(ValueError, match='OVERLAPPING_ROLE_REQUIREMENT'):
        validate_multi(d)
    d['roleRequirements'][1].update(taskId=None, rounding='floor')
    with pytest.raises(ValueError, match='ROLE_ROUNDING_MUST_BE_COMPANY_WIDE'):
        validate_multi(d)
    d['roleRequirements'][1].update(taskId='phone', start=660, end=720, rounding='ceil', priority='same')
    with pytest.raises(ValueError, match='ROLE_PRIORITY_MUST_BE_SCOPE_WIDE'):
        validate_multi(d)
    d = multi_synthetic(1, tiny=True)
    d['staff'][0]['skills'][0]['capacity'] = 1000.0
    with pytest.raises(ValueError, match='INTEGER_VALUES_REQUIRED'):
        validate_multi(d)


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
@pytest.mark.parametrize('strategy', ['legacy-first-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3'])
def test_mixed_role_objective_uses_equal_person_minutes(priority, strategy):
    d = multi_synthetic(1, tiny=True)
    d['priority'] = priority
    d['roles'].append({'id': 'sv', 'allowedTasks': ['phone', 'backoffice']})
    d['staff'][0]['roleIds'].append('sv')
    d['roleRequirements'] = [role_req(scope='phone', numerator=0), role_req('sv', None, numerator=0)]
    d['roleRequirements'][1]['priority'] = 'same'
    r = solve_multi(d, 5, hint_strategy=strategy)
    assert r['solverStatus'] == 'OPTIMAL'
    assert r['validation']['status'] == 'VERIFIED'
    report = r['validation']
    assert report['objective']['combined'] == report['generalShortage'] + report['roleSameShortage']
    assert report['objective']['roleFirst'] == 0  # first role protected despite backoffice shortage
    assert all(b['taskId'] == 'phone' for b in r['assignments'][0]['blocks'])
    assert report['roleSameShortage'] == 120000
    assert report['generalShortage'] == 60000
    expected = ['roleFirst', 'combined', 'missed', 'surplus']
    if priority == 'preference':
        expected = ['missed', 'roleFirst', 'combined', 'surplus']
    assert report['objectiveOrder'] == expected


def test_break_range_self_consistency_and_remaining_month_minimum():
    d = multi_synthetic(1, tiny=True)
    d['breakRule'].update(basis='worked', threshold=90)
    # No break -> 120 worked needs 30; with 30 break -> 90 worked needs zero.
    assert solve_multi(d, 5)['solverStatus'] == 'INFEASIBLE'
    d = multi_synthetic(1, tiny=True)
    d['patterns'][0].update(end=720)
    d['staff'][0]['rules'][0].update(monthlyMin=150, monthlyMax=150)
    d['breakRule'].update(afterStart=150, beforeEnd=30)
    assert solve_multi(d, 5)['solverStatus'] == 'INFEASIBLE'
    d = multi_synthetic(1, tiny=True)
    d['mode'] = 'reallocation'
    a = assignments(d, [])
    a[0]['shift']['cancelled'] = [[540, 600]]
    a[0]['shift']['workedMinutes'] = 60
    d['published'] = [{k: v for k, v in x.items() if k != 'blocks'} for x in a]
    assert solve_multi(d, 5)['solverStatus'] == 'INFEASIBLE'
    assert d['staff'][0]['rules'][0]['monthlyMin'] == 120


@pytest.mark.parametrize('priority,day', [('coverage', '2026-10-01'), ('preference', '2026-10-02')])
def test_priority_selects_different_feasible_days_without_relaxing_minimum(priority, day):
    d = multi_synthetic(1, tiny=True)
    d['priority'] = priority
    s = d['staff'][0]
    s['unavailable'] = [u for u in s['unavailable'] if u['date'] != '2026-10-02']
    s['preferences'] = [{'date': '2026-10-01', 'kind': 'off'}]
    r = solve_multi(d, 5)
    assert r['solverStatus'] == 'OPTIMAL'
    assert r['validation']['status'] == 'VERIFIED'
    assert r['metrics']['modelEncoding'] == 'shared-daily-v1'
    assert r['metrics']['initialHintVariables'] > 0
    assert [a['date'] for a in r['assignments'] if a['shift']] == [day]
    assert sum(a['shift']['workedMinutes'] for a in r['assignments'] if a['shift']) == 120


def test_next_month_confirmed_history_checked_without_inventing_future_days_off():
    d = multi_synthetic(1, tiny=True)
    s = d['staff'][0]
    s['contract']['weekdays'] = list(range(7))
    s['unavailable'] = [{'date': day.isoformat(), 'start': 0, 'end': 1440} for day in dates(d)[:-1]]
    s['rules'][0]['maxConsecutive'] = 1
    d['demand'] = []
    d['history'].append({'staffId': s['id'], 'date': '2026-11-01', 'workedMinutes': 120})
    assert solve_multi(d, 5)['solverStatus'] == 'INFEASIBLE'
    d['history'].pop()
    assert solve_multi(d, 5)['validation']['status'] == 'VERIFIED'


def test_om02_half_slot_surplus_does_not_offset_later_shortage():
    d = multi_synthetic(2, tiny=True)
    d['patterns'] = [{'id': 'half', 'start': 540, 'end': 570, 'breakKind': 'auto'},
                     {'id': 'hour', 'start': 540, 'end': 600, 'breakKind': 'auto'}]
    for index, s in enumerate(d['staff']):
        minutes = 30 if index == 0 else 60
        s['contract']['end'] = 540 + minutes
        s['rules'][0].update(monthlyMin=minutes, monthlyMax=minutes)
        s['skills'][0]['capacity'] = 2000
        s['skills'][1]['level'] = 0
    d['tasks'][0]['minimumMinutes'] = 30
    d['demand'] = [{'date': '2026-10-01', 'start': 540, 'end': 600, 'taskId': 'phone',
                    'direct': 3000, 'calculated': None}]
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    assert r['validation']['generalShortage'] == 30000
    assert r['validation']['objective']['surplus'] == 30000
    assert [(v['start'], v['end'], v['capacity']) for v in r['validation']['intervals']] == [(540, 570, 4000), (570, 600, 2000)]


def test_om05_and_event_only_day_work_and_preferences_count_individually():
    d = multi_synthetic(1, tiny=True)
    d['staff'][0]['skills'] = []
    d['staff'][0]['preferences'] = [{'date': '2026-10-01', 'kind': 'work'},
                                    {'date': '2026-10-01', 'kind': 'pattern', 'patternId': 'short'},
                                    {'date': '2026-10-01', 'kind': 'window', 'start': 510, 'end': 690}]
    d['events'] = [{'id': 'training', 'date': '2026-10-01', 'start': 540, 'end': 660,
                    'kind': 'training', 'staffIds': [d['staff'][0]['id']]}]
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    assert r['validation']['objective']['missed'] == 0
    assert len(r['validation']['preferences']) == 3
    assert r['validation']['daily'][0]['workedMinutes'] == 120
    assert r['validation']['daily'][0]['processedMinutes'] == 0
    assert r['assignments'][0]['blocks'] == []


def test_om09_break_entirely_inside_relative_window():
    d = multi_synthetic(1, tiny=True)
    d['patterns'][0]['end'] = 1080
    d['staff'][0]['contract']['end'] = 1080
    d['staff'][0]['rules'][0].update(dailyMax=540, weeklyMax=540, monthlyMin=480, monthlyMax=480)
    d['breakRule'].update(threshold=360, requiredMinutes=60, afterStart=180, beforeEnd=240)
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    b = r['assignments'][0]['shift']['break']
    assert 720 <= b[0] < b[1] <= 840
    a = deepcopy(r['assignments'])
    a[0]['shift']['break'] = [810, 870]
    assert any(v.startswith('BREAK_RANGE:') for v in check_multi(d, a)['violations'])


@pytest.mark.parametrize('slot,priority,event_start,task_count', [
    (30, 'coverage', 570, 2), (60, 'coverage', 570, 2),
    (30, 'preference', 540, 2), (60, 'preference', 540, 2),
    (60, 'coverage', 570, 3),
])
@pytest.mark.parametrize('strategy', ['legacy-first-v1', 'balanced-coverage-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3'])
def test_shared_daily_state_matches_all_shifts_breaks_and_tasks(slot, priority, event_start, task_count, strategy):
    # Enumerate independently of the model's candidate generator. Includes a
    # leading interruption, an entire inactive slot, later-start shifts, and
    # different break placements. No candidates are sampled or discarded.
    d = multi_synthetic(1, slot, tiny=True)
    d['priority'] = priority
    d['patterns'] += [
        {'id': 'long', 'start': 540, 'end': 720, 'breakKind': 'auto'},
        {'id': 'late', 'start': 570, 'end': 720, 'breakKind': 'auto'},
    ]
    d['staff'][0]['rules'][0].update(monthlyMin=90, monthlyMax=180)
    d['staff'][0]['preferences'] = [
        {'date': '2026-10-01', 'kind': 'pattern', 'patternId': 'late'},
        {'date': '2026-10-01', 'kind': 'window', 'start': 570, 'end': 720},
    ]
    d['events'] = [{'id': 'meeting', 'date': '2026-10-01', 'start': event_start,
                    'end': event_start + 30, 'kind': 'meeting', 'staffIds': [d['staff'][0]['id']]}]
    d['transitions'].append({'fromTaskId': 'backoffice', 'toTaskId': 'phone', 'minutes': 7})
    if task_count == 3:
        d['tasks'].append({'id': 'management', 'kind': 'dedicated', 'minimumLevel': 1, 'minimumMinutes': 0})
        d['staff'][0]['skills'].append({'taskId': 'management', 'level': 1, 'capacity': 0})
    for task in d['tasks']:
        task['minimumMinutes'] = 30
    d['demand'] = [
        {'date': '2026-10-01', 'start': m, 'end': m + slot, 'taskId': task,
         'direct': 1000 if task == ('phone' if m < 600 else 'backoffice') else 0, 'calculated': None}
        for m in range(540, 720, slot) for task in ('phone', 'backoffice')
    ]
    vectors = []
    valid_patterns = set()
    for pattern in d['patterns']:
        rests = [None] + [[m, m + 30] for m in range(pattern['start'], pattern['end'], 30)
                          if m + 30 <= pattern['end']]
        for rest in rests:
            shift = {'patternId': pattern['id'], 'start': pattern['start'], 'end': pattern['end'],
                     'breakKind': 'auto', 'break': rest,
                     'workedMinutes': pattern['end'] - pattern['start'] - (30 if rest else 0), 'cancelled': []}
            occupied = set(range(pattern['start'], pattern['end']))
            if rest:
                occupied -= set(range(*rest))
            occupied -= set(range(event_start, event_start + 30))
            starts = sorted({m - m % slot for m in occupied})
            for values in product([t['id'] for t in d['tasks']], repeat=len(starts)):
                a = assignments(d, [block(m, m + slot, task) for m, task in zip(starts, values)], shift)
                report = check_multi(d, a)
                if report['status'] == 'VERIFIED':
                    vectors.append(report['objectiveVector'])
                    valid_patterns.add(pattern['id'])
    result = solve_multi(d, 5, hint_strategy=strategy)
    assert len(valid_patterns) >= (2 if event_start == 570 else 1)
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['objectiveVector'] == min(vectors)
    assert all(stage['value'] == stage['finalValue'] for stage in result['stages'])


def test_shared_state_first_task_after_leading_inactive_candidate_slots_has_no_preparation():
    d = multi_synthetic(1, 30, tiny=True)
    d['patterns'].append({'id': 'late', 'start': 600, 'end': 720, 'breakKind': 'auto'})
    d['staff'][0]['preferences'] = [{'date': '2026-10-01', 'kind': 'pattern', 'patternId': 'late'}]
    d['priority'] = 'preference'
    d['transitions'].append({'fromTaskId': 'backoffice', 'toTaskId': 'phone', 'minutes': 30})
    d['demand'] = [{'date': '2026-10-01', 'start': m, 'end': m + 30, 'taskId': 'backoffice',
                    'direct': 1000, 'calculated': None} for m in range(600, 720, 30)]
    r = solve_multi(d, 5)
    assert r['validation']['status'] == 'VERIFIED'
    assert r['assignments'][0]['shift']['patternId'] == 'late'
    assert r['validation']['daily'][0]['preparationMinutes'] == 0
    assert r['validation']['generalShortage'] == 0
    assert [b['start'] for b in r['assignments'][0]['blocks']] == [600, 630, 660, 690]
