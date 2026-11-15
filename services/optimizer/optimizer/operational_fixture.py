"""Reproducible fictional operations load and independent hand-written reference.

This is a benchmark, not the pilot's settings or a solver-generated oracle.
"""
from copy import deepcopy
from datetime import timedelta

from .contract import dates
from .fixtures import multi_synthetic


def operational_fixture(count=101, slot_minutes=60):
    if not 10 <= count <= 500:
        raise ValueError('OPERATIONAL_FIXTURE_STAFF_RANGE')
    data = multi_synthetic(count, slot_minutes)
    data['jobId'] = f'fictional-operational-{count}-{slot_minutes}-v1'
    data['tasks'].append({'id': 'supervision', 'kind': 'dedicated',
                          'minimumLevel': 1, 'minimumMinutes': 60})
    data['transitions'] = [{'fromTaskId': 'phone', 'toTaskId': 'backoffice', 'minutes': 10},
                           {'fromTaskId': 'backoffice', 'toTaskId': 'phone', 'minutes': 7}]
    data['demand'], data['roleRequirements'] = [], []
    data['events'], data['locks'], data['exceptions'] = [], [], []
    reference = []
    for i, staff in enumerate(data['staff']):
        sid = staff['id']
        staff['skills'].append({'taskId': 'supervision', 'level': 1, 'capacity': 0})
        staff['skills'][1]['capacity'] = 800
        staff['roleIds'] = ['leader'] if i % 5 == 0 else []
        staff['rules'] = [dict(staff['rules'][0], id=source, monthlyMin=2400)
                          for source in ('fictional-company-v1', 'fictional-employment-v1',
                                         'fictional-person-v1')]
        if i % 17 == 0:
            staff['unavailable'] = [{'date': '2026-10-07', 'start': 0, 'end': 1440}]
        rest_start = 570 + (i % 4) * 30
        shift = {'patternId': 'long', 'start': 540, 'end': 720,
                 'breakKind': 'auto', 'break': [rest_start, rest_start + 30],
                 'workedMinutes': 150, 'cancelled': []}
        trained = i % 11 == 0
        if trained:
            data['events'].append({'id': f'fictional-training-{i}', 'date': '2026-10-01',
                                   'start': 540, 'end': 570, 'kind': 'training', 'staffIds': [sid]})
        task = ('supervision' if i % 10 == 9 else
                'backoffice' if i % 10 >= 5 else 'phone')
        for day in dates(data):
            key = day.isoformat()
            on = day.weekday() < 5 and not (i % 17 == 0 and day.day == 7)
            active = set(range(540, 720)) - set(range(rest_start, rest_start + 30)) if on else set()
            if trained and day.day == 1:
                active.difference_update(range(540, 570))
            switch = i % 10 == 8 and i % 4 >= 2 and not (trained and day.day == 1)
            blocks = [{'start': m, 'end': m + slot_minutes,
                       'taskId': ('phone' if m < 600 else 'backoffice') if switch else task,
                       'roleId': None}
                      for m in range(540, 720, slot_minutes) if active & set(range(m, m + slot_minutes))]
            roles = []
            if staff['roleIds'] and task != 'supervision':
                # Split exact real processing ranges around rest and training.
                start = None
                for minute in range(540, 721):
                    if minute in active and start is None:
                        start = minute
                    if minute not in active and start is not None:
                        roles.append({'start': start, 'end': minute, 'roleId': 'leader'})
                        start = None
            reference.append({'staffId': sid, 'date': key,
                              'shift': deepcopy(shift) if on else None,
                              'blocks': blocks, 'roleIntervals': roles})
        if i % 20 == 0:
            lock_id = f'fictional-lock-{i}'
            data['locks'].append({'id': lock_id, 'staffId': sid, 'date': '2026-10-02',
                                  'parts': ['pattern', 'time', 'break'], 'shift': deepcopy(shift)})
            staff['unavailable'].append({'date': '2026-10-02', 'start': 540, 'end': 570})
            data['exceptions'].append({'id': f'fictional-exception-{i}', 'lockId': lock_id,
                                       'staffId': sid, 'date': '2026-10-02', 'start': 540,
                                       'end': 570, 'reason': '架空の承認済み固定例外'})
    # Nontrivial, independently defined demand. Both general tasks throughout
    # the whole month; no oracle assignments are passed to the solver.
    for day in dates(data):
        if day.weekday() >= 5:
            continue
        for m in range(540, 720, slot_minutes):
            for task, share in [('phone', 300), ('backoffice', 200)]:
                data['demand'].append({'date': day.isoformat(), 'start': m,
                                       'end': m + slot_minutes, 'taskId': task,
                                       'direct': count * share, 'calculated': count * 1000})
            for task, priority in [('phone', 'first'), ('backoffice', 'same')]:
                data['roleRequirements'].append({'id': f'fictional-{task}-{day.day}-{m}',
                    'date': day.isoformat(), 'start': m, 'end': m + slot_minutes,
                    'taskId': task, 'roleId': 'leader', 'minimum': 1,
                    'ratioNumerator': 1, 'ratioDenominator': 10, 'rounding': 'ceil', 'priority': priority})
    # The fixture has explicit prior-month history; no unknown day is made zero.
    data['history'] = [{'staffId': s['id'], 'date': (dates(data)[0] - timedelta(days=n)).isoformat(),
                        'workedMinutes': 0} for s in data['staff'] for n in range(1, 8)]
    return data, reference


def standard_scale_fixture(count=101, slot_minutes=30):
    """TS-PERF-02/04: five eligible tasks and ten distinct legal patterns.

    This changes fictional benchmark settings only. All staff can choose every
    task/pattern on ordinary days; hard week/month limits still apply jointly.
    """
    data, reference = operational_fixture(count, slot_minutes)
    data['jobId'] = f'fictional-standard5x10-{count}-{slot_minutes}-v1'
    data['patterns'] = [{'id': name, 'start': start, 'end': end, 'breakKind': 'auto'}
        for name, start, end in [('short',540,660), ('long',540,720),
            ('early-90',540,630), ('early-150',540,690), ('mid-120',570,690),
            ('mid-180',570,750), ('late-180',600,780), ('early-240',540,780),
            ('early-300',540,840), ('late-270',600,870)]]
    for task in ('chat', 'email'):
        data['tasks'].append({'id': task, 'kind': 'general', 'minimumLevel': 1,
                              'minimumMinutes': 60})
        data['roles'][0]['allowedTasks'].append(task)
    for staff in data['staff']:
        staff['contract']['end'] = 870
        for rule in staff['rules']:
            rule['dailyMax'] = 300
        staff['skills'] += [{'taskId':'chat','level':1,'capacity':800},
                            {'taskId':'email','level':1,'capacity':1000}]
    # Keep explicit known feasible shifts, rests, events and exceptions. Assign
    # homogeneous general-duty rows across all four task groups; retain the
    # handwritten directional phone/backoffice switch rows from the base case.
    task_for_staff = {s['id']: ('phone' if i % 10 < 4 else 'backoffice' if i % 10 < 6
                      else 'chat' if i % 10 < 8 else 'email')
                      for i,s in enumerate(data['staff'])}
    for row in reference:
        used = {b['taskId'] for b in row['blocks']}
        if len(used) == 1 and used <= {'phone', 'backoffice'}:
            for block in row['blocks']:
                block['taskId'] = task_for_staff[row['staffId']]
    data['demand'], data['roleRequirements'] = [], []
    for day in dates(data):
        if day.weekday() >= 5:
            continue
        for start in range(540,720,slot_minutes):
            for task, share, priority in [('phone',180,'first'),('backoffice',120,'same'),
                                          ('chat',100,'first'),('email',100,'same')]:
                data['demand'].append({'date':day.isoformat(),'start':start,'end':start+slot_minutes,
                    'taskId':task,'direct':count*share,'calculated':count*1000})
                data['roleRequirements'].append({'id':f'fictional-{task}-{day.day}-{start}',
                    'date':day.isoformat(),'start':start,'end':start+slot_minutes,'taskId':task,
                    'roleId':'leader','minimum':1,'ratioNumerator':1,'ratioDenominator':10,
                    'rounding':'ceil','priority':priority})
    return data, reference
