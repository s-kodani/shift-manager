"""CP-SAT model for one qualified task; no roles, locks, cancellation or events yet.

Unsupported fields are rejected by the versioned contract, never silently omitted.
"""
import hashlib
import json
import resource
import sys
import time
from datetime import timedelta

import ortools
from ortools.sat.python import cp_model

from .contract import dates, validate_input
from .checker import check


def candidates(data, staff, day):
    result = [None]
    if day.weekday() not in staff['contract']['weekdays']:
        return result
    rule = data['breakRule']
    for p in data['patterns']:
        if p['start'] < staff['contract']['start'] or p['end'] > staff['contract']['end']:
            continue
        # Availability applies to the entire attendance interval, including breaks.
        if any(u['date'] == day.isoformat() and u['start'] < p['end'] and p['start'] < u['end']
               for u in staff['unavailable']):
            continue
        if p['breakKind'] == 'fixed':
            breaks = [p['fixedBreak']]
        else:
            breaks = [None] + [[a, a + rule['requiredMinutes']]
                              for a in range(p['start'], p['end'], 30)
                              if rule['requiredMinutes'] > 0 and a + rule['requiredMinutes'] <= p['end']]
        for b in breaks:
            length = b[1] - b[0] if b else 0
            worked = p['end'] - p['start'] - length
            basis = worked if rule['basis'] == 'worked' else p['end'] - p['start']
            need = rule['requiredMinutes'] if basis > rule['threshold'] else 0
            if (p['breakKind'] == 'auto' and length != need) or length < need:
                continue
            if b and (b[0] < p['start'] + rule['afterStart'] or b[1] > p['end'] - rule['beforeEnd']):
                continue
            if any(worked > r['dailyMax'] for r in staff['rules']):
                continue
            result.append({'patternId': p['id'], 'start': p['start'], 'end': p['end'],
                           'breakKind': p['breakKind'], 'break': b, 'workedMinutes': worked})
    return result


def missed(staff, day, candidate):
    total = 0
    for p in staff['preferences']:
        if p['date'] != day.isoformat():
            continue
        work = bool(candidate and candidate['workedMinutes'] > 0)
        satisfied = {'work': work, 'off': not work}.get(p['kind'], False)
        if p['kind'] == 'pattern':
            satisfied = work and candidate['patternId'] == p['patternId']
        if p['kind'] == 'window':
            satisfied = work and p['start'] <= candidate['start'] and candidate['end'] <= p['end']
        total += int(not satisfied)
    return total


def solve(data, budget_seconds=10):
    started = time.monotonic()
    cpu_started = time.process_time()
    deadline = started + budget_seconds
    validate_input(data)
    model = cp_model.CpModel()
    ds = dates(data)
    options, xs, hs, ws = {}, {}, {}, {}
    prefs = []
    history = {(h['staffId'], h['date']): h['workedMinutes'] for h in data['history']}
    for s in data['staff']:
        for d in ds:
            k = (s['id'], d.isoformat())
            options[k] = candidates(data, s, d)
            xs[k] = [model.new_bool_var(f'{s["id"]}:{d}:{i}') for i in range(len(options[k]))]
            model.add_exactly_one(xs[k])
            hs[k] = sum(x * (c['workedMinutes'] if c else 0) for x, c in zip(xs[k], options[k]))
            ws[k] = sum(x for x, c in zip(xs[k], options[k]) if c and c['workedMinutes'] > 0)
            prefs.extend(x * missed(s, d, c) for x, c in zip(xs[k], options[k]))
        for r in s['rules']:
            model.add(sum(hs[s['id'], d.isoformat()] for d in ds) >= r['monthlyMin'])
            model.add(sum(hs[s['id'], d.isoformat()] for d in ds) <= r['monthlyMax'])
            model.add(sum(ws[s['id'], d.isoformat()] for d in ds) >= r['minDays'])
            model.add(sum(ws[s['id'], d.isoformat()] for d in ds) <= len(ds) - r['minOff'])
            weeks = {}
            for d in ds:
                week = d - timedelta(days=(d.weekday() - data['weekStart']) % 7)
                weeks.setdefault(week, []).append(d)
            for week, members in weeks.items():
                outside = sum(history.get((s['id'], (week + timedelta(days=n)).isoformat()), 0)
                              for n in range(7) if week + timedelta(days=n) not in ds)
                model.add(sum(hs[s['id'], d.isoformat()] for d in members) + outside <= r['weeklyMax'])
            cmax = r['maxConsecutive']
            for end in ds:
                window = [end - timedelta(days=n) for n in range(cmax + 1)]
                known = sum(int(history.get((s['id'], d.isoformat()), 0) > 0) for d in window if d not in ds)
                model.add(sum(ws[s['id'], d.isoformat()] for d in window if d in ds) + known <= cmax)
    shortage, surplus = [], []
    # All potential breaks/attendance are 30-aligned. Compressed 30-minute segments
    # are exact for this single-task profile; checker uses independent minute sets.
    demand = {(d['date'], d['start']): d['direct'] if d['direct'] is not None else d['calculated']
              for d in data['demand']}
    max_capacity = sum(s['capacity'] for s in data['staff'])
    for d in ds:
        for m in range(0, 1440, 30):
            capacity = []
            for s in data['staff']:
                k = (s['id'], d.isoformat())
                for x, c in zip(xs[k], options[k]):
                    if c and c['start'] <= m < c['end'] and not (c['break'] and c['break'][0] <= m < c['break'][1]):
                        capacity.append(x * s['capacity'])
            need = demand.get((d.isoformat(), m - m % data['slotMinutes']), 0)
            if not capacity and not need:
                continue
            lo = model.new_int_var(0, max(need, max_capacity), f'd:{d}:{m}')
            hi = model.new_int_var(0, max(need, max_capacity), f'o:{d}:{m}')
            model.add_max_equality(lo, [0, need - sum(capacity)])
            model.add_max_equality(hi, [0, sum(capacity) - need])
            shortage.append(lo * 30)
            surplus.append(hi * 30)
    objectives = [('shortage', sum(shortage)), ('missed', sum(prefs)), ('surplus', sum(surplus))]
    if data['priority'] == 'preference':
        objectives[0], objectives[1] = objectives[1], objectives[0]
    prepared = time.monotonic()
    stages, best, all_optimal, final_status = [], None, True, 'UNKNOWN'
    first_solution = None
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    for name, objective in objectives:
        # Reserve 10% for checking, bounded by the overall PoC time budget.
        remaining = deadline - time.monotonic() - budget_seconds * .1
        if remaining <= 0:
            all_optimal = False
            break
        solver.parameters.max_time_in_seconds = remaining
        model.minimize(objective)
        tick = time.monotonic()
        class FirstSolution(cp_model.CpSolverSolutionCallback):
            def on_solution_callback(self):
                nonlocal first_solution
                if first_solution is None:
                    first_solution = time.monotonic() - started

        status = solver.solve(model, FirstSolution())
        label = solver.status_name(status)
        stage = {'name': name, 'status': label, 'seconds': time.monotonic() - tick}
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            final_status = label if best is None else 'FEASIBLE'
            all_optimal = False
            stages.append(stage)
            break
        value = int(solver.value(objective))
        stage.update(value=value, bound=solver.best_objective_bound)
        stages.append(stage)
        best = [{'staffId': s['id'], 'date': d.isoformat(), 'shift': c}
                for s in data['staff'] for d in ds
                for x, c in zip(xs[s['id'], d.isoformat()], options[s['id'], d.isoformat()])
                if solver.boolean_value(x)]
        # Preserve the attained upper bound; an unproven earlier value may improve.
        model.add(objective <= value)
        all_optimal &= status == cp_model.OPTIMAL
        final_status = 'FEASIBLE'
    if best is not None and all_optimal and len(stages) == len(objectives):
        final_status = 'OPTIMAL'
    checking = time.monotonic()
    validation = check(data, best) if best is not None else {'status': 'NOT_RUN', 'violations': []}
    return {'schemaVersion': 'single-task-v0', 'tenantId': data['tenantId'], 'teamId': data['teamId'],
            'inputVersion': data['inputVersion'], 'settingsVersion': data['settingsVersion'],
            'jobId': data['jobId'], 'attempt': data['attempt'],
            'inputHash': hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
            'solverStatus': final_status, 'validation': validation, 'stages': stages,
            'assignments': best, 'publication': 'BLOCKED_POC',
            'metrics': {'prepareSeconds': prepared - started, 'checkSeconds': time.monotonic() - checking,
                        'totalSeconds': time.monotonic() - started,
                        'cpuSeconds': time.process_time() - cpu_started,
                        'firstSolutionSeconds': first_solution,
                        'variables': len(model.proto.variables), 'constraints': len(model.proto.constraints),
                        'maxRssNative': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                        'maxRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024),
                        'solverVersion': ortools.__version__, 'searchWorkers': 1, 'seed': 0}}
