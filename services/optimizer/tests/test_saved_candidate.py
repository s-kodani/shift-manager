from copy import deepcopy
from itertools import product

import pytest

from optimizer import multi_model
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi
from optimizer.operational_fixture import operational_fixture
from test_role_hint import assignment, role_tie_fixture
from test_zero_proofs import only_seed


def source():
    data = role_tie_fixture()
    return data, assignment(data, [('phone', 'leader'), ('phone', 'leader'), ('phone', None)])


@pytest.mark.parametrize('encoding', ['explicit-v1', 'implicit-none-v1'])
def test_checked_block_roles_become_cp_proved_incumbent_even_if_main_times_out(monkeypatch, encoding):
    data, candidate = source()
    unchanged = deepcopy((data, candidate))
    calls = only_seed(monkeypatch)
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4',
                         role_encoding=encoding, saved_assignments=candidate)
    assert (data, candidate) == unchanged
    assert result['solverStatus'] == 'FEASIBLE'  # Surplus is unproven.
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['objectiveVector'] == [0, 0, 0, 120000]
    assert result['metrics']['savedCandidate']['adopted']
    assert result['metrics']['savedCandidate']['validationStatus'] == 'VERIFIED'
    assert calls == [True, True, False]
    assert all(b['roleId'] is None for a in result['assignments'] for b in a['blocks'])
    assert any(a['roleIntervals'] for a in result['assignments'])


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
def test_full_search_can_change_prior_duties_and_matches_exhaustive_oracle(priority):
    data, candidate = source()
    data['priority'] = priority
    choices = [('phone', 'leader'), ('phone', None), ('management', None)]
    vectors = [check_multi(data, assignment(data, options))['objectiveVector']
               for options in product(choices, choices, [('phone', None), ('management', None)])]
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', saved_assignments=candidate)
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['objectiveVector'] == min(vectors)
    assert result['validation']['objectiveVector'] < check_multi(data, candidate)['objectiveVector']
    assert result['metrics']['savedCandidate']['adopted']
    assert any(b['taskId'] == 'management' for a in result['assignments'] for b in a['blocks'])


@pytest.mark.parametrize('kind', ['qualification', 'missing-row', 'duplicate-row', 'extra-field', 'history'])
def test_stale_or_invalid_candidate_falls_back_without_weakening_latest_conditions(kind):
    data, candidate = source()
    if kind == 'qualification':
        data['staff'][0]['roleIds'] = []
    elif kind == 'missing-row':
        candidate.pop()
    elif kind == 'duplicate-row':
        candidate.append(deepcopy(candidate[0]))
    elif kind == 'extra-field':
        candidate[0]['extra'] = 'rejected'
    else:
        data['history'] = []
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', saved_assignments=candidate)
    metrics = result['metrics']['savedCandidate']
    assert not metrics['adopted']
    assert metrics['rejection'] == 'LATEST_INPUT_NOT_VERIFIED'
    assert metrics['precheckStatus'] == ('HISTORY_UNVERIFIED' if kind == 'history' else 'INVALID')
    assert result['assignments'] is not None
    independent = check_multi(data, result['assignments'])
    assert not independent['violations']
    assert independent['status'] == ('HISTORY_UNVERIFIED' if kind == 'history' else 'VERIFIED')


def test_valid_minute_roles_not_representable_in_current_segments_are_not_rounded():
    data, candidate = source()
    candidate[0]['blocks'][0]['roleId'] = None
    candidate[0]['roleIntervals'] = [{'start': 540, 'end': 541, 'roleId': 'leader'}]
    assert check_multi(data, candidate)['status'] == 'VERIFIED'
    unchanged = deepcopy(candidate)
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', saved_assignments=candidate)
    assert candidate == unchanged
    assert result['metrics']['savedCandidate']['rejection'] == 'UNREPRESENTABLE_ROLE_BOUNDARY'
    assert not result['metrics']['savedCandidate']['adopted']
    assert result['validation']['status'] == 'VERIFIED'


@pytest.mark.parametrize('status', [multi_model.cp_model.UNKNOWN, multi_model.cp_model.INFEASIBLE])
def test_restricted_candidate_failure_is_not_a_global_infeasibility_proof(monkeypatch, status):
    data, candidate = source()
    original = multi_model.cp_model.CpSolver.solve
    calls = []

    def fail_first(solver, *args, **kwargs):
        calls.append(solver.parameters.fix_variables_to_their_hinted_value)
        return status if len(calls) == 1 else original(solver, *args, **kwargs)

    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', fail_first)
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', saved_assignments=candidate)
    assert calls[:2] == [True, True]
    assert result['solverStatus'] == 'OPTIMAL'
    assert result['validation']['status'] == 'VERIFIED'
    assert not result['metrics']['savedCandidate']['adopted']
    assert result['metrics']['initialIncumbent']['adopted']


def test_checker_only_candidate_never_becomes_solver_feasible(monkeypatch):
    data, candidate = source()
    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', lambda *args, **kwargs: multi_model.cp_model.UNKNOWN)
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', saved_assignments=candidate)
    assert result['metrics']['savedCandidate']['precheckStatus'] == 'VERIFIED'
    assert not result['metrics']['savedCandidate']['adopted']
    assert result['solverStatus'] == 'UNKNOWN'
    assert result['assignments'] is None
    assert result['validation']['status'] == 'NOT_RUN'


def test_candidate_cp_objective_must_also_agree_with_the_source_certificate(monkeypatch):
    data, candidate = source()
    original = multi_model.check_multi
    calls = 0

    def wrong_source(*args):
        nonlocal calls
        calls += 1
        report = original(*args)
        if calls == 1:
            report['objectiveVector'][-1] += 1
        return report

    monkeypatch.setattr(multi_model, 'check_multi', wrong_source)
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', saved_assignments=candidate)
    assert not result['metrics']['savedCandidate']['adopted']
    assert result['metrics']['savedCandidate']['rejection'] == 'OBJECTIVE_MISMATCH'
    assert result['validation']['status'] == 'VERIFIED'


def test_candidate_does_not_silently_change_other_strategies():
    data, candidate = source()
    with pytest.raises(ValueError, match='SAVED_CANDIDATE_REQUIRES_V4'):
        solve_multi(data, saved_assignments=candidate)


@pytest.mark.parametrize('mode', ['initial', 'reallocation'])
def test_exact_preparation_break_training_and_fixed_exception_survive_candidate_mapping(monkeypatch, mode):
    data, candidate = operational_fixture(10, 30)
    if mode == 'reallocation':
        data['mode'] = mode
        data['published'] = [{'staffId': a['staffId'], 'date': a['date'], 'shift': deepcopy(a['shift'])}
                             for a in candidate]
    original = deepcopy((data, candidate))
    only_seed(monkeypatch)
    result = solve_multi(data, 10, hint_strategy='balanced-incumbent-v4', saved_assignments=candidate)
    assert (data, candidate) == original
    assert result['metrics']['savedCandidate']['adopted']
    assert result['validation']['status'] == 'VERIFIED'
    assert result['validation']['objectiveVector'] <= check_multi(data, candidate)['objectiveVector']
    assert result['solverStatus'] == 'FEASIBLE'
    if mode == 'reallocation':
        assert [a['shift'] for a in result['assignments']] == [a['shift'] for a in candidate]


def test_valid_saved_candidate_is_compared_with_better_generated_seed_before_main_search(monkeypatch):
    data, candidate = operational_fixture(10, 30)
    only_seed(monkeypatch)
    result = solve_multi(data, 10, hint_strategy='balanced-incumbent-v4', saved_assignments=candidate)
    metrics = result['metrics']
    assert metrics['savedCandidate']['adopted']
    assert metrics['competingHintIncumbent']['validationStatus'] == 'VERIFIED'
    assert metrics['initialIncumbent']['objectiveVector'] <= metrics['savedCandidate']['sourceObjectiveVector']
    assert result['validation']['objectiveVector'] == metrics['initialIncumbent']['objectiveVector']
