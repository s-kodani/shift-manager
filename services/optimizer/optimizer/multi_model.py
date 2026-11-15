"""Joint CP-SAT model with shared daily task state and exact activity masks.

Every registered candidate is retained unless a hard condition excludes it.
No task-variable thinning, waiting state, or rounding preparation to 30 minutes.
"""
import hashlib
import json
import resource
import sys
import time
from datetime import timedelta

import ortools
from ortools.sat.python import cp_model

from .contract import dates
from .multi_checker import check_multi
from .multi_contract import validate_multi
from .initial_hint import choose_hints
from .interval_hint import interval_hints
from .saved_candidate import candidate_hints
from .candidate_certificate import CandidateCertificate
from .cp_deadline import solve_with_deadline
from .minute_set import MinuteSet
from .candidate_catalog import CandidateCatalog
from .common_run import add_common_runs
from .duty_geometry import duty_geometry
from .process_observation import memory_usage
from .transition_mask import add_transition_exclusion

MODEL_ENCODING = 'shared-daily-v1'
ZERO_PROOF_STRATEGY = 'balanced-incumbent-v4'


def solver_timing(source, elapsed):
    # Timing is observational. A fault-injection adapter can return a status
    # without a CP response; do not turn that into a solver/checker failure.
    try:
        wall, user = source.wall_time, source.user_time
    except RuntimeError as error:
        if str(error) != 'solve() has not been called.':
            raise
        return {'solverWallSeconds': None, 'solverUserSeconds': None,
                'outsideSolverWallSeconds': None, 'timingUnavailable': 'NO_SOLVER_RESPONSE'}
    return {'solverWallSeconds': wall, 'solverUserSeconds': user,
            'outsideSolverWallSeconds': elapsed - wall}


def initial_allowance(strategy, budget_seconds, remaining_seconds):
    # The new policy reserves the existing final-check margin and gives at
    # most half of the remaining search time to obtaining a first candidate.
    remaining = max(0, remaining_seconds)
    return (min(budget_seconds * .25, remaining * .5)
            if strategy == ZERO_PROOF_STRATEGY else min(budget_seconds * .1, remaining))


def complete_solution_values(model, source, bulk=False):
    """Copy all positive-index variable values from a successful CP response."""
    if bulk:
        values = list(source.response_proto.solution)
        if len(values) != len(model.proto.variables):
            raise ValueError('SOLUTION_VECTOR_LENGTH')
        return values
    return [source.value(model.get_int_var_from_proto_index(i))
            for i in range(len(model.proto.variables))]


def replace_complete_hints(model, values, bulk=False):
    """Keep the same ordered full hints, including newly interned constants."""
    count = len(model.proto.variables)
    if len(values) > count:
        raise ValueError('SOLUTION_VECTOR_LENGTH')
    for index in range(len(values), count):
        domain = model.proto.variables[index].domain
        if len(domain) != 2 or domain[0] != domain[1]:
            raise ValueError('UNSOLVED_NEW_VARIABLE')
        values.append(domain[0])
    model.clear_hints()
    if not count:
        return
    if bulk:
        model.proto.solution_hint.vars.extend(range(count))
        model.proto.solution_hint.values.extend(values)
    else:
        for index, value in enumerate(values):
            model.add_hint(model.get_int_var_from_proto_index(index), value)


def candidates_multi(data, staff, day):
    key = day.isoformat()
    locks = [x for x in data['locks'] if x['staffId'] == staff['id'] and x['date'] == key]
    events = [e for e in data['events'] if e['date'] == key and staff['id'] in e['staffIds']]
    if data['mode'] == 'reallocation':
        options = [next(x['shift'] for x in data['published'] if x['staffId'] == staff['id'] and x['date'] == key)]
    else:
        options = [None]
        rule = data['breakRule']
        for p in data['patterns']:
            bs = [p['fixedBreak']] if p['breakKind'] == 'fixed' else [None] + [
                [m, m + rule['requiredMinutes']] for m in range(p['start'], p['end'], 30)
                if rule['requiredMinutes'] and m + rule['requiredMinutes'] <= p['end']]
            for b in bs:
                options.append({'patternId': p['id'], 'start': p['start'], 'end': p['end'],
                                'breakKind': p['breakKind'], 'break': b,
                                'workedMinutes': p['end'] - p['start'] - (b[1] - b[0] if b else 0),
                                'cancelled': []})
    result = []
    for shift in options:
        if shift is None:
            if not events and not any(x['shift'] is not None for x in locks):
                result.append(None)
            continue
        p = next(x for x in data['patterns'] if x['id'] == shift['patternId'])
        if any(shift[k] != p[k] for k in ('start', 'end', 'breakKind')):
            continue
        if p['breakKind'] == 'fixed' and shift['break'] != p['fixedBreak']:
            continue
        occupied = set(range(shift['start'], shift['end']))
        for a, b in shift['cancelled']:
            occupied.difference_update(range(a, b))
        b = shift['break']
        rest = set(range(*b)) & occupied if b else set()
        work = occupied - rest
        rule = data['breakRule']
        basis = len(work) if rule['basis'] == 'worked' else len(occupied)
        need = rule['requiredMinutes'] if basis > rule['threshold'] else 0
        if (shift['breakKind'] == 'auto' and len(rest) != need) or len(rest) < need:
            continue
        if b and (b[0] < shift['start'] + rule['afterStart'] or b[1] > shift['end'] - rule['beforeEnd']):
            continue
        if occupied and (day.weekday() not in staff['contract']['weekdays'] or
                         not occupied <= set(range(staff['contract']['start'], staff['contract']['end']))):
            continue
        if len(work) != shift['workedMinutes'] or any(len(work) > r['dailyMax'] for r in staff['rules']):
            continue
        valid = True
        for lock in locks:
            if lock['shift'] is None:
                valid = False
                break
            fields = []
            for part in lock['parts']:
                fields += {'pattern': ['patternId'], 'time': ['start', 'end'], 'break': ['break', 'breakKind']}[part]
            if any(shift[f] != lock['shift'][f] for f in fields):
                valid = False
        permitted = set()
        for e in data['exceptions']:
            if e['staffId'] == staff['id'] and e['date'] == key:
                locked = next(x['shift'] for x in locks if x['id'] == e['lockId'])
                if all(shift[f] == locked[f] for f in ('patternId', 'start', 'end', 'breakKind', 'break')):
                    permitted.update(range(e['start'], e['end']))
        if any((occupied & set(range(u['start'], u['end']))) - permitted for u in staff['unavailable'] if u['date'] == key):
            valid = False
        event_minutes = set()
        for e in events:
            minutes = set(range(e['start'], e['end']))
            if not minutes <= work or minutes & event_minutes:
                valid = False
            event_minutes |= minutes
        if valid:
            result.append(shift)
    return result


def active_minutes(data, sid, day, shift, *, compact=False):
    if shift is None:
        return MinuteSet() if compact else set()
    if compact:
        work = MinuteSet.interval(shift['start'], shift['end'])
        if shift['break']:
            work -= MinuteSet.interval(*shift['break'])
        for a,b in shift['cancelled']:
            work -= MinuteSet.interval(a,b)
        for e in data['events']:
            if e['date']==day and sid in e['staffIds']:
                work -= MinuteSet.interval(e['start'],e['end'])
        return work
    work = set(range(shift['start'], shift['end']))
    if shift['break']:
        work.difference_update(range(*shift['break']))
    for a, b in shift['cancelled']:
        work.difference_update(range(a, b))
    for e in data['events']:
        if e['date'] == day and sid in e['staffIds']:
            work.difference_update(range(e['start'], e['end']))
    return work


def active_slot_geometry(minutes, slot_minutes):
    """Exact count and first active minute per slot; local to one candidate.

    This is an index over the original minute set, not a rounded interval or
    a replacement for the minute-level preparation/processing checks.
    """
    geometry = {}
    for minute in minutes:
        slot = minute - minute % slot_minutes
        count, first = geometry.get(slot, (0, minute))
        geometry[slot] = (count + 1, min(first, minute))
    return geometry


def missed_multi(staff, day, shift):
    preferences = [p for p in staff['preferences'] if p['date'] == day]
    if not preferences:
        return 0
    work = bool(shift and shift['workedMinutes'])
    if all(p['kind'] in ('work', 'off') for p in preferences):
        return sum(int(not (work if p['kind'] == 'work' else not work)) for p in preferences)
    remaining = set(range(shift['start'], shift['end'])) if shift else set()
    if shift:
        for a, b in shift['cancelled']:
            remaining.difference_update(range(a, b))
    total = 0
    for p in preferences:
        ok = {'work': work, 'off': not work}.get(p['kind'], False)
        if p['kind'] == 'pattern':
            ok = work and p['patternId'] == shift['patternId'] and len(remaining) == shift['end'] - shift['start']
        elif p['kind'] == 'window':
            ok = work and p['start'] <= min(remaining) and max(remaining) + 1 <= p['end']
        total += int(not ok)
    return total


class BuildBudgetExceeded(Exception):
    def __init__(self, model, started, cpu_started, reason):
        self.metrics = {'modelEncoding': MODEL_ENCODING,
                        'prepareSeconds': time.monotonic() - started,
                        'totalSeconds': time.monotonic() - started,
                        'cpuSeconds': time.process_time() - cpu_started,
                        'variables': len(model.proto.variables),
                        'constraints': len(model.proto.constraints),
                        'maxRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024)}
        self.reason = reason


def solve_multi(data, budget_seconds=20, *, hint_strategy='legacy-first-v1',
                role_encoding='implicit-none-v1', saved_assignments=None, main_presolve=True,
                tight_run_bounds=False, bulk_solution_transfer=False, covered_off_hints=False,
                deadline_stop=False, checkpoint_callback=None, calendar_roster=False, compact_minutes=False,
                shared_build_facts=False, build_variable_limit=1_000_000, common_runs=False,
                progress_callback=None, prepared_callback=None, saved_precheck=None, debug_names=True, calendar_fallback=False):
    if (not isinstance(calendar_fallback, bool) or
            (calendar_fallback and (calendar_roster or not covered_off_hints or hint_strategy != ZERO_PROOF_STRATEGY))):
        raise ValueError('CALENDAR_FALLBACK_SETTING')
    if not isinstance(debug_names, bool):
        raise ValueError('DEBUG_NAME_SETTING')
    if saved_precheck is not None and not callable(saved_precheck):
        raise ValueError('SAVED_PRECHECK_CALLBACK')
    if prepared_callback is not None and not callable(prepared_callback):
        raise ValueError('PREPARED_CALLBACK')
    if progress_callback is not None and not callable(progress_callback):
        raise ValueError('PROGRESS_CALLBACK')
    if not isinstance(common_runs,bool):
        raise ValueError('COMMON_RUN_SETTING')
    if (not isinstance(build_variable_limit,int) or isinstance(build_variable_limit,bool)
            or not 1_000_000<=build_variable_limit<=3_500_000):
        raise ValueError('BUILD_VARIABLE_LIMIT')
    if not isinstance(shared_build_facts, bool) or (shared_build_facts and not compact_minutes):
        raise ValueError('SHARED_BUILD_FACTS_SETTING')
    if not isinstance(compact_minutes, bool):
        raise ValueError('COMPACT_MINUTES_SETTING')
    if not isinstance(calendar_roster, bool):
        raise ValueError('CALENDAR_ROSTER_SETTING')
    if checkpoint_callback is not None and not callable(checkpoint_callback):
        raise ValueError('CHECKPOINT_CALLBACK')
    if not isinstance(deadline_stop, bool):
        raise ValueError('CP_DEADLINE_STOP_SETTING')
    if not isinstance(main_presolve, bool):
        raise ValueError('MAIN_PRESOLVE_SETTING')
    if not isinstance(tight_run_bounds, bool):
        raise ValueError('TIGHT_RUN_BOUNDS_SETTING')
    if not isinstance(bulk_solution_transfer, bool):
        raise ValueError('BULK_SOLUTION_TRANSFER_SETTING')
    if not isinstance(covered_off_hints, bool):
        raise ValueError('COVERED_OFF_HINT_SETTING')
    if covered_off_hints and hint_strategy != ZERO_PROOF_STRATEGY:
        raise ValueError('COVERED_OFF_HINT_REQUIRES_V4')
    if hint_strategy not in ('legacy-first-v1', 'balanced-coverage-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', ZERO_PROOF_STRATEGY):
        raise ValueError('UNKNOWN_HINT_STRATEGY')
    if role_encoding not in ('explicit-v1', 'implicit-none-v1'):
        raise ValueError('UNKNOWN_ROLE_ENCODING')
    if saved_assignments is not None and hint_strategy != ZERO_PROOF_STRATEGY:
        raise ValueError('SAVED_CANDIDATE_REQUIRES_V4')
    started, cpu_started = time.monotonic(), time.process_time()
    try:
        return _solve_multi(data, budget_seconds, started, cpu_started, hint_strategy, role_encoding,
                            saved_assignments, main_presolve, tight_run_bounds, bulk_solution_transfer,
                            covered_off_hints, deadline_stop, checkpoint_callback, calendar_roster, compact_minutes,
                            shared_build_facts, build_variable_limit, common_runs, progress_callback, prepared_callback, saved_precheck, debug_names, calendar_fallback)
    except BuildBudgetExceeded as error:
        error.metrics['initialHintStrategy'] = hint_strategy
        error.metrics['roleEncoding'] = role_encoding
        error.metrics['budgetSeconds'] = budget_seconds
        error.metrics['mainPresolveEnabled'] = main_presolve
        error.metrics['tightRunBoundsEnabled'] = tight_run_bounds
        error.metrics['bulkSolutionTransferEnabled'] = bulk_solution_transfer
        error.metrics['coveredOffHintsEnabled'] = covered_off_hints
        error.metrics['deadlineStopEnabled'] = deadline_stop
        error.metrics['calendarRosterHintsEnabled'] = calendar_roster
        error.metrics['calendarFallbackHintsEnabled'] = calendar_fallback
        error.metrics['compactMinutesEnabled'] = compact_minutes
        error.metrics['sharedBuildFactsEnabled'] = shared_build_facts
        error.metrics['buildVariableLimit'] = build_variable_limit
        error.metrics['commonRunsEnabled'] = common_runs
        error.metrics['debugNamesEnabled'] = debug_names
        return {'schemaVersion': 'multi-task-v1', 'tenantId': data['tenantId'], 'teamId': data['teamId'],
                'month': data['month'], 'mode': data['mode'], 'inputVersion': data['inputVersion'],
                'settingsVersion': data['settingsVersion'], 'jobId': data['jobId'], 'attempt': data['attempt'],
                'inputHash': hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
                'solverStatus': 'UNKNOWN', 'validation': {'status': 'NOT_RUN', 'violations': []},
                'assignments': None, 'stages': [], 'publication': 'BLOCKED_A1',
                'termination': error.reason, 'metrics': error.metrics}


def _solve_multi(data, budget_seconds, started, cpu_started, hint_strategy, role_encoding,
                 saved_assignments, main_presolve, tight_run_bounds, bulk_solution_transfer,
                 covered_off_hints, deadline_stop, checkpoint_callback, calendar_roster, compact_minutes,
                 shared_build_facts, build_variable_limit, common_runs, progress_callback, prepared_callback, saved_precheck, debug_names, calendar_fallback):
    deadline = started + budget_seconds
    phase, phase_started, phase_seconds, model_built = 'inputValidation', started, {}, False
    model, last_observed, observation_failures = None, float('-inf'), 0

    def observe(event, cp_status=None):
        nonlocal last_observed, observation_failures
        if progress_callback is None:
            return
        last_observed = time.monotonic()
        current, maximum = memory_usage()
        row = {'event': event, 'phase': phase, 'seconds': last_observed-started,
               'variables': len(model.proto.variables) if model is not None else 0,
               'constraints': len(model.proto.constraints) if model is not None else 0,
               'rssBytes': current, 'maxRssBytes': maximum, 'modelBuildComplete': model_built,
               'cpStatus': cp_status}
        try:
            progress_callback(row)
        except Exception:
            observation_failures += 1

    def enter_phase(name):
        nonlocal phase, phase_started
        tick = time.monotonic()
        phase_seconds[phase] = phase_seconds.get(phase, 0) + tick - phase_started
        phase, phase_started = name, tick
        observe('phase')

    def phase_metrics():
        seconds = dict(phase_seconds)
        seconds[phase] = seconds.get(phase, 0) + time.monotonic() - phase_started
        return {'seconds': seconds, 'lastPhase': phase, 'modelBuildComplete': model_built,
                'observationFailures': observation_failures,
                'modelBuildSeconds': sum(seconds.get(p, 0) for p in
                    ('candidates', 'duties', 'rules', 'objectives'))}

    observe('phase')
    validate_multi(data)
    enter_phase('savedCandidatePrecheck')
    saved_report, saved_metrics = None, None
    if saved_assignments is not None:
        tick = time.monotonic()
        saved_report = saved_precheck(data, saved_assignments) if saved_precheck else check_multi(data, saved_assignments)
        saved_metrics = {'scope': 'advisory-saved-candidate', 'adopted': False,
                         'precheckStatus': saved_report['status'],
                         'precheckSeconds': time.monotonic() - tick,
                         'precheckSource': 'bound-parent-file' if saved_precheck else 'fresh-checker'}
        if saved_report['status'] != 'VERIFIED':
            saved_metrics['rejection'] = 'LATEST_INPUT_NOT_VERIFIED'
        else:
            saved_metrics['sourceObjectiveVector'] = list(saved_report['objectiveVector'])
    model, ds = cp_model.CpModel(), dates(data)
    transition_mask_stats = {'groups': 0, 'individualClausesReplaced': 0}
    enter_phase('candidates')
    def construction_budget():
        if progress_callback is not None and time.monotonic()-last_observed >= 5:
            observe('buildProgress')
        reason = None
        if time.monotonic() >= deadline - max(0, budget_seconds * .1):
            reason = 'BUILD_BUDGET_EXHAUSTED'
        # Initial implementation resource guard. This is a failure to build the
        # whole model, never a proof of infeasibility of the original problem.
        if len(model.proto.variables) > build_variable_limit:
            reason = 'BUILD_COMPLEXITY_LIMIT'
        if reason:
            error = BuildBudgetExceeded(model, started, cpu_started, reason)
            error.metrics['phaseTimings'] = phase_metrics()
            error.metrics['transitionMaskStats'] = dict(transition_mask_stats)
            if saved_metrics is not None:
                error.metrics['savedCandidate'] = saved_metrics
            raise error

    tasks = {t['id']: t for t in data['tasks']}
    roles = {r['id']: r for r in data['roles']}
    transition = {(t['fromTaskId'], t['toTaskId']): t['minutes'] for t in data['transitions']}
    candidates, xs, choices, worked, working_days, active = {}, {}, {}, {}, {}, {}
    minute_pool, boundary_cache, geometry_cache, duty_geometry_cache = {}, {}, {}, {}
    catalog = CandidateCatalog(data,candidates_multi) if shared_build_facts else None
    invalid_transition_cache = {}
    boundaries = {d.isoformat(): {0, 1440, *range(0, 1440, data['slotMinutes'])} for d in ds}
    preferences = []
    for s in data['staff']:
        for d in ds:
            construction_budget()
            day, key = d.isoformat(), (s['id'], d.isoformat())
            candidates[key] = catalog.get(s,d) if catalog is not None else candidates_multi(data,s,d)
            xs[key] = [model.new_bool_var(f'x:{key}:{i}' if debug_names else '') for i in range(len(candidates[key]))]
            model.add_exactly_one(xs[key])
            worked[key] = sum(x * (c['workedMinutes'] if c else 0) for x, c in zip(xs[key], candidates[key]))
            working_days[key] = sum(x for x, c in zip(xs[key], candidates[key]) if c and c['workedMinutes'])
            for i, (x, c) in enumerate(zip(xs[key], candidates[key])):
                preferences.append(x * missed_multi(s, day, c))
                minutes_set = active_minutes(data, s['id'], day, c, compact=compact_minutes)
                if compact_minutes:
                    minutes_set = minute_pool.setdefault(minutes_set.bits, minutes_set)
                active[key, i] = minutes_set
                # Exact change points including non-aligned events and transition ends.
                signature = minutes_set.bits if compact_minutes else None
                if compact_minutes and signature in boundary_cache:
                    boundaries[day].update(boundary_cache[signature])
                else:
                    points=set()
                    for m in sorted(minutes_set):
                        if m-1 not in minutes_set:
                            points.add(m)
                        if m+1 not in minutes_set:
                            points.add(m+1)
                    boundaries[day].update(points)
                    if compact_minutes:
                        boundary_cache[signature]=points
    for day, points in boundaries.items():
        for m in range(0, 1440, data['slotMinutes']):
            for t in transition.values():
                if m + t <= 1440:
                    points.add(m + t)
        for r in data['roleRequirements']:
            if r['date'] == day:
                points.update([r['start'], r['end']])
    segments = {day: list(zip(points, points[1:])) for day, raw in boundaries.items() if (points := sorted(raw))}
    cap, den, counts, role_choices = {}, {}, {}, {}
    role_requirements = {}
    for r in data['roleRequirements']:
        role_requirements.setdefault(r['date'], []).append(r)
    enter_phase('duties')
    run_domain_summary = {'variables': 0, 'maximumUpper': 0, 'sumUpper': 0}

    def conjunction(left, right, name):
        result = model.new_bool_var(name)
        model.add(result <= left)
        model.add(result <= right)
        model.add(result >= left + right - 1)
        return result

    for s in data['staff']:
        eligible = {skill['taskId']: skill for skill in s['skills'] if skill['level'] >= tasks[skill['taskId']]['minimumLevel']}
        for d in ds:
            construction_budget()
            day, key = d.isoformat(), (s['id'], d.isoformat())
            minute_sets = [active[key, i] for i in range(len(xs[key]))]
            minute_signature = tuple(m.bits for m in minute_sets) if shared_build_facts else None
            daily_facts = None
            if shared_build_facts:
                if minute_signature not in duty_geometry_cache:
                    duty_geometry_cache[minute_signature] = duty_geometry(
                        minute_sets, data['slotMinutes'], geometry_cache, active_slot_geometry)
                daily_facts = duty_geometry_cache[minute_signature]
            possible = daily_facts.possible if daily_facts else set().union(*minute_sets) if minute_sets else set()
            slots = daily_facts.slots if daily_facts else sorted({m - m % data['slotMinutes'] for m in possible})
            choices[key] = {}
            if not slots:
                continue
            if not eligible:
                # Only event-only/off candidates can be selected without a task skill.
                model.add(sum(x for x, minutes in zip(xs[key], minute_sets) if minutes) == 0)
                continue
            # Exactly one daily candidate is selected. Each run is a suffix
            # sum of that candidate's nonnegative per-slot active lengths, so
            # it cannot exceed its whole day's active minutes. Preparation
            # remains active; rest, cancellation and events remain excluded.
            # This changes only redundant domain bounds, not any candidate,
            # task choice, transition or minimum-continuity constraint.
            run_upper = max(map(len, minute_sets)) if tight_run_bounds else 1440
            flags = {}

            def activity(indices):
                indices = tuple(indices)
                if indices not in flags:
                    if not indices or len(indices) == len(xs[key]):
                        flag = model.new_constant(int(bool(indices)))
                    elif len(indices) == 1:
                        flag = xs[key][indices[0]]
                    else:
                        flag = model.new_bool_var(f'active:{key}:{indices}' if debug_names else '')
                        model.add(flag == sum(xs[key][i] for i in indices))
                    flags[indices] = flag
                return flags[indices]

            # Reuse exact per-slot facts instead of scanning/sorting the same
            # candidate minutes for every slot and every ordered task pair.
            geometry=list(daily_facts.geometry) if daily_facts else []
            for minutes in ([] if daily_facts else minute_sets):
                signature=(minutes.bits,data['slotMinutes']) if compact_minutes else None
                if not compact_minutes or signature not in geometry_cache:
                    facts=active_slot_geometry(minutes,data['slotMinutes'])
                    if compact_minutes:
                        geometry_cache[signature]=facts
                else:
                    facts=geometry_cache[signature]
                geometry.append(facts)
            first_slots = [min(g, default=1440) for g in geometry]
            present, seen, lengths, by_task, changes = {}, {}, {}, {}, {}
            for n, b in enumerate(slots):
                amounts = daily_facts.amounts[b] if daily_facts else [g.get(b, (0, None))[0] for g in geometry]
                present[b] = activity(daily_facts.present[b] if daily_facts else (i for i, amount in enumerate(amounts) if amount))
                lengths[b] = sum(x * amount for x, amount in zip(xs[key], amounts) if amount)
                seen[b] = activity(daily_facts.seen[b] if daily_facts else (i for i, first in enumerate(first_slots)
                                   if first < b + data['slotMinutes']))
                task_ids = list(eligible)
                if len(task_ids) == 1:
                    choices[key][b] = {task_ids[0]: model.new_constant(1)}
                elif len(task_ids) == 2:
                    chosen = model.new_bool_var(f't:{key}:{b}:{task_ids[0]}' if debug_names else '')
                    choices[key][b] = {task_ids[0]: chosen, task_ids[1]: chosen.Not()}
                else:
                    choices[key][b] = {task: model.new_bool_var(f't:{key}:{b}:{task}' if debug_names else '') for task in eligible}
                    model.add_exactly_one(choices[key][b].values())
                for task, chosen in choices[key][b].items():
                    by_task[b, task] = chosen
                    if n:
                        # Carry the last logical task across wholly interrupted slots.
                        # This internal state is never emitted as a phantom assignment.
                        model.add(chosen == by_task[slots[n - 1], task]).only_enforce_if(present[b].Not())
                if not n:
                    continue
                previous_b = slots[n - 1]
                for old in eligible:
                    for new in eligible:
                        if old == new:
                            continue
                        length = transition.get((old, new), 0)
                        signature = minute_signature,b,length
                        if not shared_build_facts or signature not in invalid_transition_cache:
                            preparation = MinuteSet.interval(b,b+length) if shared_build_facts else set(range(b,b+length))
                            invalid_indices=[]
                            for i,minutes in enumerate(minute_sets):
                                count,first=geometry[i].get(b,(0,None))
                                if count and (first!=b or not preparation<=minutes):
                                    invalid_indices.append(i)
                            if shared_build_facts:
                                invalid_transition_cache[signature]=tuple(invalid_indices)
                        else:
                            invalid_indices=invalid_transition_cache[signature]
                        left, right = by_task[previous_b, old], by_task[b, new]
                        replaced = add_transition_exclusion(model, left, right, seen[previous_b],
                                                            invalid_indices, activity)
                        if replaced:
                            transition_mask_stats['groups'] += 1
                            transition_mask_stats['individualClausesReplaced'] += replaced
                        if length:
                            changed = model.new_bool_var(f'switch:{key}:{b}:{old}:{new}' if debug_names else '')
                            for condition in (left, right, present[b], seen[previous_b]):
                                model.add(changed <= condition)
                            model.add(changed >= left + right + present[b] + seen[previous_b] - 3)
                            changes[b, old, new] = changed
            if common_runs:
                count=add_common_runs(model,slots,by_task,lengths,seen,
                    {task:tasks[task]['minimumMinutes'] for task in eligible},run_upper,key, debug_names=debug_names)
                run_domain_summary['variables']+=count
                if count:
                    run_domain_summary['maximumUpper']=max(run_domain_summary['maximumUpper'],run_upper)
                    run_domain_summary['sumUpper']+=count*run_upper
            else:
                for task in eligible:
                    if tasks[task]['minimumMinutes'] == 0:
                        continue
                    run_domain_summary['variables'] += len(slots)
                    run_domain_summary['maximumUpper'] = max(run_domain_summary['maximumUpper'], run_upper)
                    run_domain_summary['sumUpper'] += len(slots) * run_upper
                    runs = []
                    for n, b in enumerate(slots):
                        chosen = by_task[b, task]
                        cumulative = model.new_int_var(0, run_upper, f'run:{key}:{b}:{task}' if debug_names else '')
                        model.add(cumulative == 0).only_enforce_if(chosen.Not())
                        if not n:
                            model.add(cumulative == lengths[b]).only_enforce_if(chosen)
                        else:
                            prev = by_task[slots[n - 1], task]
                            model.add(cumulative == runs[-1] + lengths[b]).only_enforce_if([chosen, prev])
                            model.add(cumulative == lengths[b]).only_enforce_if([chosen, prev.Not()])
                            model.add(runs[-1] >= tasks[task]['minimumMinutes']).only_enforce_if([prev, chosen.Not(), seen[slots[n - 1]]])
                        runs.append(cumulative)
                    model.add(runs[-1] >= tasks[task]['minimumMinutes']).only_enforce_if([by_task[slots[-1], task], seen[slots[-1]]])
            assigned_cache, processing_cache = {}, {}
            for a, b in segments[day]:
                if a not in possible:
                    continue
                slot = a - a % data['slotMinutes']
                active_here = activity(i for i, minutes in enumerate(minute_sets) if a in minutes)
                for task in eligible:
                    if tasks[task]['kind'] != 'general':
                        continue
                    # Identical activity masks within one logical slot are the
                    # same fact even when global interval boundaries split it.
                    assigned_key = (slot, task, active_here.index)
                    if assigned_key not in assigned_cache:
                        assigned_cache[assigned_key] = conjunction(by_task[slot, task], active_here, f'assigned:{key}:{a}:{task}' if debug_names else '')
                    assigned = assigned_cache[assigned_key]
                    prep_variables = tuple(changed for (slot_b, old, new), changed in changes.items()
                                           if slot_b == slot and new == task and a < slot + transition.get((old, new), 0))
                    if not prep_variables:
                        processing = assigned
                    else:
                        processing_key = (assigned.index, tuple(v.index for v in prep_variables))
                        if processing_key not in processing_cache:
                            processing_cache[processing_key] = model.new_bool_var(f'y:{key}:{a}:{task}' if debug_names else '')
                            model.add(processing_cache[processing_key] == assigned - sum(prep_variables))
                        processing = processing_cache[processing_key]
                    cap.setdefault((day, a, task), []).append(processing * eligible[task]['capacity'])
                    role_variables = {}
                    needed_here = any(r['start'] <= a < r['end'] and r['taskId'] in (None, task)
                                      for r in role_requirements.get(day, []))
                    allowed = [r for r in s['roleIds'] if task in roles[r]['allowedTasks']] if needed_here else []
                    if not allowed:
                        for scope in (task, None):
                            den.setdefault((day, a, scope), []).append(processing)
                        continue
                    # The no-role count is exactly processing - sum(roles).
                    # All role/no-role possibilities remain available; this
                    # eliminates only a redundant Boolean, not a candidate.
                    for role in ([None] + allowed if role_encoding == 'explicit-v1' else allowed):
                        actual = model.new_bool_var(f'role-process:{key}:{a}:{task}:{role}' if debug_names else '')
                        role_variables[role] = actual
                        if role is None:
                            for scope in (task, None):
                                den.setdefault((day, a, scope), []).append(actual)
                        else:
                            for scope in (task, None):
                                counts.setdefault((day, a, scope, role), []).append(actual)
                    if role_encoding == 'explicit-v1':
                        model.add(sum(role_variables.values()) == processing)
                    else:
                        assigned_roles = sum(role_variables.values())
                        model.add(assigned_roles <= processing)
                        for scope in (task, None):
                            den.setdefault((day, a, scope), []).append(processing - assigned_roles)
                        # Virtual no-role choice for hint scoring. The real role
                        # Booleans determine its value; it has no separate hint.
                        role_variables = {None: None, **role_variables}
                    role_choices.setdefault(key, {})[a, b, task] = role_variables
    enter_phase('rules')
    history = {(h['staffId'], h['date']): h['workedMinutes'] for h in data['history']}
    for s in data['staff']:
        construction_budget()
        sid = s['id']
        for r in s['rules']:
            model.add(sum(worked[sid, d.isoformat()] for d in ds) >= r['monthlyMin'])
            model.add(sum(worked[sid, d.isoformat()] for d in ds) <= r['monthlyMax'])
            model.add(sum(working_days[sid, d.isoformat()] for d in ds) >= r['minDays'])
            model.add(sum(working_days[sid, d.isoformat()] for d in ds) <= len(ds) - r['minOff'])
            weeks = {}
            for d in ds:
                week = d - timedelta(days=(d.weekday() - data['weekStart']) % 7)
                weeks.setdefault(week, []).append(d)
            for week, members in weeks.items():
                outside = sum(history.get((sid, (week + timedelta(days=n)).isoformat()), 0)
                              for n in range(7) if week + timedelta(days=n) not in ds)
                model.add(sum(worked[sid, d.isoformat()] for d in members) + outside <= r['weeklyMax'])
            ends = ds + [ds[-1] + timedelta(days=n) for n in range(1, r['maxConsecutive'] + 1)
                         if (sid, (ds[-1] + timedelta(days=n)).isoformat()) in history]
            for end in ends:
                window = [end - timedelta(days=n) for n in range(r['maxConsecutive'] + 1)]
                known = sum(history.get((sid, d.isoformat()), 0) > 0 for d in window if d not in ds)
                model.add(sum(working_days[sid, d.isoformat()] for d in window if d in ds) + known <= r['maxConsecutive'])
    enter_phase('objectives')
    shortage, surplus, first, same = [], [], [], []
    demand = {(d['date'], d['start'], d['taskId']): d['direct'] if d['direct'] is not None else d['calculated'] for d in data['demand']}
    max_capacity = len(data['staff']) * 10000
    for day, intervals in segments.items():
        construction_budget()
        for a, b in intervals:
            construction_budget()
            for task in tasks:
                if tasks[task]['kind'] != 'general':
                    continue
                c = sum(cap.get((day, a, task), []))
                need = demand.get((day, a - a % data['slotMinutes'], task), 0)
                if not need and (day, a, task) not in cap:
                    continue
                lo = model.new_int_var(0, max(need, max_capacity), f'deficit:{day}:{a}:{task}' if debug_names else '')
                hi = model.new_int_var(0, max(need, max_capacity), f'surplus:{day}:{a}:{task}' if debug_names else '')
                model.add_max_equality(lo, [0, need - c])
                model.add_max_equality(hi, [0, c - need])
                shortage.append(lo * (b - a))
                surplus.append(hi * (b - a))
            for r in data['roleRequirements']:
                if r['date'] != day or not r['start'] <= a < r['end']:
                    continue
                n = sum(den.get((day, a, r['taskId']), []))
                ratio_max = (len(data['staff']) * r['ratioNumerator'] + r['ratioDenominator'] - 1) // r['ratioDenominator']
                ratio = model.new_int_var(0, ratio_max, f'ratio:{r["id"]}:{a}' if debug_names else '')
                numerator, denominator = n * r['ratioNumerator'], r['ratioDenominator']
                offset = denominator - 1 if r['rounding'] == 'ceil' else 0
                model.add_division_equality(ratio, numerator + offset, denominator)
                required = model.new_int_var(0, max(r['minimum'], ratio_max), f'required:{r["id"]}:{a}' if debug_names else '')
                model.add_max_equality(required, [r['minimum'], ratio])
                actual = sum(counts.get((day, a, r['taskId'], r['roleId']), []))
                deficit = model.new_int_var(0, max(r['minimum'], ratio_max), f'role-deficit:{r["id"]}:{a}' if debug_names else '')
                model.add_max_equality(deficit, [0, required - actual])
                (first if r['priority'] == 'first' else same).append(deficit * (b - a) * data['capacityScale'])
    objectives = [('roleFirst', sum(first)), ('combined', sum(shortage) + sum(same)),
                  ('missed', sum(preferences)), ('surplus', sum(surplus))]
    if data['priority'] == 'preference':
        objectives = [objectives[2], objectives[0], objectives[1], objectives[3]]
    if not first:
        objectives = [x for x in objectives if x[0] != 'roleFirst']
    # Each term has a nonnegative integer domain/coefficient: exact deficits,
    # counts of missed wishes, and exact surplus. A VERIFIED feasible value 0
    # proves this lower bound for the full model, not just the restricted seed.
    lower_bounds = {'roleFirst': 0, 'combined': 0, 'missed': 0, 'surplus': 0}
    model_built = True
    enter_phase('initialHints')
    # A partial starting point only, never a retained result or an extra hard
    # constraint: CP-SAT must still solve all monthly, role and task conditions.
    # All candidates remain available even when this greedy hint is infeasible.
    def greedy_hints(off_hints=covered_off_hints, use_calendar=calendar_roster):
        if hint_strategy in ('balanced-incumbent-v2', 'balanced-incumbent-v3', ZERO_PROOF_STRATEGY):
            return interval_hints(data, candidates, active, choices, role_choices, xs,
                                  segments, construction_budget,
                                  prefer_qualified_role=hint_strategy in ('balanced-incumbent-v3', ZERO_PROOF_STRATEGY),
                                  covered_off_hints=off_hints, calendar_roster=use_calendar)
        return choose_hints(data, candidates, active, choices, role_choices, xs,
                            hint_strategy, construction_budget)

    using_saved = saved_report is not None and saved_report['status'] == 'VERIFIED'
    if using_saved:
        try:
            initial_hints = candidate_hints(data, saved_assignments, candidates, active, choices,
                                             role_choices, xs, construction_budget)
        except ValueError as error:
            saved_metrics['rejection'] = str(error)
            using_saved = False
    if not using_saved:
        initial_hints = greedy_hints()
    for index, value in initial_hints.items():
        model.add_hint(model.get_int_var_from_proto_index(index), value)
    if prepared_callback is not None:
        prepared_callback(model, objectives, candidates, xs, active, choices, role_choices,
            {'initialHintStrategy': hint_strategy, 'mainPresolveEnabled': main_presolve,
             'commonRunsEnabled': common_runs, 'calendarRosterHintsEnabled': calendar_roster,
             'compactMinutesEnabled': compact_minutes, 'sharedBuildFactsEnabled': shared_build_facts,
             'debugNamesEnabled': debug_names})
    prepared = time.monotonic()
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    # Experimental main-search setting only. The independently checked
    # restricted seed retains its original presolve and all constraints.
    solver.parameters.cp_model_presolve = main_presolve
    best, stages, all_optimal, status_name, first_solution = None, [], True, 'UNKNOWN', None
    incumbent, best_vector, best_values, competing_incumbent = None, None, None, None
    off_hint_attempt = None
    calendar_fallback_attempt = None
    certificate = CandidateCertificate(check_multi)

    def checkpoint():
        if checkpoint_callback is None or best is None:
            return
        report = certificate.lookup(data, best, best_vector)
        if report is None:
            report = certificate.check(data, best, best_vector)
        if (report['status'] not in ('VERIFIED', 'HISTORY_UNVERIFIED')
                or report['objectiveVector'] != best_vector):
            raise ValueError('CHECKPOINT_NOT_VERIFIED')
        # A reference may finish normally, but missing history never becomes
        # a VERIFIED checkpoint that can be recovered after a forced deadline.
        if report['status'] == 'HISTORY_UNVERIFIED':
            return
        checkpoint_callback({'schemaVersion': 'multi-task-v1',
            **{k: data[k] for k in ('tenantId', 'teamId', 'month', 'mode', 'inputVersion',
                                    'settingsVersion', 'jobId', 'attempt')},
            'inputHash': hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
            'solverStatus': 'FEASIBLE', 'validation': report, 'stages': list(stages),
            'assignments': best, 'publication': 'BLOCKED_A1',
            'metrics': {'budgetSeconds': budget_seconds, 'initialHintStrategy': hint_strategy,
                        'coveredOffHintsEnabled': covered_off_hints,
                        'deadlineStopEnabled': deadline_stop,
                        'calendarRosterHintsEnabled': calendar_roster,
                        'calendarFallbackHintsEnabled': calendar_fallback,
                        'calendarFallbackAttempt': calendar_fallback_attempt,
                        'compactMinutesEnabled': compact_minutes,
                        'sharedBuildFactsEnabled': shared_build_facts,
                        'buildVariableLimit': build_variable_limit,
                        'commonRunsEnabled': common_runs,
                        'debugNamesEnabled': debug_names,
                        'searchWorkers': 1, 'seed': 0, 'firstSolutionSeconds': first_solution}})

    def extract(source):
        selected = []
        for key, options in candidates.items():
            for i, (x, c) in enumerate(zip(xs[key], options)):
                if not source.boolean_value(x):
                    continue
                slots = {m - m % data['slotMinutes'] for m in active[key, i]}
                blocks = [{'start': b, 'end': b + data['slotMinutes'], 'taskId': task, 'roleId': None}
                          for b, task_choices in choices[key].items() if b in slots
                          for task, z in task_choices.items() if source.boolean_value(z)]
                role_intervals = []
                for (a, b, task), variables in role_choices.get(key, {}).items():
                    for role, v in variables.items():
                        if role is not None and source.boolean_value(v):
                            role_intervals.append({'start': a, 'end': b, 'roleId': role})
                selected.append({'staffId': key[0], 'date': key[1], 'shift': c, 'blocks': blocks,
                                 'roleIntervals': sorted(role_intervals, key=lambda x: x['start'])})
        return selected

    def try_incumbent(allowance, from_saved=False, from_calendar=False):
        nonlocal best, best_vector, first_solution, status_name, best_values, calendar_fallback_attempt
        seed_solver = cp_model.CpSolver()
        seed_solver.parameters.num_search_workers = 1
        seed_solver.parameters.random_seed = 0
        # This parameter restricts only this feasibility call. It does not add
        # constraints to the original model or to the separate main solver.
        seed_solver.parameters.fix_variables_to_their_hinted_value = True
        seed_solver.parameters.stop_after_first_solution = True
        seed_solver.parameters.max_time_in_seconds = allowance
        if allowance > 0:
            observe('cpStart')
        tick, call_cpu = time.monotonic(), time.process_time()
        stop_metrics = {}
        if deadline_stop:
            seed_status, stop_metrics = solve_with_deadline(seed_solver, model, allowance)
        else:
            seed_status = seed_solver.solve(model) if allowance > 0 else cp_model.UNKNOWN
        elapsed = time.monotonic() - tick
        if allowance > 0:
            observe('cpEnd', seed_solver.status_name(seed_status))
        incumbent = {'scope': 'hint-restricted-feasibility', 'status': seed_solver.status_name(seed_status),
                     'seconds': elapsed, 'budgetSeconds': allowance, 'adopted': False,
                     'solverInvoked': allowance > 0, 'callCpuSeconds': time.process_time() - call_cpu,
                     **stop_metrics, **(solver_timing(seed_solver, elapsed) if allowance > 0 else {
                         'solverWallSeconds': None, 'solverUserSeconds': None,
                         'outsideSolverWallSeconds': None})}
        if from_calendar:
            calendar_fallback_attempt = incumbent
        if seed_status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            found = time.monotonic() - started
            extract_tick = time.monotonic()
            seed = extract(seed_solver)
            incumbent['extractSeconds'] = time.monotonic() - extract_tick
            check_tick = time.monotonic()
            vector = [int(seed_solver.value(o)) for _, o in objectives]
            report = certificate.check(data, seed, vector)
            incumbent.update(validationStatus=report['status'], checkSeconds=time.monotonic() - check_tick)
            agrees = (report['status'] == 'VERIFIED' and vector == report['objectiveVector'])
            if from_saved:
                agrees = agrees and vector == saved_report['objectiveVector']
            if agrees and (best_vector is None or vector <= best_vector):
                best, best_vector, first_solution, status_name = seed, vector, found, 'FEASIBLE'
                transfer_tick = time.monotonic()
                best_values = complete_solution_values(model, seed_solver, bulk_solution_transfer)
                incumbent.update(valueReadSeconds=time.monotonic() - transfer_tick,
                                 solutionValueCount=len(best_values))
                incumbent.update(adopted=True, objectiveVector=vector, foundSeconds=found)
                hint_tick = time.monotonic()
                replace_complete_hints(model, best_values, bulk_solution_transfer)
                incumbent['hintBuildSeconds'] = time.monotonic() - hint_tick
                checkpoint()
            elif agrees:
                incumbent.update(objectiveVector=vector, rejection='NOT_BETTER_THAN_INCUMBENT')
            elif report['status'] == 'VERIFIED':
                incumbent['rejection'] = 'OBJECTIVE_MISMATCH'
            else:
                incumbent['rejection'] = 'CP_RESULT_NOT_VERIFIED'
        # A restricted INFEASIBLE/UNKNOWN is never the original problem's status.
        del seed_solver
        return incumbent

    if hint_strategy in ('balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', ZERO_PROOF_STRATEGY):
        enter_phase('initialFeasibility')
        allowance = initial_allowance(hint_strategy, budget_seconds,
                                      deadline - time.monotonic() - budget_seconds * .1)
        seed_deadline = time.monotonic() + allowance
        incumbent = try_incumbent(allowance, using_saved)
        if covered_off_hints and not using_saved:
            off_hint_attempt = dict(incumbent)
        fallback_off_hint = covered_off_hints and not using_saved and not incumbent['adopted']
        if using_saved:
            saved_metrics.update(incumbent)
            saved_metrics['scope'] = 'advisory-saved-candidate'
        if using_saved or fallback_off_hint:
            # Compare a saved draft with generated starting values, or fall
            # back after an unverified off-hint attempt. Keep the same initial
            # deadline and only retain checked CP-feasible candidates.
            enter_phase('competingHints')
            try:
                use_calendar_fallback = calendar_fallback and fallback_off_hint and best is None
                initial_hints = (greedy_hints(covered_off_hints, True) if use_calendar_fallback else
                                 greedy_hints(False if fallback_off_hint else covered_off_hints))
            except BuildBudgetExceeded:
                if best is None:
                    raise
                competing_incumbent = {'status': 'NOT_RUN', 'adopted': False,
                                       'rejection': 'HINT_BUILD_BUDGET_EXHAUSTED'}
            else:
                model.clear_hints()
                for index, value in initial_hints.items():
                    model.add_hint(model.get_int_var_from_proto_index(index), value)
                enter_phase('competingFeasibility')
                competing_incumbent = try_incumbent(max(0, min(seed_deadline - time.monotonic(),
                    deadline - time.monotonic() - budget_seconds * .1)), from_calendar=use_calendar_fallback)
                if covered_off_hints and using_saved:
                    off_hint_attempt = dict(competing_incumbent)
                if competing_incumbent['adopted'] or not incumbent['adopted']:
                    incumbent = competing_incumbent
                elif best_values is not None:
                    # A failed or worse restricted attempt must not overwrite
                    # the better retained candidate's main-search hint.
                    replace_complete_hints(model, best_values, bulk_solution_transfer)
    enter_phase('search')
    for position, (name, objective) in enumerate(objectives):
        if best_vector is not None:
            # A checked incumbent is a valid upper bound for this stage, after
            # the preceding stages' protective bounds. No seed-only optimum is
            # used as a global bound or proof of optimality.
            # A later stage may improve an unproven higher objective. Protect
            # those actual improved values before proceeding, not merely the
            # older bound recorded when the higher stage originally finished.
            for earlier in range(position + 1):
                model.add(objectives[earlier][1] <= best_vector[earlier])
        if (hint_strategy == ZERO_PROOF_STRATEGY and all_optimal and best_vector is not None
                and name in lower_bounds and best_vector[position] == lower_bounds[name]):
            tick = time.monotonic()
            report = certificate.lookup(data, best, best_vector)
            if report is None:
                report = certificate.check(data, best, best_vector)
            if report['status'] == 'VERIFIED' and report['objectiveVector'] == best_vector:
                stages.append({'name': name, 'status': 'OPTIMAL', 'seconds': time.monotonic() - tick,
                               'value': 0, 'bound': 0, 'solverInvoked': False,
                               'proof': {'kind': 'NONNEGATIVE_ZERO', 'lowerBound': 0,
                                         'independentlyVerified': True}})
                # Earlier stages are proved optimal. Without that prefix we
                # keep normal lower-stage search, which can still improve an
                # unproven higher value under its protective upper bound.
                # The protective upper bound already fixes this nonnegative
                # objective to zero. All original candidates remain available.
                continue
        remaining = deadline - time.monotonic() - budget_seconds * .1
        if remaining <= 0:
            all_optimal = False
            break
        solver.parameters.max_time_in_seconds = remaining
        model.minimize(objective)
        observe('cpStart')
        tick, call_cpu = time.monotonic(), time.process_time()

        class FirstSolution(cp_model.CpSolverSolutionCallback):
            def on_solution_callback(self):
                nonlocal first_solution
                if first_solution is None:
                    first_solution = time.monotonic() - started

        stop_metrics = {}
        if deadline_stop:
            status, stop_metrics = solve_with_deadline(solver, model, remaining, FirstSolution())
        else:
            status = solver.solve(model, FirstSolution())
        elapsed = time.monotonic() - tick
        observe('cpEnd', solver.status_name(status))
        stage = {'name': name, 'status': solver.status_name(status), 'seconds': elapsed,
                 'solverInvoked': True, 'requestedSeconds': remaining,
                 'callCpuSeconds': time.process_time() - call_cpu,
                 **stop_metrics, **solver_timing(solver, elapsed)}
        stages.append(stage)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            status_name = solver.status_name(status) if best is None else 'FEASIBLE'
            all_optimal = False
            break
        value = int(solver.value(objective))
        stage.update(value=value, bound=solver.best_objective_bound)
        vector = [int(solver.value(o)) for _, o in objectives]
        if best_vector is None or vector <= best_vector:
            extract_tick = time.monotonic()
            best = extract(solver)
            stage['extractSeconds'] = time.monotonic() - extract_tick
            best_vector = vector
            transfer_tick = time.monotonic()
            best_values = complete_solution_values(model, solver, bulk_solution_transfer)
            stage.update(valueReadSeconds=time.monotonic() - transfer_tick,
                         solutionValueCount=len(best_values))
        model.add(objective <= value)
        all_optimal &= status == cp_model.OPTIMAL
        status_name = 'FEASIBLE'
        # Give the next stage an incumbent without deleting any candidates.
        hint_tick = time.monotonic()
        replace_complete_hints(model, best_values, bulk_solution_transfer)
        stage['hintBuildSeconds'] = time.monotonic() - hint_tick
        checkpoint()
    if best is not None and all_optimal and len(stages) == len(objectives):
        status_name = 'OPTIMAL'
    checking = time.monotonic()
    enter_phase('finalCheck')
    validation, final_check_kind = {'status': 'NOT_RUN', 'violations': []}, 'NOT_RUN'
    if best is not None:
        validation = certificate.lookup(data, best, best_vector)
        final_check_kind = 'REUSED_VERIFIED' if validation is not None else 'EXECUTED'
        if validation is None:
            validation = certificate.check(data, best, best_vector)
    if best is not None:
        for stage in stages:
            stage['finalValue'] = validation['objective'][stage['name']]
    return {'schemaVersion': 'multi-task-v1', 'tenantId': data['tenantId'], 'teamId': data['teamId'],
            'month': data['month'], 'mode': data['mode'], 'inputVersion': data['inputVersion'],
            'settingsVersion': data['settingsVersion'], 'jobId': data['jobId'], 'attempt': data['attempt'],
            'inputHash': hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
            'solverStatus': status_name, 'validation': validation, 'stages': stages,
            'assignments': best, 'publication': 'BLOCKED_A1',
            'metrics': {'modelEncoding': MODEL_ENCODING,
                        'phaseTimings': phase_metrics(),
                        'roleEncoding': role_encoding,
                        'budgetSeconds': budget_seconds,
                        'mainPresolveEnabled': main_presolve,
                        'tightRunBoundsEnabled': tight_run_bounds,
                        'bulkSolutionTransferEnabled': bulk_solution_transfer,
                        'coveredOffHintsEnabled': covered_off_hints,
                        'deadlineStopEnabled': deadline_stop,
                        'calendarRosterHintsEnabled': calendar_roster,
                        'calendarFallbackHintsEnabled': calendar_fallback,
                        'calendarFallbackAttempt': calendar_fallback_attempt,
                        'compactMinutesEnabled': compact_minutes,
                        'sharedBuildFactsEnabled': shared_build_facts,
                        'buildVariableLimit': build_variable_limit,
                        'commonRunsEnabled': common_runs,
                        'debugNamesEnabled': debug_names,
                        'candidateCatalogHits': catalog.hits if catalog else 0,
                        'invalidTransitionFacts': len(invalid_transition_cache),
                        'minutePoolSize': len(minute_pool),
                        **({'coveredOffHintAttempt': off_hint_attempt} if covered_off_hints else {}),
                        'runDomainSummary': run_domain_summary,
                        'transitionMaskStats': transition_mask_stats,
                        'prepareSeconds': prepared - started, 'checkSeconds': time.monotonic() - checking,
                        'totalSeconds': time.monotonic() - started, 'cpuSeconds': time.process_time() - cpu_started,
                        'firstSolutionSeconds': first_solution, 'variables': len(model.proto.variables),
                        'candidateCertificate': certificate.metrics(),
                        'finalCheckKind': final_check_kind,
                        'constraints': len(model.proto.constraints), 'solverVersion': ortools.__version__,
                        'maxRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024),
                        'initialHintVariables': len(initial_hints),
                        'initialHintStrategy': hint_strategy,
                        'initialIncumbent': incumbent,
                        **({'savedCandidate': saved_metrics} if saved_metrics is not None else {}),
                        **({'competingHintIncumbent': competing_incumbent} if competing_incumbent is not None else {}),
                        'searchWorkers': 1, 'seed': 0, 'intervals': sum(len(v) for v in segments.values())}}
