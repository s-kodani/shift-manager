"""Soft starting values only. Never prune candidates or return this as a result."""


def choose_hints(data, candidates, active, choices, role_choices, xs, strategy, check_budget):
    hints = {}
    demand = {(d['date'], d['start'], d['taskId']):
              d['direct'] if d['direct'] is not None else d['calculated'] for d in data['demand']}
    requirements_by_day = {}
    for requirement in data['roleRequirements']:
        requirements_by_day.setdefault(requirement['date'], []).append(requirement)
    role_filled = {}
    staff = {s['id']: s for s in data['staff']}
    staff_number = {s['id']: n for n, s in enumerate(data['staff'])}
    slots = data['slotMinutes']

    def add(var, value):
        if var is None:
            return  # The implicit no-role value is derived, never constrained.
        index = var.index
        hints[index if index >= 0 else -index - 1] = value if index >= 0 else 1 - value

    for key, options in candidates.items():
        check_budget()
        sid, day = key
        requirements = requirements_by_day.get(day, [])
        if strategy == 'legacy-first-v1':
            selected = next((i for i, c in enumerate(options) if c and c['workedMinutes']), 0)
        else:
            # Balance equal-length break candidates across staff rather than
            # putting every break in the first valid window. Monthly rules are
            # still solved by CP-SAT, not weakened to fit these starting values.
            maximum = max((c['workedMinutes'] if c else 0 for c in options), default=0)
            longest = [i for i, c in enumerate(options) if (c['workedMinutes'] if c else 0) == maximum]
            selected = longest[staff_number[sid] % len(longest)] if longest else 0
        for i, x in enumerate(xs[key]):
            add(x, int(i == selected))
        available = active.get((key, selected), set())
        day_choices = choices[key]
        selected_task = None
        if day_choices:
            eligible = next(iter(day_choices.values()))
            if strategy == 'legacy-first-v1':
                selected_task = next(iter(eligible))
            else:
                skills = {s['taskId']: s for s in staff[sid]['skills']}

                def score(task):
                    first, general, same, extra = 0, 0, 0, 0
                    capacity = skills[task]['capacity']
                    for minute in available:
                        start = minute - minute % slots
                        need = demand.get((day, start, task), 0)
                        general += min(max(need, 0), capacity)
                        extra += max(capacity - max(need, 0), 0)
                    for r in requirements:
                        if r['date'] != day or r['taskId'] not in (None, task) or r['roleId'] not in staff[sid]['roleIds']:
                            continue
                        amount = sum(r['start'] <= m < r['end'] for m in available)
                        if role_filled.get(r['id'], 0) < r['minimum']:
                            if r['priority'] == 'first':
                                first += amount * data['capacityScale']
                            else:
                                same += amount * data['capacityScale']
                    return first, general + same, -extra

                selected_task = max(eligible, key=score)
            for task_choices in day_choices.values():
                for task, z in task_choices.items():
                    add(z, int(task == selected_task))
        if strategy == 'legacy-first-v1':
            continue
        # A constant daily task has no transition preparation. Only exact
        # active processing intervals are hinted as qualified role service.
        for (a, b, task), variables in role_choices.get(key, {}).items():
            supported = [r for r in requirements if r['date'] == day and r['start'] <= a < r['end']
                         and r['taskId'] in (None, task) and r['roleId'] in variables]
            role = min(supported, key=lambda r: r['priority'] != 'first')['roleId'] if supported else None
            processing = a in available and task == selected_task
            for value, z in variables.items():
                add(z, int(processing and value == role))
        if selected_task is not None:
            capacity = next(s['capacity'] for s in staff[sid]['skills'] if s['taskId'] == selected_task)
            for start in {m - m % slots for m in available}:
                k = day, start, selected_task
                demand[k] = demand.get(k, 0) - capacity
            for r in requirements:
                if r['date'] == day and r['taskId'] in (None, selected_task) and r['roleId'] in staff[sid]['roleIds']:
                    if set(range(r['start'], r['end'])) <= available:
                        role_filled[r['id']] = role_filled.get(r['id'], 0) + 1
    return hints
