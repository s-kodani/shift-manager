from copy import deepcopy

import pytest

from ortools.sat.python import cp_model

from optimizer.calendar_hint import calendar_hints
from optimizer.contract import dates
from optimizer.multi_checker import check_multi
from optimizer.multi_model import active_minutes, candidates_multi, solve_multi
from optimizer.operational_fixture import standard_scale_fixture


def test_advisory_calendar_keeps_week_month_minima_without_using_reference():
    data, _ = standard_scale_fixture(10)
    untouched = deepcopy(data)
    candidates = {(s['id'],d.isoformat()):candidates_multi(data,s,d)
                  for s in data['staff'] for d in dates(data)}
    active = {(key,i):active_minutes(data,key[0],key[1],c)
              for key,options in candidates.items() for i,c in enumerate(options)}
    chosen = calendar_hints(data,candidates,active,lambda:None)
    assert len(chosen) == 310
    rows=[]
    for key,options in candidates.items():
        c=options[chosen[key]]
        minutes=active[key,chosen[key]]
        rows.append({'staffId':key[0],'date':key[1],'shift':c,
            'blocks':[{'start':m,'end':m+30,'taskId':'phone','roleId':None}
                      for m in range(540,870,30) if minutes & set(range(m,m+30))],
            'roleIntervals':[]})
    assert check_multi(data,rows)['status'] == 'VERIFIED'
    assert data == untouched


def test_longest_daily_hint_really_violates_week_and_month_limits():
    data,_=standard_scale_fixture(10)
    rows=[]
    for s in data['staff']:
        for d in dates(data):
            c=max(candidates_multi(data,s,d),key=lambda x:x['workedMinutes'] if x else 0)
            minutes=active_minutes(data,s['id'],d.isoformat(),c)
            rows.append({'staffId':s['id'],'date':d.isoformat(),'shift':c,
                'blocks':[{'start':m,'end':m+30,'taskId':'phone','roleId':None}
                          for m in range(540,870,30) if minutes & set(range(m,m+30))],
                'roleIntervals':[]})
    report=check_multi(data,rows)
    assert report['status']=='INVALID'
    assert any('MONTHLY_HOURS' in x for x in report['violations'])
    assert any('WEEKLY_HOURS' in x for x in report['violations'])


@pytest.mark.parametrize('priority', ['coverage','preference'])
def test_calendar_candidate_does_not_change_the_full_cp_model(monkeypatch, priority):
    data,_=standard_scale_fixture(10)
    data['priority']=priority
    original=cp_model.CpSolver.solve
    traces=[]
    def observe(solver,model,*a,**kw):
        if model.proto.name=='advisory-calendar-hint-v1':
            return original(solver,model,*a,**kw)
        if not traces[-1]:
            clone=model.clone()
            clone.clear_hints()
            traces[-1].append(str(clone.proto))
        return cp_model.UNKNOWN
    monkeypatch.setattr(cp_model.CpSolver,'solve',observe)
    for enabled in (False,True):
        traces.append([])
        solve_multi(data,10,hint_strategy='balanced-incumbent-v4',bulk_solution_transfer=True,
                    covered_off_hints=True,calendar_roster=enabled)
    assert traces[0] and traces[0]==traces[1]


def test_stricter_person_rule_and_fixed_event_are_preserved():
    data,_=standard_scale_fixture(10)
    data['staff'][0]['rules'][-1].update(monthlyMin=2400,monthlyMax=2550,
                                        minDays=16,minOff=13,weeklyMax=600,maxConsecutive=4)
    candidates={(s['id'],d.isoformat()):candidates_multi(data,s,d)
                for s in data['staff'] for d in dates(data)}
    active={(key,i):active_minutes(data,key[0],key[1],c)
            for key,options in candidates.items() for i,c in enumerate(options)}
    chosen=calendar_hints(data,candidates,active,lambda:None)
    sid=data['staff'][0]['id']
    shifts={d.isoformat():candidates[sid,d.isoformat()][chosen[sid,d.isoformat()]] for d in dates(data)}
    assert 2400<=sum(c['workedMinutes'] if c else 0 for c in shifts.values())<=2550
    assert 16<=sum(bool(c and c['workedMinutes']) for c in shifts.values())<=18
    assert shifts['2026-10-01'] is not None
    assert shifts['2026-10-02']['patternId']=='long'
    rows=[]
    for key,options in candidates.items():
        c=options[chosen[key]]
        minutes=active[key,chosen[key]]
        rows.append({'staffId':key[0],'date':key[1],'shift':c,
            'blocks':[{'start':m,'end':m+30,'taskId':'phone','roleId':None}
                      for m in range(540,870,30) if minutes & set(range(m,m+30))],
            'roleIntervals':[]})
    assert check_multi(data,rows)['status']=='VERIFIED'


def test_missing_history_or_zero_hint_budget_cannot_invent_a_calendar(monkeypatch):
    data,_=standard_scale_fixture(10)
    candidates={(s['id'],d.isoformat()):candidates_multi(data,s,d)
                for s in data['staff'] for d in dates(data)}
    active={(key,i):active_minutes(data,key[0],key[1],c)
            for key,options in candidates.items() for i,c in enumerate(options)}
    monkeypatch.setattr(cp_model.CpSolver,'solve',lambda *a,**k:pytest.fail('NO_CP_CALL_EXPECTED'))
    assert calendar_hints(data,candidates,active,lambda:None,seconds=0)=={}
    data['history']=[]
    assert calendar_hints(data,candidates,active,lambda:None)=={}
