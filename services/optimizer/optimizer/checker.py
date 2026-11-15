"""Independent minute-set checker. Never imports the CP-SAT model/candidates."""
from datetime import timedelta

from .contract import dates, required_history, validate_input


def check(data, assignments):
    validate_input(data)
    ds = dates(data)
    patterns = {p['id']: p for p in data['patterns']}
    staff = {s['id']: s for s in data['staff']}
    expected = {(sid, d.isoformat()) for sid in staff for d in ds}
    actual = [(a['staffId'], a['date']) for a in assignments]
    violations = []
    if len(actual) != len(set(actual)) or set(actual) != expected:
        return {'status': 'INVALID', 'violations': ['ASSIGNMENT_KEYS']}
    lookup = {(a['staffId'], a['date']): a['shift'] for a in assignments}
    hours, daily_work = {}, {}
    capacity = {}
    unfulfilled = 0
    for (sid, day), shift in lookup.items():
        s = staff[sid]
        work = set()
        if shift:
            p = patterns.get(shift.get('patternId'))
            if not p or any(shift.get(k) != p[k] for k in ('start', 'end', 'breakKind')):
                violations.append(f'PATTERN:{sid}:{day}')
                continue
            start, end = shift['start'], shift['end']
            b = shift.get('break')
            attendance = set(range(start, end))
            rest = set(range(*b)) if b else set()
            if b and (not all(type(x) is int and x % 30 == 0 for x in b) or b[0] >= b[1] or not rest <= attendance):
                violations.append(f'BREAK_INTERVAL:{sid}:{day}')
            if p['breakKind'] == 'fixed' and b != p['fixedBreak']:
                violations.append(f'FIXED_BREAK:{sid}:{day}')
            work = attendance - rest
            if shift.get('workedMinutes') != len(work):
                violations.append(f'WORKED_MINUTES:{sid}:{day}')
            rule = data['breakRule']
            basis = len(work) if rule['basis'] == 'worked' else len(attendance)
            needed = rule['requiredMinutes'] if basis > rule['threshold'] else 0
            if len(rest) < needed or (p['breakKind'] == 'auto' and len(rest) != needed):
                violations.append(f'BREAK_QUANTITY:{sid}:{day}')
            if b and (b[0] < start + rule['afterStart'] or b[1] > end - rule['beforeEnd']):
                violations.append(f'BREAK_RANGE:{sid}:{day}')
            d = next(d for d in ds if d.isoformat() == day)
            if d.weekday() not in s['contract']['weekdays'] or not set(range(start, end)) <= set(range(s['contract']['start'], s['contract']['end'])):
                violations.append(f'CONTRACT:{sid}:{day}')
            for u in s['unavailable']:
                if u['date'] == day and attendance & set(range(u['start'], u['end'])):
                    violations.append(f'UNAVAILABLE:{sid}:{day}')
            for m in work:
                capacity[day, m] = capacity.get((day, m), 0) + s['capacity']
        hours[sid, day] = len(work)
        daily_work[sid, day] = int(bool(work))
        for p in s['preferences']:
            if p['date'] != day:
                continue
            fulfilled = False
            if p['kind'] == 'work':
                fulfilled = bool(work)
            elif p['kind'] == 'off':
                fulfilled = not work
            elif p['kind'] == 'pattern':
                fulfilled = bool(work) and shift['patternId'] == p['patternId']
            elif p['kind'] == 'window':
                fulfilled = bool(work) and p['start'] <= shift['start'] and shift['end'] <= p['end']
            unfulfilled += int(not fulfilled)
    history = {(h['staffId'], h['date']): h['workedMinutes'] for h in data['history']}
    missing = []
    for sid, s in staff.items():
        missing.extend(f'{sid}:{d}' for d in required_history(data, s) if (sid, d.isoformat()) not in history)
        for r in s['rules']:
            month_hours = sum(hours.get((sid, d.isoformat()), 0) for d in ds)
            days_worked = sum(daily_work.get((sid, d.isoformat()), 0) for d in ds)
            if not r['monthlyMin'] <= month_hours <= r['monthlyMax']:
                violations.append(f'MONTHLY_HOURS:{sid}:{r["id"]}')
            if days_worked < r['minDays'] or len(ds) - days_worked < r['minOff']:
                violations.append(f'MONTHLY_DAYS:{sid}:{r["id"]}')
            weeks = {}
            for d in ds:
                value = hours.get((sid, d.isoformat()), 0)
                if value > r['dailyMax']:
                    violations.append(f'DAILY_HOURS:{sid}:{d}:{r["id"]}')
                key = d - timedelta(days=(d.weekday() - data['weekStart']) % 7)
                weeks[key] = weeks.get(key, 0) + value
            for week in weeks:
                for n in range(7):
                    d = week + timedelta(days=n)
                    if d not in ds:
                        weeks[week] += history.get((sid, d.isoformat()), 0)
                if weeks[week] > r['weeklyMax']:
                    violations.append(f'WEEKLY_HOURS:{sid}:{week}:{r["id"]}')
            for end in ds:
                count = sum(int(hours.get((sid, d.isoformat()), history.get((sid, d.isoformat()), 0)) > 0)
                            for d in [end - timedelta(days=n) for n in range(r['maxConsecutive'] + 1)])
                if count > r['maxConsecutive']:
                    violations.append(f'CONSECUTIVE:{sid}:{end}:{r["id"]}')
    demand = {}
    for d in data['demand']:
        need = d['direct'] if d['direct'] is not None else d['calculated']
        for m in range(d['start'], d['end']):
            demand[d['date'], m] = need
    shortage = surplus = 0
    for key in set(capacity) | set(demand):
        c, n = capacity.get(key, 0), demand.get(key, 0)
        shortage += max(0, n - c)
        surplus += max(0, c - n)
    return {'status': 'INVALID' if violations else 'HISTORY_UNVERIFIED' if missing else 'VERIFIED',
            'scope': 'single-task-v0', 'violations': violations, 'missingHistory': missing,
            'objective': {'shortage': shortage, 'missed': unfulfilled, 'surplus': surplus},
            'units': {'shortage': 'scaled-person-minute (S=1000, experimental)',
                      'missed': 'preference-item', 'surplus': 'scaled-person-minute (S=1000, experimental)'}}


def cancellation_evaluation(start, end, rest, cancelled, break_kind, rule):
    """Q128/Q130/Q131: set subtraction prevents double deduction."""
    attendance = set(range(start, end))
    cancelled_minutes = set().union(*(set(range(a, b)) for a, b in cancelled))
    break_minutes = set().union(*(set(range(a, b)) for a, b in rest))
    remaining = attendance - cancelled_minutes
    worked = remaining - break_minutes
    rest_left = remaining & break_minutes
    basis = len(worked) if rule['basis'] == 'worked' else len(remaining)
    required = rule['requiredMinutes'] if basis > rule['threshold'] else 0
    valid = len(rest_left) == required if break_kind == 'auto' else len(rest_left) >= required
    return {'worked': len(worked), 'attendance': len(remaining), 'rest': len(rest_left),
            'required': required, 'breakValid': valid, 'workDay': bool(worked)}


def task_timeline(start, end, blocks, interruptions, preparation, minimum, slot_minutes):
    """Minute reference for hand-made task cases, separate from single-task model.

    blocks: (start,end,task); interruptions: (start,end).
    Enforces no waiting, continuous transition, first task free, run through events.
    """
    if any(v < 0 or v > slot_minutes for v in preparation.values()):
        raise ValueError('PREPARATION_EXCEEDS_SLOT')
    interrupted = set().union(*(set(range(a, b)) for a, b in interruptions))
    timeline, processed, prep, errors = {}, {}, set(), []
    for a, b, task in blocks:
        for m in range(a, b):
            if m in timeline or not start <= m < end:
                errors.append('OVERLAP_OR_OUTSIDE')
            timeline[m] = task
    previous = None
    runs = []
    run = None
    for m in range(start, end):
        if m in interrupted:
            continue
        task = timeline.get(m)
        if task is None:
            errors.append('WAITING')
            continue
        if task != previous:
            run = [task, 0]
            runs.append(run)
            minutes = preparation.get((previous, task), 0) if previous is not None else 0
            interval = set(range(m, m + minutes))
            if (previous is not None and m % slot_minutes) or interval & interrupted or m + minutes > end or any(timeline.get(t) != task for t in interval):
                errors.append('PREPARATION_INTERRUPTED')
            prep |= interval
            previous = task
        run[1] += 1
        if m not in prep:
            processed[task] = processed.get(task, 0) + 1
    if any(length < minimum.get(task, 0) for task, length in runs):
        errors.append('MINIMUM_RUN')
    return {'processed': processed, 'preparation': len(prep), 'runs': runs, 'errors': sorted(set(errors))}
