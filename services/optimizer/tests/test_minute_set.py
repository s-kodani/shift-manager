from itertools import combinations, product
from copy import deepcopy
import sys

import pytest
from ortools.sat.python import cp_model

from optimizer.minute_set import MinuteSet
from optimizer.multi_model import active_minutes, active_slot_geometry, solve_multi
from optimizer.multi_checker import check_multi
from optimizer.fixtures import multi_synthetic
from optimizer.operational_fixture import standard_scale_fixture
from test_saved_candidate import source


def test_exact_set_algebra_for_fragmented_minutes_and_both_operands():
    points=[0,7,29,30,59,60,1439]
    subsets=[set(c) for n in range(len(points)+1) for c in combinations(points,n)]
    for a,b in product(subsets,repeat=2):
        x,y=MinuteSet(a),MinuteSet(b)
        assert x==a and a==x and len(x)==len(a)
        assert set(x&y)==a&b and set(x|y)==a|b and set(x-y)==a-b
        assert set(x&b)==a&b and set(b&x)==a&b
        assert (x<=b)==(a<=b) and (b<=x)==(b<=a)
        assert set(set().union(x,y))==a|b
        assert set(x)==a and set(y)==b
    assert 7.0 in MinuteSet([7])
    assert 7.5 not in MinuteSet([7])


@pytest.mark.parametrize('slot',[30,60])
def test_geometry_and_preparation_are_exact_for_every_subset(slot):
    points=[0,7,10,29,30,31,59,60,1439]
    for n in range(len(points)+1):
        for c in combinations(points,n):
            plain=set(c)
            compact=MinuteSet(c)
            assert active_slot_geometry(compact,slot)==active_slot_geometry(plain,slot)
            for start in (0,30,60,1430):
                for length in (0,1,7,10,30):
                    interval=set(range(start,start+length))
                    assert (interval<=compact)==(interval<=plain)


def test_masks_preserve_exact_break_cancel_event_subtraction():
    data=multi_synthetic(1,tiny=True)
    sid=data['staff'][0]['id']
    data['events']=[{'date':'2026-10-01','start':563,'end':577,'staffIds':[sid]}]
    shift={'start':540,'end':690,'break':[600,630],'cancelled':[[583,597],[675,682]]}
    a=active_minutes(data,sid,'2026-10-01',shift)
    b=active_minutes(data,sid,'2026-10-01',shift,compact=True)
    assert set(b)==a and len(b)==len(a)
    assert b==MinuteSet.interval(540,690)-MinuteSet.interval(600,630)-MinuteSet.interval(563,577)-MinuteSet.interval(583,597)-MinuteSet.interval(675,682)
    assert not active_minutes(data,sid,'2026-10-01',None,compact=True)


@pytest.mark.parametrize('priority',['coverage','preference'])
@pytest.mark.parametrize('slot',[30,60])
@pytest.mark.parametrize('saved',[False,True])
def test_full_cp_proto_and_checked_quality_remain_identical(monkeypatch,priority,slot,saved):
    data,candidate=source()
    data['priority']=priority
    data['slotMinutes']=slot
    data['demand']=[dict(row,start=m,end=m+slot) for row in data['demand']
                    for m in range(row['start'],row['end'],slot)]
    for row in candidate:
        row['blocks']=[dict(b,start=m,end=m+slot) for b in row['blocks']
                       for m in range(b['start'],b['end'],slot)]
    original=cp_model.CpSolver.solve
    traces=[]
    def observe(solver,model,*args,**kwargs):
        traces[-1].append(str(model.proto))
        return original(solver,model,*args,**kwargs)
    monkeypatch.setattr(cp_model.CpSolver,'solve',observe)
    results=[]
    untouched=deepcopy(data)
    for enabled in (False,True):
        traces.append([])
        results.append(solve_multi(data,5,hint_strategy='balanced-incumbent-v4',
            bulk_solution_transfer=True,covered_off_hints=True,compact_minutes=enabled,
            saved_assignments=candidate if saved else None))
    assert data==untouched and traces[0]==traces[1]
    assert results[0]['validation']['objectiveVector']==results[1]['validation']['objectiveVector']
    assert all(check_multi(data,r['assignments'])['status']=='VERIFIED' for r in results)


def test_storage_is_immutable_and_smaller_without_rounding():
    mask=MinuteSet.interval(0,1440)
    assert set(mask)==set(range(1440))
    assert sys.getsizeof(mask)+sys.getsizeof(mask.bits)<sys.getsizeof(set(range(1440)))
    with pytest.raises(AttributeError):
        mask._bits=0
    with pytest.raises(ValueError):
        MinuteSet([1.5])
    with pytest.raises(ValueError):
        MinuteSet.interval(-1,30)
    with pytest.raises(ValueError):
        MinuteSet.from_bits(1<<1440)


@pytest.mark.parametrize('case',['preparation','event','cancelled-reallocation'])
def test_exact_full_proto_with_preparation_events_and_published_cancellation(monkeypatch,case):
    data=multi_synthetic(1,tiny=True)
    data['transitions'][0]['minutes']=7
    if case=='event':
        data['events']=[{'id':'fictional-meeting','date':'2026-10-01','start':570,
                         'end':600,'kind':'meeting','staffIds':[data['staff'][0]['id']]}]
    if case=='cancelled-reallocation':
        first=solve_multi(data,3)
        assert first['validation']['status']=='VERIFIED'
        data['mode']='reallocation'
        data['published']=[{'staffId':r['staffId'],'date':r['date'],'shift':deepcopy(r['shift'])}
                           for r in first['assignments']]
        c=next(r['shift'] for r in data['published'] if r['shift'])
        c['cancelled']=[[540,570]]
        c['workedMinutes']=90
        data['staff'][0]['rules'][0].update(monthlyMin=90,monthlyMax=90)
    original=cp_model.CpSolver.solve
    traces=[]
    def observe(solver,model,*a,**kw):
        traces[-1].append(str(model.proto))
        return original(solver,model,*a,**kw)
    monkeypatch.setattr(cp_model.CpSolver,'solve',observe)
    result=[]
    for compact in (False,True):
        traces.append([])
        result.append(solve_multi(data,3,compact_minutes=compact))
    assert traces[0]==traces[1]
    assert result[0]['validation']['objectiveVector']==result[1]['validation']['objectiveVector']
    assert all(check_multi(data,r['assignments'])['status']=='VERIFIED' for r in result)


@pytest.mark.parametrize('priority',['coverage','preference'])
def test_standard_five_task_ten_pattern_initial_proto_including_hints_is_identical(monkeypatch,priority):
    data,_=standard_scale_fixture(10)
    data['priority']=priority
    original=cp_model.CpSolver.solve
    traces=[]
    def observe(solver,model,*a,**kw):
        if model.proto.name=='advisory-calendar-hint-v1':
            return original(solver,model,*a,**kw)
        if not traces[-1]:
            traces[-1].append(str(model.proto))
        return cp_model.UNKNOWN
    monkeypatch.setattr(cp_model.CpSolver,'solve',observe)
    unchanged=deepcopy(data)
    for compact in (False,True):
        traces.append([])
        solve_multi(data,10,hint_strategy='balanced-incumbent-v4',bulk_solution_transfer=True,
                    covered_off_hints=True,calendar_roster=True,compact_minutes=compact)
    assert traces[0] and traces[0]==traces[1] and data==unchanged
