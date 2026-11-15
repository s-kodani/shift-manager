"""Translate an independently checked candidate to advisory CP starting values.

This module never adds constraints, deletes candidates, or certifies a solution.
The caller must run restricted CP feasibility and independently check its output.
"""


def candidate_hints(data, assignments, candidates, active, choices, role_choices, xs,
                    check_budget):
    by_day = {(a['staffId'], a['date']): a for a in assignments}
    transitions = {(t['fromTaskId'], t['toTaskId']): t['minutes']
                   for t in data['transitions']}
    hints = {}

    def add(variable, value):
        if variable is None:
            return  # Implicit no-role is derived from processing and actual roles.
        index = variable.index
        index, value = (index, value) if index >= 0 else (-index - 1, 1 - value)
        if index in hints and hints[index] != value:
            raise ValueError('UNREPRESENTABLE_VARIABLE')
        hints[index] = value

    for key, options in candidates.items():
        check_budget()
        assignment = by_day[key]
        selected = next((i for i, c in enumerate(options) if c == assignment['shift']), None)
        if selected is None:
            raise ValueError('UNREPRESENTABLE_SHIFT')
        for i, variable in enumerate(xs[key]):
            add(variable, int(i == selected))
        minutes = active[key, selected]
        blocks = {b['start']: b for b in assignment['blocks']}
        explicit_roles = {m: r['roleId'] for r in assignment.get('roleIntervals', [])
                          for m in range(r['start'], r['end'])}
        preparation, previous = set(), None
        for minute in sorted(minutes):
            block = blocks[minute - minute % data['slotMinutes']]
            task = block['taskId']
            if previous is not None and task != previous:
                preparation.update(range(minute, minute + transitions.get((previous, task), 0)))
            previous = task
        # Wholly interrupted logical slots carry the previous task internally.
        # Before the first real slot there is no previous task; use its task as
        # harmless internal state. No phantom blocks are returned to the user.
        last = next((b['taskId'] for _, b in sorted(blocks.items())), None)
        for slot, variables in choices[key].items():
            if slot in blocks:
                last = blocks[slot]['taskId']
            task = last if last is not None else next(iter(variables))
            if task not in variables:
                raise ValueError('UNREPRESENTABLE_TASK')
            for value, variable in variables.items():
                add(variable, int(value == task))
        # The model's exact segments must represent every requested processing
        # role. A valid checker-only minute boundary is not silently rounded.
        desired = {}
        for minute in minutes - preparation:
            block = blocks[minute - minute % data['slotMinutes']]
            role = explicit_roles.get(minute, block['roleId'])
            if role is not None:
                desired[minute] = role
        represented = set()
        for (start, end, task), variables in role_choices.get(key, {}).items():
            block = blocks.get(start - start % data['slotMinutes'])
            processing = (block is not None and block['taskId'] == task
                          and start in minutes and start not in preparation)
            roles = {desired.get(m) for m in range(start, end)} if processing else {None}
            if len(roles) != 1:
                raise ValueError('UNREPRESENTABLE_ROLE_BOUNDARY')
            role = next(iter(roles))
            if role not in variables:
                raise ValueError('UNREPRESENTABLE_ROLE')
            for value, variable in variables.items():
                add(variable, int(processing and role == value))
            if processing and role is not None:
                represented.update(range(start, end))
        if set(desired) != represented:
            raise ValueError('UNREPRESENTABLE_ROLE')
    return hints
