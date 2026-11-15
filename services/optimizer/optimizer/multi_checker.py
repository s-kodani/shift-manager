"""Independent 1-minute reference checker; imports no solver/candidate implementation."""
from collections import defaultdict
from datetime import timedelta

from jsonschema import ValidationError

from .contract import dates, required_history
from .multi_contract import OUTPUT_VALIDATOR, integer_representation, validate_multi


def check_multi(data, assignments):
    validate_multi(data, allow_manual_exceptions=True)
    try:
        OUTPUT_VALIDATOR.validate(assignments)
        integer_representation(assignments)
    except (ValidationError, ValueError):
        return {'status': 'INVALID', 'scope': 'multi-task-v1', 'violations': ['OUTPUT_SHAPE']}
    ds = dates(data)
    staff = {s['id']: s for s in data['staff']}
    tasks = {t['id']: t for t in data['tasks']}
    roles = {r['id']: r for r in data['roles']}
    patterns = {p['id']: p for p in data['patterns']}
    keys = [(a['staffId'], a['date']) for a in assignments]
    if len(keys) != len(set(keys)) or set(keys) != {(sid, d.isoformat()) for sid in staff for d in ds}:
        return {'status': 'INVALID', 'scope': 'multi-task-v1', 'violations': ['ASSIGNMENT_KEYS']}
    published = {(x['staffId'], x['date']): x['shift'] for x in data['published']}
    transitions = {(x['fromTaskId'], x['toTaskId']): x['minutes'] for x in data['transitions']}
    errors, preferences, summaries = [], [], []
    capacity, denominator, role_count = defaultdict(int), defaultdict(int), defaultdict(int)
    hours = {}
    day_lookup = {d.isoformat(): d for d in ds}
    for a in assignments:
        sid, day, shift, blocks = a['staffId'], a['date'], a['shift'], a['blocks']
        s = staff[sid]
        skills = {x['taskId']: x for x in s['skills']}
        tag = f'{sid}:{day}'
        relevant_events = [e for e in data['events'] if e['date'] == day and sid in e['staffIds']]
        relevant_locks = [x for x in data['locks'] if x['date'] == day and x['staffId'] == sid]
        for lock in relevant_locks:
            locked = lock['shift']
            if (locked is None) != (shift is None):
                errors.append(f'LOCK:{tag}:{lock["id"]}')
            elif shift:
                fields = []
                for part in lock['parts']:
                    fields += {'pattern': ['patternId'], 'time': ['start', 'end'],
                               'break': ['break', 'breakKind']}[part]
                if any(shift[k] != locked[k] for k in fields):
                    errors.append(f'LOCK:{tag}:{lock["id"]}')
        if data['mode'] == 'reallocation':
            base = published[sid, day]
            if (base is None) != (shift is None) or (shift and any(
                shift[k] != base[k] for k in ('patternId', 'start', 'end', 'breakKind', 'break', 'cancelled')
            )):
                errors.append(f'PUBLISHED_MAINTENANCE:{tag}')
        elif shift and shift['cancelled']:
            errors.append(f'DRAFT_CANCELLATION:{tag}')
        attendance, remaining, rest, work = set(), set(), set(), set()
        if shift:
            start, end = shift['start'], shift['end']
            p = patterns.get(shift['patternId'])
            if start >= end or p is None or any(shift[k] != p[k] for k in ('start', 'end', 'breakKind')):
                errors.append(f'PATTERN:{tag}')
            attendance = set(range(start, end))
            cancelled = set()
            for left, right in shift['cancelled']:
                if left >= right or not set(range(left, right)) <= attendance:
                    errors.append(f'CANCELLATION_INTERVAL:{tag}')
                cancelled.update(range(left, right))
            remaining = attendance - cancelled
            b = shift['break']
            raw_rest = set(range(*b)) if b else set()
            if b and (b[0] >= b[1] or not raw_rest <= attendance):
                errors.append(f'BREAK_INTERVAL:{tag}')
            if p and p['breakKind'] == 'fixed' and b != p['fixedBreak']:
                errors.append(f'FIXED_BREAK:{tag}')
            rest = raw_rest & remaining
            work = remaining - raw_rest
            if shift['workedMinutes'] != len(work):
                errors.append(f'WORKED_MINUTES:{tag}')
            rule = data['breakRule']
            basis = len(work) if rule['basis'] == 'worked' else len(remaining)
            required = rule['requiredMinutes'] if basis > rule['threshold'] else 0
            if len(rest) < required or (shift['breakKind'] == 'auto' and len(rest) != required):
                errors.append(f'BREAK_QUANTITY:{tag}')
            if b and (b[0] < start + rule['afterStart'] or b[1] > end - rule['beforeEnd']):
                errors.append(f'BREAK_RANGE:{tag}')
            if remaining and (day_lookup[day].weekday() not in s['contract']['weekdays'] or
                              not remaining <= set(range(s['contract']['start'], s['contract']['end']))):
                errors.append(f'CONTRACT:{tag}')
            permitted = set()
            for exception in data['exceptions']:
                if exception['staffId'] != sid or exception['date'] != day:
                    continue
                if exception['lockId'] is None:
                    interval = set(range(exception['start'], exception['end']))
                    if not interval <= remaining:
                        errors.append(f'MANUAL_EXCEPTION_PLACEMENT:{tag}:{exception["id"]}')
                    else:
                        permitted.update(interval)
                    continue
                lock = next(x for x in relevant_locks if x['id'] == exception['lockId'])
                if all(shift[k] == lock['shift'][k] for k in ('patternId', 'start', 'end', 'breakKind', 'break')):
                    permitted.update(range(exception['start'], exception['end']))
            for u in s['unavailable']:
                if u['date'] == day and (remaining & set(range(u['start'], u['end']))) - permitted:
                    errors.append(f'UNAVAILABLE:{tag}')
        else:
            for exception in data['exceptions']:
                if exception['lockId'] is None and exception['staffId'] == sid and exception['date'] == day:
                    errors.append(f'MANUAL_EXCEPTION_PLACEMENT:{tag}:{exception["id"]}')
        hours[sid, day] = len(work)
        event_minutes = set()
        for e in relevant_events:
            occupied = set(range(e['start'], e['end']))
            if not occupied <= work:
                errors.append(f'EVENT_FULL_ATTENDANCE:{tag}:{e["id"]}')
            if occupied & event_minutes:
                errors.append(f'EVENT_OVERLAP:{tag}:{e["id"]}')
            event_minutes |= occupied
        active = work - event_minutes
        logical = {}
        for b in blocks:
            if b['end'] - b['start'] != data['slotMinutes'] or b['start'] % data['slotMinutes']:
                errors.append(f'TASK_SLOT:{tag}')
            if not active & set(range(b['start'], b['end'])):
                errors.append(f'PHANTOM_TASK:{tag}')
            skill = skills.get(b['taskId'])
            task = tasks.get(b['taskId'])
            if not task or not skill or skill['level'] < task['minimumLevel']:
                errors.append(f'TASK_ELIGIBILITY:{tag}:{b["taskId"]}')
            role = roles.get(b['roleId'])
            if b['roleId'] is not None and (not role or b['roleId'] not in s['roleIds'] or b['taskId'] not in role['allowedTasks']):
                errors.append(f'ROLE_ELIGIBILITY:{tag}')
            for m in range(b['start'], b['end']):
                if m in logical:
                    errors.append(f'TASK_OVERLAP:{tag}')
                logical[m] = (b['taskId'], b['roleId'])
        previous, run, runs, preparation, processed = None, None, [], set(), 0
        role_minutes = {}
        for r in a.get('roleIntervals', []):
            if r['start'] >= r['end']:
                errors.append(f'ROLE_INTERVAL:{tag}')
            for m in range(r['start'], r['end']):
                if m in role_minutes:
                    errors.append(f'ROLE_OVERLAP:{tag}')
                role_minutes[m] = r['roleId']
        for m in sorted(active):
            current = logical.get(m)
            if current is None:
                errors.append(f'WAITING:{tag}')
                continue
            task_id, role_id = current
            if m in role_minutes:
                if role_id is not None:
                    errors.append(f'DUPLICATE_ROLE_SOURCE:{tag}')
                role_id = role_minutes[m]
                if role_id not in s['roleIds'] or role_id not in roles or task_id not in roles[role_id]['allowedTasks']:
                    errors.append(f'ROLE_ELIGIBILITY:{tag}')
            task = tasks.get(task_id)
            if task is None or task_id not in skills:
                continue
            if task_id != previous:
                length = transitions.get((previous, task_id), 0) if previous is not None else 0
                if previous is not None and m % data['slotMinutes']:
                    errors.append(f'TRANSITION_NOT_AT_SLOT_START:{tag}')
                prep = set(range(m, m + length))
                if not prep <= active or any(logical.get(t, (None,))[0] != task_id for t in prep):
                    errors.append(f'PREPARATION_INTERRUPTED:{tag}')
                preparation |= prep
                run = [task_id, 0]
                runs.append(run)
                previous = task_id
            run[1] += 1
            if m in preparation or task['kind'] != 'general':
                continue
            processed += 1
            capacity[day, m, task_id] += skills[task_id]['capacity']
            # Role qualifications alone do not exclude a general operator.
            if role_id is None:
                denominator[day, m, task_id] += 1
                denominator[day, m, None] += 1
            else:
                role_count[day, m, task_id, role_id] += 1
                role_count[day, m, None, role_id] += 1
        for task_id, length in runs:
            if length < tasks[task_id]['minimumMinutes']:
                errors.append(f'MINIMUM_RUN:{tag}:{task_id}')
        if any(m not in active or m in preparation or not tasks.get(logical.get(m, (None,))[0], {}).get('kind') == 'general'
               for m in role_minutes):
            errors.append(f'ROLE_OUTSIDE_PROCESSING:{tag}')
        for p in s['preferences']:
            if p['date'] != day:
                continue
            ok = False
            if p['kind'] == 'work':
                ok = bool(work)
            elif p['kind'] == 'off':
                ok = not work
            elif p['kind'] == 'pattern':
                ok = bool(work) and shift['patternId'] == p['patternId'] and remaining == attendance
            elif p['kind'] == 'window':
                ok = bool(work) and p['start'] <= min(remaining) and max(remaining) + 1 <= p['end']
            preferences.append({'staffId': sid, 'date': day, 'kind': p['kind'], 'fulfilled': ok})
        summaries.append({'staffId': sid, 'date': day, 'workedMinutes': len(work),
                          'preparationMinutes': len(preparation & active), 'processedMinutes': processed,
                          'eventMinutes': len(event_minutes & work), 'breakMinutes': len(rest),
                          'cancelledMinutes': len(attendance - remaining), 'runs': runs})
    history = {(h['staffId'], h['date']): h['workedMinutes'] for h in data['history']}
    missing = []
    for sid, s in staff.items():
        missing += [f'{sid}:{d.isoformat()}' for d in required_history(data, s)
                    if (sid, d.isoformat()) not in history]
        for r in s['rules']:
            month = sum(hours[sid, d.isoformat()] for d in ds)
            work_days = sum(hours[sid, d.isoformat()] > 0 for d in ds)
            if not r['monthlyMin'] <= month <= r['monthlyMax']:
                errors.append(f'MONTHLY_HOURS:{sid}:{r["id"]}')
            if work_days < r['minDays'] or len(ds) - work_days < r['minOff']:
                errors.append(f'MONTHLY_DAYS:{sid}:{r["id"]}')
            weeks = defaultdict(int)
            for d in ds:
                if hours[sid, d.isoformat()] > r['dailyMax']:
                    errors.append(f'DAILY_HOURS:{sid}:{d}:{r["id"]}')
                week = d - timedelta(days=(d.weekday() - data['weekStart']) % 7)
                weeks[week] += hours[sid, d.isoformat()]
            for week, total in weeks.items():
                total += sum(history.get((sid, (week + timedelta(days=n)).isoformat()), 0)
                             for n in range(7) if week + timedelta(days=n) not in ds)
                if total > r['weeklyMax']:
                    errors.append(f'WEEKLY_HOURS:{sid}:{week}:{r["id"]}')
            ends = ds + [ds[-1] + timedelta(days=n) for n in range(1, r['maxConsecutive'] + 1)
                         if (sid, (ds[-1] + timedelta(days=n)).isoformat()) in history]
            for end in ends:
                window = [end - timedelta(days=n) for n in range(r['maxConsecutive'] + 1)]
                if sum(hours.get((sid, d.isoformat()), history.get((sid, d.isoformat()), 0)) > 0 for d in window) > r['maxConsecutive']:
                    errors.append(f'CONSECUTIVE:{sid}:{end}:{r["id"]}')
    demand = {}
    for d in data['demand']:
        need = d['direct'] if d['direct'] is not None else d['calculated']
        for m in range(d['start'], d['end']):
            demand[d['date'], m, d['taskId']] = need
    shortage = surplus = role_first = role_same = 0
    deficit_intervals = []
    for key in set(capacity) | set(demand):
        c, n = capacity.get(key, 0), demand.get(key, 0)
        shortage += max(0, n - c)
        surplus += max(0, c - n)
    role_details = []
    for r in data['roleRequirements']:
        short_minutes, needed_peak, intervals = 0, 0, []
        for m in range(r['start'], r['end']):
            n = denominator[r['date'], m, r['taskId']]
            numerator = n * r['ratioNumerator']
            ratio = numerator // r['ratioDenominator']
            if r['rounding'] == 'ceil' and numerator % r['ratioDenominator']:
                ratio += 1
            required = max(r['minimum'], ratio)
            actual = role_count[r['date'], m, r['taskId'], r['roleId']]
            state = (n, required, actual)
            if intervals and intervals[-1]['end'] == m and (
                intervals[-1]['ordinaryPeople'], intervals[-1]['required'], intervals[-1]['actual']
            ) == state:
                intervals[-1]['end'] = m + 1
            else:
                intervals.append({'start': m, 'end': m + 1, 'ordinaryPeople': n,
                                  'required': required, 'actual': actual,
                                  'shortage': max(0, required - actual)})
            short_minutes += max(0, required - actual)
            needed_peak = max(needed_peak, required)
        value = short_minutes * data['capacityScale']
        if r['priority'] == 'first':
            role_first += value
        else:
            role_same += value
        role_details.append({'id': r['id'], 'shortagePersonMinutes': short_minutes,
                             'requiredPeak': needed_peak, 'priority': r['priority'],
                             'intervals': intervals})
    # Compact interval metrics; only identical neighboring minute states merge.
    grouped = defaultdict(list)
    for day, minute, task_id in set(capacity) | set(demand):
        grouped[day, task_id].append(minute)
    for (day, task_id), minutes in sorted(grouped.items()):
        relevant = sorted(minutes)
        current = None
        for m in relevant:
            c, n = capacity.get((day, m, task_id), 0), demand.get((day, m, task_id), 0)
            ordinary = denominator[day, m, task_id]
            assigned_roles = {role_id: role_count[day, m, task_id, role_id] for role_id in roles}
            people = ordinary + sum(assigned_roles.values())
            state = (n, c, ordinary, assigned_roles)
            if current and current['end'] == m and (
                current['required'], current['capacity'], current['ordinaryPeople'], current['rolePeople']
            ) == state:
                current['end'] = m + 1
            else:
                current = {'date': day, 'taskId': task_id, 'start': m, 'end': m + 1,
                           'required': n, 'capacity': c, 'shortage': max(0, n - c),
                           'surplus': max(0, c - n), 'processingPeople': people,
                           'ordinaryPeople': ordinary, 'rolePeople': assigned_roles}
                deficit_intervals.append(current)
    missed = sum(not p['fulfilled'] for p in preferences)
    objective = {'roleFirst': role_first, 'combined': shortage + role_same,
                 'missed': missed, 'surplus': surplus}
    names = ['roleFirst', 'combined', 'missed', 'surplus']
    if data['priority'] == 'preference':
        names = ['missed', 'roleFirst', 'combined', 'surplus']
    if not any(r['priority'] == 'first' for r in data['roleRequirements']):
        names.remove('roleFirst')
    return {'status': 'INVALID' if errors else 'HISTORY_UNVERIFIED' if missing else 'VERIFIED',
            'scope': 'multi-task-v1', 'violations': sorted(set(errors)), 'missingHistory': missing,
            'objective': objective, 'objectiveOrder': names,
            'objectiveVector': [objective[n] for n in names],
            'generalShortage': shortage, 'roleSameShortage': role_same,
            'preferences': preferences, 'daily': summaries, 'intervals': deficit_intervals,
            'roleRequirements': role_details,
            'units': {'capacityScale': data['capacityScale'], 'coverage': 'scaled-person-minute',
                      'missed': 'preference-item'}}
