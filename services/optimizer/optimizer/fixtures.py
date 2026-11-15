from datetime import timedelta

from .contract import dates


def synthetic(count=2, slot_minutes=60):
    data = {'schemaVersion': 'single-task-v0', 'tenantId': 'fictional-company-a',
            'teamId': 'fictional-team-a', 'month': '2026-10', 'inputVersion': 1,
            'settingsVersion': 1, 'jobId': f'synthetic-{count}-{slot_minutes}', 'attempt': 1,
            'slotMinutes': slot_minutes, 'priority': 'coverage', 'weekStart': 0,
            'breakRule': {'basis': 'elapsed', 'threshold': 120, 'requiredMinutes': 30,
                          'afterStart': 30, 'beforeEnd': 30},
            'patterns': [{'id': 'short', 'start': 540, 'end': 660, 'breakKind': 'auto'},
                         {'id': 'long', 'start': 540, 'end': 720, 'breakKind': 'auto'}],
            'staff': [], 'demand': [], 'history': []}
    ds = dates(data)
    for i in range(count):
        sid = f'fictional-{i:03d}'
        data['staff'].append({'id': sid, 'capacity': 1000 if i % 2 else 500,
                             'contract': {'weekdays': [0, 1, 2, 3, 4], 'start': 540, 'end': 720},
                             'rules': [{'id': 'synthetic-company-rule-v1', 'dailyMax': 180,
                                        'weeklyMax': 750, 'monthlyMin': 120,
                                        'monthlyMax': 3300, 'minDays': 1, 'minOff': 8,
                                        'maxConsecutive': 5}], 'unavailable': [],
                             'preferences': [{'date': '2026-10-01', 'kind': 'off'}]})
        for n in range(1, 8):
            data['history'].append({'staffId': sid, 'date': (ds[0] - timedelta(days=n)).isoformat(), 'workedMinutes': 0})
    for d in ds:
        if d.weekday() < 5:
            for m in range(540, 720, slot_minutes):
                data['demand'].append({'date': d.isoformat(), 'start': m, 'end': m + slot_minutes,
                                       'direct': count * 500, 'calculated': count * 1000})
    return data


def multi_synthetic(count=2, slot_minutes=60, tiny=False):
    """Fictional multi-task settings; not the actual pilot company's contract."""
    data = synthetic(count, slot_minutes)
    data.update(schemaVersion='multi-task-v1', mode='draft', capacityScale=1000,
                tasks=[{'id': 'phone', 'kind': 'general', 'minimumLevel': 1, 'minimumMinutes': 60},
                       {'id': 'backoffice', 'kind': 'general', 'minimumLevel': 1, 'minimumMinutes': 60}],
                roles=[{'id': 'leader', 'allowedTasks': ['phone', 'backoffice']}],
                roleRequirements=[], transitions=[{'fromTaskId': 'phone', 'toTaskId': 'backoffice', 'minutes': 10}],
                events=[], locks=[], exceptions=[], published=[])
    for s in data['staff']:
        del s['capacity']
        s['skills'] = [{'taskId': t, 'level': 1, 'capacity': 1000} for t in ('phone', 'backoffice')]
        s['roleIds'] = ['leader']
    for d in data['demand']:
        d['taskId'] = 'phone'
    if tiny:
        data['patterns'] = [data['patterns'][0]]
        for s in data['staff']:
            s['unavailable'] = [{'date': d.isoformat(), 'start': 0, 'end': 1440} for d in dates(data)[1:]]
            s['rules'][0].update(monthlyMin=120, monthlyMax=120, minDays=1)
            s['preferences'] = []
        data['demand'] = [{'date': '2026-10-01', 'start': m, 'end': m + slot_minutes,
                           'direct': count * 1000, 'calculated': count * 2000,
                           'taskId': 'phone' if m < 600 else 'backoffice'}
                          for m in range(540, 660, slot_minutes)]
    return data
