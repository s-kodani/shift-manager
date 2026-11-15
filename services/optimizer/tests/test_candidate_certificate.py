from copy import deepcopy

import pytest

from optimizer.candidate_certificate import CandidateCertificate
from optimizer.contract import dates
from optimizer.multi_checker import check_multi
from optimizer import multi_model
from test_zero_proofs import zero_fixture, only_seed


def fixture():
    data = zero_fixture()
    assignments = [{'staffId': data['staff'][0]['id'], 'date': d.isoformat(),
                    'shift': None, 'blocks': [], 'roleIntervals': []} for d in dates(data)]
    return data, assignments


def test_unchanged_content_and_dict_key_order_reuse_a_real_verified_report():
    data, assignments = fixture()
    certificate = CandidateCertificate(check_multi)
    report = certificate.check(data, assignments, [0, 0, 0])
    assert report['status'] == 'VERIFIED'
    reordered = dict(reversed(list(data.items())))
    assert certificate.lookup(reordered, deepcopy(assignments), [0, 0, 0]) == report
    report['objectiveVector'][0] = 999
    reused = certificate.lookup(data, assignments, [0, 0, 0])
    assert reused['objectiveVector'] == [0, 0, 0]
    reused['objectiveVector'][0] = 999
    assert certificate.lookup(data, assignments, [0, 0, 0])['objectiveVector'] == [0, 0, 0]


@pytest.mark.parametrize('text', ['日本語の根拠・😀', 'escaped-surrogate-\ud800'])
def test_json_strings_accepted_by_the_checker_remain_fingerprintable(text):
    data, assignments = fixture()
    data['jobId'] += text
    assert check_multi(data, assignments)['status'] == 'VERIFIED'
    certificate = CandidateCertificate(check_multi)
    assert certificate.check(data, assignments, [0, 0, 0])['status'] == 'VERIFIED'
    assert certificate.lookup(data, assignments, [0, 0, 0])['status'] == 'VERIFIED'


@pytest.mark.parametrize('change', ['rule', 'version', 'tenant', 'history', 'assignment', 'objective'])
def test_in_place_changes_cannot_reuse_a_previously_verified_certificate(change):
    data, assignments = fixture()
    certificate = CandidateCertificate(check_multi)
    certificate.check(data, assignments, [0, 0, 0])
    vector = [0, 0, 0]
    if change == 'rule':
        data['staff'][0]['rules'][0]['monthlyMin'] = 1
    elif change == 'version':
        data['inputVersion'] += 1
    elif change == 'tenant':
        data['tenantId'] += '-another-company'
    elif change == 'history':
        data['history'][0]['workedMinutes'] = 30
    elif change == 'assignment':
        assignments[0]['date'] = assignments[1]['date']
    else:
        vector[0] = 1
    assert certificate.lookup(data, assignments, vector) is None
    if change in ('rule', 'assignment'):
        assert certificate.check(data, assignments, vector)['status'] == 'INVALID'


@pytest.mark.parametrize('rejection', ['INVALID', 'HISTORY_UNVERIFIED', 'OBJECTIVE_MISMATCH'])
def test_rejected_or_mismatched_report_is_never_retained(rejection):
    data, assignments = fixture()

    def rejected(data, assignments):
        report = check_multi(data, assignments)
        if rejection == 'OBJECTIVE_MISMATCH':
            report['objectiveVector'][0] = 1
        else:
            report['status'] = rejection
        return report

    certificate = CandidateCertificate(rejected)
    certificate.check(data, assignments, [0, 0, 0])
    assert certificate.lookup(data, assignments, [0, 0, 0]) is None
    assert CandidateCertificate(check_multi).lookup(data, assignments, [0, 0, 0]) is None


def test_input_changed_during_check_is_not_certified_for_the_changed_content():
    data, assignments = fixture()

    def modifying_checker(data, assignments):
        report = check_multi(data, assignments)
        data['staff'][0]['rules'][0]['monthlyMin'] = 1
        return report

    certificate = CandidateCertificate(modifying_checker)
    certificate.check(data, assignments, [0, 0, 0])
    assert certificate.lookup(data, assignments, [0, 0, 0]) is None
    assert check_multi(data, assignments)['status'] == 'INVALID'


def test_unchanged_cp_incumbent_uses_its_certificate_without_promoting_unknown_search(monkeypatch):
    only_seed(monkeypatch)
    from test_role_hint import role_tie_fixture
    result = multi_model.solve_multi(role_tie_fixture(), 5, hint_strategy='balanced-incumbent-v4')
    assert result['solverStatus'] == 'FEASIBLE'
    assert result['stages'][-1]['status'] == 'UNKNOWN'
    assert result['metrics']['finalCheckKind'] == 'REUSED_VERIFIED'
    assert result['validation'] == check_multi(role_tie_fixture(), result['assignments'])


def test_changed_content_reaches_a_fresh_final_check_and_is_not_hidden_by_object_identity(monkeypatch):
    data = zero_fixture()
    original = multi_model.cp_model.CpSolver.solve

    def mutate_after_seed(solver, *args, **kwargs):
        if solver.parameters.fix_variables_to_their_hinted_value:
            return original(solver, *args, **kwargs)
        # The prior certificate was VERIFIED for a lower monthly minimum.
        data['staff'][0]['rules'][0]['monthlyMin'] = 1
        return multi_model.cp_model.UNKNOWN

    data['staff'][0]['preferences'] = [{'date': '2026-10-01', 'kind': 'work'}]
    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', mutate_after_seed)
    result = multi_model.solve_multi(data, 5, hint_strategy='balanced-incumbent-v4')
    assert result['metrics']['finalCheckKind'] == 'EXECUTED'
    assert result['validation']['status'] == 'INVALID'
