from copy import deepcopy
from itertools import product

import pytest
from ortools.sat.python import cp_model

from optimizer.contract import dates
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi
from test_role_hint import role_tie_fixture
from test_zero_proofs import only_seed


def covered_fixture():
    data = role_tie_fixture()
    data['demand'][0]['direct'] = 2000
    for s in data['staff']:
        s['unavailable'] = [u for u in s['unavailable'] if u['date'] != '2026-10-02']
        s['rules'][0]['monthlyMax'] = 120
    data['staff'][-1]['preferences'] = [{'date': '2026-10-01', 'kind': 'off'}]
    return data


def run(data, enabled=True, role_encoding='implicit-none-v1'):
    return solve_multi(data, 5, hint_strategy='balanced-incumbent-v4',
                       bulk_solution_transfer=True, covered_off_hints=enabled,
                       role_encoding=role_encoding)


def row(result, sid='fictional-002', day='2026-10-01'):
    return next(a for a in result['assignments'] if a['staffId'] == sid and a['date'] == day)


def test_checked_seed_improves_off_preference_without_changing_input_or_coverage(monkeypatch):
    only_seed(monkeypatch)
    data = covered_fixture()
    unchanged = deepcopy(data)
    old, new = run(data, False), run(data)
    assert data == unchanged
    for r in (old, new):
        assert r['validation']['status'] == 'VERIFIED'
        assert r['metrics']['initialIncumbent']['adopted']
        assert check_multi(data, r['assignments'])['objectiveVector'] == r['validation']['objectiveVector']
    assert old['validation']['objectiveVector'][:3] == [0, 0, 1]
    assert new['validation']['objectiveVector'][:3] == [0, 0, 0]
    assert row(new)['shift'] is None and row(new)['blocks'] == []
    assert new['metrics']['coveredOffHintsEnabled'] is True


@pytest.mark.parametrize('encoding', ['explicit-v1', 'implicit-none-v1'])
def test_three_logical_task_choices_stay_one_hot_on_a_requested_off_day(monkeypatch, encoding):
    only_seed(monkeypatch)
    data = covered_fixture()
    for s in data['staff']:
        s['skills'].append({'taskId':'backoffice','level':1,'capacity':1000})
    result = run(data, role_encoding=encoding)
    assert result['validation']['status'] == 'VERIFIED'
    assert result['metrics']['coveredOffHintAttempt']['adopted'] is True
    assert result['validation']['objective']['missed'] == 0


def test_empty_candidate_domain_is_a_full_model_infeasibility_not_a_hint_error():
    data = covered_fixture()
    s = data['staff'][-1]
    s['unavailable'].append({'date':'2026-10-01','start':540,'end':600})
    shift = {'patternId':'short','start':540,'end':600,'breakKind':'auto',
             'break':None,'workedMinutes':60,'cancelled':[]}
    data['locks'] = [{'id':'fictional-contradiction','staffId':s['id'],'date':'2026-10-01',
                      'parts':['pattern','time','break'],'shift':shift}]
    result = run(data)
    assert result['solverStatus'] == 'INFEASIBLE'
    assert result['assignments'] is None and result['validation']['status'] == 'NOT_RUN'


@pytest.mark.parametrize('boundary', ['monthlyMin', 'minDays', 'role', 'general', 'fixed', 'event', 'conflicting'])
def test_off_hint_never_substitutes_for_required_work_or_role_conditions(monkeypatch, boundary):
    only_seed(monkeypatch)
    data = covered_fixture()
    s = data['staff'][-1]
    if boundary == 'monthlyMin':
        s['rules'].append(dict(s['rules'][0], id='fictional-person', monthlyMin=120))
    elif boundary == 'minDays':
        s['rules'][0]['minDays'] = 2
    elif boundary == 'role':
        # Earlier role service is insufficient even though general capacity is met.
        data['roleRequirements'][0]['minimum'] = 3
        s['roleIds'] = ['leader']
    elif boundary == 'general':
        data['demand'][0]['direct'] = 5000
    elif boundary == 'fixed':
        shift = {'patternId':'short','start':540,'end':600,'breakKind':'auto',
                 'break':None,'workedMinutes':60,'cancelled':[]}
        data['locks'] = [{'id':'fictional-lock','staffId':s['id'],'date':'2026-10-01',
                          'parts':['pattern','time','break'],'shift':shift}]
    elif boundary == 'event':
        data['events'] = [{'id':'fictional-training','date':'2026-10-01','start':540,
                           'end':600,'kind':'training','staffIds':[s['id']]}]
    else:
        s['preferences'] += [{'date':'2026-10-01','kind':'work'},
                             {'date':'2026-10-01','kind':'pattern','patternId':'short'}]
    result = run(data)
    assert result['validation']['status'] == 'VERIFIED'
    assert row(result)['shift'] is not None
    assert check_multi(data, result['assignments'])['status'] == 'VERIFIED'


@pytest.mark.parametrize('failure', [cp_model.INFEASIBLE, cp_model.UNKNOWN])
def test_failed_restricted_off_candidate_uses_original_seed_within_the_same_budget(monkeypatch, failure):
    original = cp_model.CpSolver.solve
    restricted = []

    def fail_first(solver, model, *args, **kwargs):
        if solver.parameters.fix_variables_to_their_hinted_value:
            restricted.append(True)
            if len(restricted) == 1:
                return failure
            return original(solver, model, *args, **kwargs)
        return cp_model.UNKNOWN

    monkeypatch.setattr(cp_model.CpSolver, 'solve', fail_first)
    result = run(covered_fixture())
    assert len(restricted) == 2
    assert result['solverStatus'] == 'FEASIBLE'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['metrics']['competingHintIncumbent']['adopted']
    assert result['metrics']['coveredOffHintAttempt']['status'] == cp_model.CpSolver().status_name(failure)
    assert result['metrics']['coveredOffHintAttempt']['adopted'] is False
    assert result['validation']['objectiveVector'][:3] == [0, 0, 1]


@pytest.mark.parametrize('required_days, expected_missed', [(1, 0), (2, 1)])
def test_multiple_requested_off_days_share_the_remaining_monthly_allowance(monkeypatch, required_days, expected_missed):
    only_seed(monkeypatch)
    data = covered_fixture()
    for s in data['staff']:
        s['unavailable'] = [u for u in s['unavailable'] if u['date'] != '2026-10-05']
        s['rules'][0]['monthlyMax'] = 180
    s = data['staff'][-1]
    s['rules'][0]['minDays'] = required_days
    s['preferences'].append({'date':'2026-10-02','kind':'off'})
    result = run(data)
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['objective']['missed'] == expected_missed
    worked = [a['shift']['workedMinutes'] for a in result['assignments']
              if a['staffId'] == s['id'] and a['shift']]
    assert sum(worked) >= 60 and len(worked) >= required_days


@pytest.mark.parametrize('direct', [0, None])
def test_direct_zero_is_not_replaced_by_calculated_demand_in_off_hints(monkeypatch, direct):
    only_seed(monkeypatch)
    data = covered_fixture()
    data['demand'][0]['direct'] = direct
    result = run(data)
    assert result['validation']['status'] == 'VERIFIED'
    assert (row(result)['shift'] is None) == (direct == 0)


def test_later_required_general_workers_do_not_lose_the_role_buffer(monkeypatch):
    only_seed(monkeypatch)
    data = multi_synthetic(4, tiny=True)
    data['patterns'][0]['end'] = 600
    data['transitions'] = []
    for i,s in enumerate(data['staff']):
        s['unavailable'] = [u for u in s['unavailable'] if u['date'] != '2026-10-02']
        s['rules'][0].update(monthlyMin=60, monthlyMax=120)
        s['skills'] = [{'taskId':'phone','level':1,'capacity':2000 if i == 0 else 1000}]
        s['roleIds'] = ['leader'] if i < 2 else []
    data['staff'][1]['preferences'] = [{'date':'2026-10-01','kind':'off'}]
    data['demand'] = [{'date':'2026-10-01','start':540,'end':600,
                      'taskId':'phone','direct':2000,'calculated':999000}]
    data['roleRequirements'] = [{'id':'fictional-role','date':'2026-10-01','start':540,
        'end':600,'taskId':'phone','roleId':'leader','minimum':1,
        'ratioNumerator':1,'ratioDenominator':1,'rounding':'ceil','priority':'first'}]
    old,new = run(data,False),run(data)
    assert old['validation']['status'] == new['validation']['status'] == 'VERIFIED'
    assert new['validation']['objectiveVector'] <= old['validation']['objectiveVector']


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
@pytest.mark.parametrize('slot', [30, 60])
@pytest.mark.parametrize('encoding', ['explicit-v1', 'implicit-none-v1'])
def test_first_full_cp_model_is_unchanged_except_hints_and_matches_independent_enumeration(monkeypatch, priority, slot, encoding):
    data = covered_fixture()
    data['priority'] = priority
    data['slotMinutes'] = slot
    original_demand = data['demand'][0]
    data['demand'] = [dict(original_demand, start=m, end=m+slot) for m in range(540,600,slot)]
    for i, s in enumerate(data['staff']):
        s['unavailable'].append({'date':'2026-10-02','start':0,'end':1440})
        s['rules'][0].update(monthlyMin=60 if i < 2 else 0,
                             monthlyMax=60, minDays=1 if i < 2 else 0)
    original = cp_model.CpSolver.solve
    traces = []

    def observe(solver, model, *args, **kwargs):
        if not traces[-1]:
            clone = model.clone()
            clone.clear_hints()
            traces[-1].append(str(clone.proto))
        return original(solver, model, *args, **kwargs)

    monkeypatch.setattr(cp_model.CpSolver, 'solve', observe)
    # Independent 1-day enumeration of off or one of the actual task/role
    # alternatives; no model candidate generator supplies the oracle.
    options = [(None,None), ('phone','leader'), ('phone',None), ('management',None)]
    vectors = []
    for values in product(options, repeat=3):
        rows = []
        for i,s in enumerate(data['staff']):
            for d in dates(data):
                task,role = values[i] if d.day == 1 else (None,None)
                rows.append({'staffId':s['id'],'date':d.isoformat(),
                    'shift':{'patternId':'short','start':540,'end':600,'breakKind':'auto',
                             'break':None,'workedMinutes':60,'cancelled':[]} if task else None,
                    'blocks':[{'start':m,'end':m+slot,'taskId':task,'roleId':role}
                              for m in range(540,600,slot)] if task else []})
        checked = check_multi(data, rows)
        if checked['status'] == 'VERIFIED':
            vectors.append(checked['objectiveVector'])
    assert vectors
    for enabled in (False, True):
        traces.append([])
        result = run(data, enabled, encoding)
        assert result['solverStatus'] == 'OPTIMAL'
        assert result['validation']['objectiveVector'] == min(vectors)
    assert traces[0] == traces[1]


def test_setting_and_strategy_are_explicit_and_unfinished_model_remains_unknown():
    with pytest.raises(ValueError, match='COVERED_OFF_HINT_SETTING'):
        run(covered_fixture(), 1)
    with pytest.raises(ValueError, match='COVERED_OFF_HINT_REQUIRES_V4'):
        solve_multi(covered_fixture(), covered_off_hints=True)
    result = solve_multi(covered_fixture(), 0, hint_strategy='balanced-incumbent-v4', covered_off_hints=True)
    assert result['solverStatus'] == 'UNKNOWN' and result['validation']['status'] == 'NOT_RUN'
    assert result['metrics']['coveredOffHintsEnabled'] is True
