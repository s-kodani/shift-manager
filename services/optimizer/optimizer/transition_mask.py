"""Equivalent exclusion using the enclosing exactly-one candidate constraint."""


def add_transition_exclusion(model, left, right, seen, invalid_indices, activity):
    if not invalid_indices:
        return 0
    invalid = activity(invalid_indices)
    model.add_bool_or([left.Not(), right.Not(), seen.Not(), invalid.Not()])
    return len(invalid_indices)
