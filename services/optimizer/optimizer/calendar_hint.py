"""Advisory per-person calendar only; the full CP model/checker still decide.

No task assignment or main constraint is replaced. Identical complete calendar
inputs may reuse indices within this one hint-generation call.
"""
import time
from datetime import timedelta

from ortools.sat.python import cp_model

from .contract import dates
from .minute_set import MinuteSet


def calendar_hints(data, candidates, active, check_budget, seconds=6):
    deadline = time.monotonic() + seconds
    days = dates(data)
    history = {(r['staffId'], r['date']): r['workedMinutes'] for r in data['history']}
    tasks = {t['id']: t for t in data['tasks']}
    demand = {(r['date'], r['start'], r['taskId']): r['direct'] if r['direct'] is not None else r['calculated']
              for r in data['demand']}
    selected, cache, needed_cache = {}, {}, {}
    compact = isinstance(next(iter(active.values()), None), MinuteSet)
    for staff in data['staff']:
        check_budget()
        if time.monotonic() >= deadline:
            break
        sid = staff['id']
        rules = staff['rules']
        limits = (max(r['monthlyMin'] for r in rules), min(r['monthlyMax'] for r in rules),
                  max(r['minDays'] for r in rules), max(r['minOff'] for r in rules),
                  min(r['weeklyMax'] for r in rules), min(r['maxConsecutive'] for r in rules))
        week_start = days[0] - timedelta(days=(days[0].weekday()-data['weekStart']) % 7)
        required = {week_start+timedelta(days=i) for i in range(7) if week_start+timedelta(days=i)<days[0]}
        required |= {days[0]-timedelta(days=i) for i in range(1,limits[5]+1)}
        if any((sid,d.isoformat()) not in history for d in required):
            continue  # Never supply an invented zero for missing prior history.
        eligible = [skill['taskId'] for skill in staff['skills']
                    if skill['level'] >= tasks[skill['taskId']]['minimumLevel']]
        task_key = tuple(t for t in eligible if tasks[t]['kind']=='general')
        if task_key not in needed_cache:
            needed_cache[task_key] = {d.isoformat():set() for d in days}
            for r in data['demand']:
                need = demand[r['date'],r['start'],r['taskId']]
                if r['taskId'] in task_key and need>0:
                    needed_cache[task_key][r['date']].update(range(r['start'],r['end']))
            if compact:
                needed_cache[task_key] = {day:MinuteSet(minutes)
                                          for day,minutes in needed_cache[task_key].items()}
        rows = []
        for day in days:
            key = sid, day.isoformat()
            row = []
            for i,c in enumerate(candidates[key]):
                minutes = active[key,i]
                allowed = not minutes or any(len(minutes)>=tasks[t]['minimumMinutes'] for t in eligible)
                covered = len(minutes & needed_cache[task_key][key[1]])
                row.append((c['workedMinutes'] if c else 0, allowed, covered))
            rows.append(tuple(row))
        outside = tuple((d, n) for (person,d),n in history.items() if person==sid)
        signature = tuple(rows), limits, outside
        if signature not in cache:
            model = cp_model.CpModel()
            model.proto.name = 'advisory-calendar-hint-v1'
            variables, worked, working, coverage = [], [], [], []
            for row in rows:
                x = [model.new_bool_var('option') for _ in row]
                model.add_exactly_one(x)
                for v,(_,allowed,_) in zip(x,row):
                    if not allowed:
                        model.add(v==0)
                variables.append(x)
                worked.append(sum(v*n for v,(n,_,_) in zip(x,row)))
                working.append(sum(v for v,(n,_,_) in zip(x,row) if n>0))
                coverage.extend(v*n for v,(_,_,n) in zip(x,row))
            minimum, maximum, min_days, min_off, weekly, consecutive = limits
            model.add(sum(worked)>=minimum)
            model.add(sum(worked)<=maximum)
            model.add(sum(working)>=min_days)
            model.add(sum(working)<=len(days)-min_off)
            weeks = {}
            for i,d in enumerate(days):
                start=d-timedelta(days=(d.weekday()-data['weekStart'])%7)
                weeks.setdefault(start,[]).append(i)
            for start,indices in weeks.items():
                prior=sum(history.get((sid,(start+timedelta(days=i)).isoformat()),0)
                          for i in range(7) if start+timedelta(days=i) not in days)
                model.add(sum(worked[i] for i in indices)+prior<=weekly)
            ends=days+[days[-1]+timedelta(days=i) for i in range(1,consecutive+1)
                       if (sid,(days[-1]+timedelta(days=i)).isoformat()) in history]
            for end in ends:
                window={end-timedelta(days=i) for i in range(consecutive+1)}
                known=sum(history.get((sid,d.isoformat()),0)>0 for d in window if d not in days)
                model.add(sum(working[i] for i,d in enumerate(days) if d in window)+known<=consecutive)
            # A single heuristic score, never the product's objective order or
            # a bound/proof for the full task/role model.
            model.maximize(sum(coverage))
            solver=cp_model.CpSolver()
            solver.parameters.num_search_workers=1
            solver.parameters.random_seed=0
            solver.parameters.max_time_in_seconds=max(0,min(.25,deadline-time.monotonic()))
            status=solver.solve(model)
            cache[signature]=([next(i for i,v in enumerate(row) if solver.boolean_value(v))
                               for row in variables] if status in (cp_model.OPTIMAL,cp_model.FEASIBLE) else None)
        if cache[signature] is not None:
            for d,index in zip(days,cache[signature]):
                selected[sid,d.isoformat()]=index
    return selected
