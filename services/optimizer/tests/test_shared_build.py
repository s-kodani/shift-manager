from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from optimizer.candidate_catalog import CandidateCatalog
from optimizer.contract import dates
from optimizer.multi_model import candidates_multi, solve_multi
from optimizer.operational_fixture import standard_scale_fixture


def test_catalog_preserves_all_days_and_candidates_with_special_cases():
    data,_=standard_scale_fixture(10)
    unchanged=deepcopy(data)
    catalog=CandidateCatalog(data,candidates_multi)
    for s in data['staff']:
        for d in dates(data):
            assert catalog.get(s,d)==candidates_multi(data,s,d)
    assert catalog.hits>0 and data==unchanged
    # Contract/rule changes cannot borrow another person's broader catalogue.
    s=deepcopy(data['staff'][1])
    s['rules'][-1]['dailyMax']=90
    assert catalog.get(s,dates(data)[4])==candidates_multi(data,s,dates(data)[4])
    s['contract']['end']=600
    assert catalog.get(s,dates(data)[4])==candidates_multi(data,s,dates(data)[4])


def test_cached_candidates_cannot_share_mutable_break_arrays():
    data,_=standard_scale_fixture(10)
    catalog=CandidateCatalog(data,candidates_multi)
    staff=data['staff'][1]
    day=dates(data)[4]
    a=catalog.get(staff,day)
    b=catalog.get(staff,day)
    x=next(c for c in a if c and c['break'])
    x['break'][0]+=30
    assert b==candidates_multi(data,staff,day)
    assert catalog.get(staff,day)==b


@pytest.mark.parametrize('priority',['coverage','preference'])
@pytest.mark.parametrize('slot',[30,60])
def test_first_full_proto_and_hints_stay_identical(monkeypatch,priority,slot):
    data,_=standard_scale_fixture(10,slot)
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
    for shared in (False,True):
        traces.append([])
        solve_multi(data,10,hint_strategy='balanced-incumbent-v4',bulk_solution_transfer=True,
                    covered_off_hints=True,calendar_roster=True,compact_minutes=True,
                    shared_build_facts=shared,build_variable_limit=3_500_000)
    assert traces[0] and traces[0]==traces[1]


@pytest.mark.parametrize('limit',[0,999999,3500001,True,1.5])
def test_variable_guard_is_explicit_not_a_product_constraint(limit):
    with pytest.raises(ValueError,match='BUILD_VARIABLE_LIMIT'):
        solve_multi({},build_variable_limit=limit)
