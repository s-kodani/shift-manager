from copy import deepcopy

import pytest

from optimizer import multi_model
from optimizer.fixtures import multi_synthetic
from optimizer.contract import dates
from optimizer.multi_checker import check_multi
from optimizer.multi_model import initial_allowance, solve_multi
from test_role_hint import role_tie_fixture


def zero_fixture():
    data = multi_synthetic(1)
    data['staff'][0]['rules'][0].update(monthlyMin=0, minDays=0)
    data['staff'][0]['preferences'] = []
    data['staff'][0]['unavailable'] = [{'date': day.isoformat(), 'start': 0, 'end': 1440}
                                     for day in dates(data)]
    data['demand'] = []
    for skill in data['staff'][0]['skills']:
        skill['level'] = 0
    return data


def only_seed(monkeypatch):
    original = multi_model.cp_model.CpSolver.solve
    calls = []

    def timeout_main(solver, *args, **kwargs):
        restricted = solver.parameters.fix_variables_to_their_hinted_value
        calls.append(restricted)
        return original(solver, *args, **kwargs) if restricted else multi_model.cp_model.UNKNOWN

    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', timeout_main)
    return calls


def test_nonnegative_zero_proofs_leave_time_for_the_positive_lower_objective(monkeypatch):
    calls = only_seed(monkeypatch)
    data = role_tie_fixture()
    unchanged = deepcopy(data)
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4')
    assert data == unchanged
    assert result['solverStatus'] == 'FEASIBLE'  # Positive surplus remains unproven.
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['objectiveVector'] == [0, 0, 0, 120000]
    assert calls == [True, False]  # Only the positive surplus needs main search.
    assert [s['name'] for s in result['stages']] == ['roleFirst', 'combined', 'missed', 'surplus']
    for stage in result['stages'][:-1]:
        assert stage['status'] == 'OPTIMAL' and stage['value'] == stage['bound'] == 0
        assert stage['proof'] == {'kind': 'NONNEGATIVE_ZERO', 'lowerBound': 0,
                                  'independentlyVerified': True}
        assert stage['solverInvoked'] is False
    assert result['stages'][-1]['status'] == 'UNKNOWN'
    assert 'proof' not in result['stages'][-1]


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
def test_all_zero_verified_objectives_can_prove_full_optimality_without_main_search(monkeypatch, priority):
    calls = only_seed(monkeypatch)
    data = zero_fixture()
    data['priority'] = priority
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4')
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['status'] == 'VERIFIED'
    assert calls == [True]
    assert all(s['proof']['kind'] == 'NONNEGATIVE_ZERO' for s in result['stages'])
    assert result['validation']['objectiveVector'] == [0, 0, 0]
    assert all(day['shift'] is None for day in result['assignments'])


@pytest.mark.parametrize('rejection', ['INVALID', 'HISTORY_UNVERIFIED', 'OBJECTIVE_MISMATCH'])
def test_rejected_seed_never_becomes_an_analytic_proof(monkeypatch, rejection):
    calls = only_seed(monkeypatch)

    def reject(data, assignments):
        report = check_multi(data, assignments)
        if rejection == 'OBJECTIVE_MISMATCH':
            report['objectiveVector'][0] += 1
        else:
            report['status'] = rejection
        return report

    monkeypatch.setattr(multi_model, 'check_multi', reject)
    result = solve_multi(zero_fixture(), 5, hint_strategy='balanced-incumbent-v4')
    assert result['solverStatus'] == 'UNKNOWN'
    assert result['validation']['status'] == 'NOT_RUN'
    assert not result['metrics']['initialIncumbent']['adopted']
    assert calls == [True, False]
    assert all('proof' not in stage for stage in result['stages'])


def test_zero_without_a_feasible_candidate_does_not_claim_optimality(monkeypatch):
    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', lambda *args, **kwargs: multi_model.cp_model.UNKNOWN)
    result = solve_multi(zero_fixture(), 5, hint_strategy='balanced-incumbent-v4')
    assert result['solverStatus'] == 'UNKNOWN'
    assert result['assignments'] is None
    assert all('proof' not in stage for stage in result['stages'])


def test_unproven_prefix_keeps_lower_stage_search_available(monkeypatch):
    original = multi_model.cp_model.CpSolver.solve
    calls = []

    def unproven(solver, *args, **kwargs):
        if solver.parameters.fix_variables_to_their_hinted_value:
            return multi_model.cp_model.UNKNOWN
        calls.append(True)
        assert original(solver, *args, **kwargs) == multi_model.cp_model.OPTIMAL
        return multi_model.cp_model.FEASIBLE

    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', unproven)
    result = solve_multi(zero_fixture(), 5, hint_strategy='balanced-incumbent-v4')
    assert result['solverStatus'] == 'FEASIBLE'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['objectiveVector'] == [0, 0, 0]
    assert len(calls) == 3
    assert all(stage['status'] == 'FEASIBLE' and 'proof' not in stage for stage in result['stages'])


@pytest.mark.parametrize('rejection', ['INVALID', 'HISTORY_UNVERIFIED', 'OBJECTIVE_MISMATCH'])
def test_a_new_main_candidate_needs_its_own_matching_independent_certificate(monkeypatch, rejection):
    calls = 0

    def selective_check(data, assignments):
        nonlocal calls
        calls += 1
        report = check_multi(data, assignments)
        if calls == 1:
            report['status'] = 'INVALID'  # Do not retain a seed certificate.
        elif calls == 2:
            if rejection == 'OBJECTIVE_MISMATCH':
                report['objectiveVector'][0] += 1
            else:
                report['status'] = rejection
        return report

    monkeypatch.setattr(multi_model, 'check_multi', selective_check)
    result = solve_multi(zero_fixture(), 5, hint_strategy='balanced-incumbent-v4')
    stages = {stage['name']: stage for stage in result['stages']}
    assert not result['metrics']['initialIncumbent']['adopted']
    assert 'proof' not in stages['missed']  # CP search repairs/revalidates it.
    assert stages['surplus']['proof']['independentlyVerified']
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['status'] == 'VERIFIED'


@pytest.mark.parametrize('budget,remaining,expected', [(120, 42, 21), (120, 90, 30), (20, 6, 3), (20, -1, 0)])
def test_seed_allocation_preserves_at_least_half_the_remaining_search_time(budget, remaining, expected):
    assert initial_allowance('balanced-incumbent-v4', budget, remaining) == expected
    assert initial_allowance('balanced-incumbent-v3', budget, remaining) == min(budget * .1, max(0, remaining))
