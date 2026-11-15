"""Experimental interval-aware starting values; never hard constraints or an oracle.

Every staff-day still uses one constant logical task. Role reservation anticipates
future demand but is only a heuristic. CP-SAT and the independent checker alone
evaluate the actual denominator, role count, constraints and objective values.
"""


def interval_hints(data, candidates, active, choices, role_choices, xs, segments, check_budget,
                   *, prefer_qualified_role=False, covered_off_hints=False, calendar_roster=False):
    hints, supplied, denominator, served = {}, {}, {}, {}
    staff = {s['id']: s for s in data['staff']}
    order = {s['id']: i for i, s in enumerate(data['staff'])}
    tasks = {t['id']: t for t in data['tasks']}
    demand = {(d['date'], d['start'], d['taskId']):
              d['direct'] if d['direct'] is not None else d['calculated'] for d in data['demand']}
    maximum_capacity = {task: max((skill['capacity'] for s in data['staff'] for skill in s['skills']
                                  if skill['taskId'] == task and skill['level'] >= tasks[task]['minimumLevel']),
                                 default=0) for task in tasks}
    requirements = {}
    for r in data['roleRequirements']:
        requirements.setdefault(r['date'], []).append(r)

    remaining_minutes, remaining_days, selected_daily = {}, {}, {}
    roster = {}
    if calendar_roster:
        from .calendar_hint import calendar_hints
        roster = calendar_hints(data, candidates, active, check_budget)
    if covered_off_hints:
        for (sid, _day), options in candidates.items():
            check_budget()
            maximum = max((c['workedMinutes'] if c else 0 for c in options), default=0)
            if (sid, _day) in roster:
                chosen = options[roster[sid, _day]]
                maximum = chosen['workedMinutes'] if chosen else 0
            remaining_minutes[sid] = remaining_minutes.get(sid, 0) + maximum
            remaining_days[sid] = remaining_days.get(sid, 0) + int(maximum > 0)

    def add(var, value):
        if var is None:
            return  # Implicit no-role choice; actual role Booleans determine it.
        index = var.index
        hints[index if index >= 0 else -index - 1] = value if index >= 0 else 1 - value

    def rounded(numerator, divisor, rounding):
        return (numerator + (divisor - 1 if rounding == 'ceil' else 0)) // divisor

    def reservation(r, day, minute):
        # Anticipate general processing headcount using the best eligible
        # capacity. This provisional target intentionally does not substitute
        # for the model's actual role-excluding denominator.
        scope = [r['taskId']] if r['taskId'] is not None else [t for t in tasks if tasks[t]['kind'] == 'general']
        people = sum((demand.get((day, minute - minute % data['slotMinutes'], t), 0)
                      + maximum_capacity[t] - 1) // maximum_capacity[t]
                     for t in scope if maximum_capacity[t])
        return max(r['minimum'], rounded(people * r['ratioNumerator'], r['ratioDenominator'], r['rounding']))

    def covered_after_removal(day, sid, task, available, selected_roles):
        skills = {x['taskId']: x for x in staff[sid]['skills']}
        for a, b in segments[day]:
            check_budget()
            processing = task is not None and tasks[task]['kind'] == 'general' and a in available
            for name, settings in tasks.items():
                if settings['kind'] != 'general':
                    continue
                after = supplied.get((day, a, name), 0) - (
                    skills[task]['capacity'] if processing and name == task else 0)
                if after < demand.get((day, a - a % data['slotMinutes'], name), 0):
                    return False
            role = selected_roles.get((a, b)) if processing else None
            for r in requirements.get(day, []):
                if r['start'] <= a < r['end']:
                    affected = processing and r['taskId'] in (None, task)
                    n = denominator.get((day, a, r['taskId']), 0) - int(affected and role is None)
                    count = served.get((day, a, r['taskId'], r['roleId']), 0) - int(
                        affected and role == r['roleId'])
                    need = max(r['minimum'], rounded(n * r['ratioNumerator'],
                                                     r['ratioDenominator'], r['rounding']))
                    if count < need:
                        return False
        return True

    keys = sorted(candidates, key=lambda k: (k[1], -len(staff[k[0]]['roleIds']), order[k[0]]))
    for key in keys:
        check_budget()
        sid, day = key
        options = candidates[key]
        maximum = max((c['workedMinutes'] if c else 0 for c in options), default=0)
        longest = [i for i, c in enumerate(options) if (c['workedMinutes'] if c else 0) == maximum]
        selected = longest[order[sid] % len(longest)] if longest else 0
        selected = roster.get(key, selected)
        for i, x in enumerate(xs[key]):
            add(x, int(i == selected))
        available = active.get((key, selected), set())
        intervals = [(a, b) for a, b in segments[day] if a in available]
        eligible = next(iter(choices[key].values()), {})
        skills = {s['taskId']: s for s in staff[sid]['skills']}
        today = requirements.get(day, [])

        def relevant(a, task):
            return [r for r in today if r['start'] <= a < r['end'] and r['taskId'] in (None, task)]

        def role_for(a, b, task):
            variables = role_choices.get(key, {}).get((a, b, task), {})
            def score(role):
                first, same = 0, 0
                for r in relevant(a, task):
                    if r['roleId'] != role:
                        continue
                    target = reservation(r, day, a)
                    count = served.get((day, a, r['taskId'], role), 0)
                    benefit = int(count < target)
                    if r['priority'] == 'first':
                        first += benefit
                    else:
                        same += benefit
                # Keeping an eligible role on an otherwise equal score avoids
                # increasing the role-excluding denominator for later workers.
                # This is only a starting value, never a role requirement/bound.
                return first, same, int(prefer_qualified_role and role is not None)
            return max(variables, key=score) if variables else None

        def task_score(task):
            first, general, same, extra = 0, 0, 0, 0
            capacity = skills[task]['capacity'] if tasks[task]['kind'] == 'general' else 0
            for a, b in intervals:
                minutes = b - a
                need = demand.get((day, a - a % data['slotMinutes'], task), 0)
                residual = need - supplied.get((day, a, task), 0)
                general += min(max(residual, 0), capacity) * minutes
                extra += max(capacity - max(residual, 0), 0) * minutes
                if tasks[task]['kind'] != 'general':
                    continue
                role = role_for(a, b, task)
                for r in relevant(a, task):
                    scope = day, a, r['taskId']
                    n = denominator.get(scope, 0)
                    count = served.get((*scope, r['roleId']), 0)
                    before = max(r['minimum'], rounded(n * r['ratioNumerator'], r['ratioDenominator'], r['rounding']))
                    after_n = n + int(role is None)
                    after = max(r['minimum'], rounded(after_n * r['ratioNumerator'], r['ratioDenominator'], r['rounding']))
                    delta = max(before - count, 0) - max(after - count - int(role == r['roleId']), 0)
                    anticipated = int(role == r['roleId'] and count < reservation(r, day, a))
                    benefit = (delta + anticipated) * minutes * data['capacityScale']
                    if r['priority'] == 'first':
                        first += benefit
                    else:
                        same += benefit
            return first, general + same, -extra

        task = max(eligible, key=task_score) if eligible else None
        for values in choices[key].values():
            for name, z in values.items():
                add(z, int(name == task))
        selected_roles = {(a, b): role_for(a, b, task) for a, b in intervals} if task is not None else {}
        for (a, b, name), variables in role_choices.get(key, {}).items():
            processing = a in available and name == task
            role = selected_roles.get((a, b))
            for value, z in variables.items():
                add(z, int(processing and value == role))
        if covered_off_hints:
            selected_daily[key] = (selected, task, selected_roles)
        if task is None or tasks[task]['kind'] != 'general':
            continue
        for a, b in intervals:
            k = day, a, task
            supplied[k] = supplied.get(k, 0) + skills[task]['capacity']
            role = selected_roles[a, b]
            for scope in (task, None):
                if role is None:
                    k = day, a, scope
                    denominator[k] = denominator.get(k, 0) + 1
                else:
                    k = day, a, scope, role
                    served[k] = served.get(k, 0) + 1
    if covered_off_hints:
        # Complete the ordinary whole-day starting point first. Later general
        # workers may increase the denominator; an early reservation is not
        # proof that an earlier qualified worker can safely take the day off.
        for key in keys:
            check_budget()
            sid, day = key
            selected, task, selected_roles = selected_daily[key]
            options = candidates[key]
            if not options:
                continue  # Let the unmodified full model prove infeasibility.
            chosen = options[selected]
            maximum = chosen['workedMinutes'] if chosen else 0
            preferences = [p for p in staff[sid]['preferences'] if p['date'] == day]
            if not (maximum > 0 and None in options and len(preferences) == 1 and
                    preferences[0]['kind'] == 'off' and
                    all(remaining_minutes[sid] - maximum >= r['monthlyMin'] and
                        remaining_days[sid] - 1 >= r['minDays'] for r in staff[sid]['rules'])):
                continue
            available = active.get((key, selected), set())
            if not covered_after_removal(day, sid, task, available, selected_roles):
                continue
            off = options.index(None)
            for i, x in enumerate(xs[key]):
                add(x, int(i == off))
            # Logical task choices stay one-hot even on an inactive day. They
            # produce no output block/supply without actual active minutes.
            # Zeroing all three choices would make a valid off seed infeasible.
            for variables in role_choices.get(key, {}).values():
                for z in variables.values():
                    add(z, 0)
            remaining_minutes[sid] -= maximum
            remaining_days[sid] -= 1
            if task is None or tasks[task]['kind'] != 'general':
                continue
            capacity = next(x['capacity'] for x in staff[sid]['skills'] if x['taskId'] == task)
            for a, b in segments[day]:
                if a not in available:
                    continue
                supplied[day, a, task] -= capacity
                role = selected_roles.get((a, b))
                for scope in (task, None):
                    if role is None:
                        denominator[day, a, scope] -= 1
                    else:
                        served[day, a, scope, role] -= 1
    return hints
