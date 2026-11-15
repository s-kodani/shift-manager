from itertools import product
from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from optimizer.common_run import add_common_runs
from optimizer.fixtures import multi_synthetic
from optimizer.multi_model import solve_multi
from optimizer.multi_checker import check_multi
from test_multi_optimizer import assignments, block
from test_saved_candidate import source


def oracle(sequence, lengths, minima):
    cumulative=lengths[0]
    seen=lengths[0]>0
    for i in range(1,len(sequence)):
        if lengths[i]==0 and sequence[i]!=sequence[i-1]:
            return False
        if sequence[i]!=sequence[i-1]:
            if seen and cumulative<minima[sequence[i-1]]:
                return False
            cumulative=lengths[i]
        else:
            cumulative+=lengths[i]
        seen |= lengths[i]>0
    return not seen or cumulative>=minima[sequence[-1]]


@pytest.mark.parametrize('minima',[(0,0,0),(7,30,60),(30,30,30),(0,60,0)])
def test_common_run_matches_literal_small_enumeration(minima):
    for sequence in product(range(3),repeat=3):
        for amounts in product((0,7,30),repeat=3):
            model=cp_model.CpModel()
            choices={}
            for n in range(3):
                for t in range(3):
                    v=model.new_bool_var(f't:{n}:{t}')
                    model.add(v==int(sequence[n]==t))
                    choices[n,t]=v
                if n and amounts[n]==0:
                    for t in range(3):
                        model.add(choices[n,t]==choices[n-1,t])
            seen={n:model.new_constant(int(any(amounts[:n+1]))) for n in range(3)}
            add_common_runs(model,[0,1,2],choices,dict(enumerate(amounts)),seen,
                            dict(enumerate(minima)),90,'fictional')
            solver=cp_model.CpSolver()
            solver.parameters.num_search_workers=1
            assert (solver.solve(model) in (cp_model.OPTIMAL,cp_model.FEASIBLE)) == oracle(sequence,amounts,minima)


@pytest.mark.parametrize('priority',['coverage','preference'])
@pytest.mark.parametrize('slot',[30,60])
@pytest.mark.parametrize('minimum',[0,30,60])
def test_joint_objective_matches_independent_enumeration(priority,slot,minimum):
    data=multi_synthetic(1,slot,tiny=True)
    data['priority']=priority
    data['tasks'][1]['minimumMinutes']=minimum
    vectors=[]
    for values in product(('phone','backoffice'),repeat=120//slot):
        rows=assignments(data,[block(540+i*slot,540+(i+1)*slot,t) for i,t in enumerate(values)])
        checked=check_multi(data,rows)
        if checked['status']=='VERIFIED':
            vectors.append(checked['objectiveVector'])
    assert vectors
    unchanged=deepcopy(data)
    results=[solve_multi(data,5,common_runs=enabled) for enabled in (False,True)]
    assert data==unchanged
    assert all(r['solverStatus']=='OPTIMAL' and r['validation']['objectiveVector']==min(vectors) for r in results)
    assert all(check_multi(data,r['assignments'])['status']=='VERIFIED' for r in results)


@pytest.mark.parametrize('kind',['training','meeting'])
def test_interruption_bridges_same_task_and_excludes_its_minutes(kind):
    data=multi_synthetic(1,30,tiny=True)
    data['events']=[{'id':'fictional-event','date':'2026-10-01','start':570,'end':600,
                     'kind':kind,'staffIds':[data['staff'][0]['id']]}]
    result=[solve_multi(data,5,common_runs=x) for x in (False,True)]
    assert result[0]['validation']['objectiveVector']==result[1]['validation']['objectiveVector']
    assert all(check_multi(data,r['assignments'])['status']=='VERIFIED' for r in result)


@pytest.mark.parametrize('saved',[False,True])
def test_roles_and_checked_saved_candidate_remain_valid(saved):
    data,candidate=source()
    results=[solve_multi(data,5,hint_strategy='balanced-incumbent-v4',bulk_solution_transfer=True,
                        saved_assignments=candidate if saved else None,common_runs=x) for x in (False,True)]
    assert results[0]['validation']['objectiveVector']==results[1]['validation']['objectiveVector']
    assert all(check_multi(data,r['assignments'])['status']=='VERIFIED' for r in results)


@pytest.mark.parametrize('priority',['coverage','preference'])
def test_five_task_oracle_keeps_all_assignments_and_reduces_variables(priority):
    data=multi_synthetic(1,30,tiny=True)
    data['priority']=priority
    for name,minimum in [('management',0),('review',30),('supervision',60)]:
        data['tasks'].append({'id':name,'kind':'dedicated','minimumLevel':1,'minimumMinutes':minimum})
        data['staff'][0]['skills'].append({'taskId':name,'level':1,'capacity':0})
    vectors=[]
    names=[t['id'] for t in data['tasks']]
    for sequence in product(names,repeat=4):
        checked=check_multi(data,assignments(data,[block(540+30*i,570+30*i,t) for i,t in enumerate(sequence)]))
        if checked['status']=='VERIFIED':
            vectors.append(checked['objectiveVector'])
    assert vectors
    results=[solve_multi(data,5,common_runs=x) for x in (False,True)]
    assert all(r['solverStatus']=='OPTIMAL' and r['validation']['objectiveVector']==min(vectors) for r in results)
    assert results[1]['metrics']['variables']<results[0]['metrics']['variables']


def test_published_cancellation_retains_fixed_time_and_break():
    data=multi_synthetic(1,30,tiny=True)
    baseline=solve_multi(data,3)
    assert baseline['validation']['status']=='VERIFIED'
    data['mode']='reallocation'
    data['published']=[{'staffId':a['staffId'],'date':a['date'],'shift':deepcopy(a['shift'])}
                       for a in baseline['assignments']]
    shift=next(a['shift'] for a in data['published'] if a['shift'])
    shift['cancelled']=[[540,570]]
    shift['workedMinutes']=90
    data['staff'][0]['rules'][0].update(monthlyMin=90,monthlyMax=90)
    results=[solve_multi(data,3,common_runs=x) for x in (False,True)]
    assert results[0]['validation']['objectiveVector']==results[1]['validation']['objectiveVector']
    assert all([a['shift'] for a in r['assignments']]==[a['shift'] for a in data['published']] for r in results)
    assert all(check_multi(data,r['assignments'])['status']=='VERIFIED' for r in results)
