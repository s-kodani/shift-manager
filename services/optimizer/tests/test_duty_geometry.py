from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from optimizer import multi_model
from optimizer.duty_geometry import duty_geometry
from optimizer.minute_set import MinuteSet
from optimizer.operational_fixture import standard_scale_fixture


@pytest.mark.parametrize('slot',[30,60])
def test_exact_geometry_matches_original_minute_enumeration(slot):
    sets=[MinuteSet(),MinuteSet(range(547,571)),MinuteSet([570,599,600,659]),
          MinuteSet(range(600,630)),MinuteSet(range(547,571))]
    cache={}
    result=duty_geometry(sets,slot,cache,multi_model.active_slot_geometry)
    possible=set().union(*sets)
    slots=sorted({m-m%slot for m in possible})
    assert result.possible==possible and list(result.slots)==slots
    for b in slots:
        amounts=tuple(sum(m-m%slot==b for m in minutes) for minutes in sets)
        assert result.amounts[b]==amounts
        assert result.present[b]==tuple(i for i,a in enumerate(amounts) if a)
        assert result.seen[b]==tuple(i for i,s in enumerate(sets) if any(m<b+slot for m in s))
    assert len(cache)==4
    with pytest.raises(TypeError):
        result.amounts[slots[0]]=(0,)
    with pytest.raises(TypeError):
        result.geometry[1][slots[0]]=(0,None)
    assert duty_geometry(list(reversed(sets)),slot,cache,multi_model.active_slot_geometry).amounts != result.amounts
    assert duty_geometry([],slot,cache,multi_model.active_slot_geometry).slots==()


@pytest.mark.parametrize('slot',[30,60])
@pytest.mark.parametrize('priority',['coverage','preference'])
@pytest.mark.parametrize('common',[False,True])
def test_shared_day_facts_leave_full_proto_and_hints_identical(monkeypatch,slot,priority,common):
    data,_=standard_scale_fixture(10,slot)
    data['priority']=priority
    unchanged=deepcopy(data)
    actual=multi_model.duty_geometry
    traces=[]
    def observe(solver,model,*a,**kw):
        traces.append(str(model.proto))
        return cp_model.UNKNOWN
    monkeypatch.setattr(cp_model.CpSolver,'solve',observe)
    groups=[]
    for cached in (False,True):
        traces=[]
        monkeypatch.setattr(multi_model,'duty_geometry',actual if cached else lambda *a:None)
        multi_model.solve_multi(data,15,hint_strategy='balanced-incumbent-v4',
            compact_minutes=True,shared_build_facts=True,common_runs=common,build_variable_limit=3500000)
        groups.append(traces[0])
    assert groups[0]==groups[1] and data==unchanged
