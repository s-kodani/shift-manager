from copy import deepcopy
import json
import subprocess
import sys

import pytest

from optimizer import benchmark
from optimizer.benchmark_request import solve_benchmark
from optimizer.fixtures import multi_synthetic


def command():
    data = multi_synthetic(1, tiny=True)
    data['jobId'] = 'fictional-benchmark-tiny'
    return {'input': data, 'strategy': 'balanced-incumbent-v2', 'budgetSeconds': 5}


@pytest.mark.parametrize('field,value', [('strategy', 'unknown'), ('budgetSeconds', True),
                                      ('budgetSeconds', 0), ('budgetSeconds', 121),
                                      ('budgetSeconds', float('nan')), ('budgetSeconds', float('inf'))])
def test_private_benchmark_rejects_invalid_search_settings(field, value):
    data = command()
    data[field] = value
    with pytest.raises(ValueError):
        solve_benchmark(data)


@pytest.mark.parametrize('field,value', [('tenantId', 'other-company'), ('teamId', 'other-team'),
                                      ('jobId', 'real-job'), ('schemaVersion', 'single-task-v0')])
def test_private_benchmark_cannot_accept_business_identity(field, value):
    data = command()
    data['input'][field] = value
    with pytest.raises(ValueError, match='FICTIONAL_BENCHMARK_ONLY'):
        solve_benchmark(data)


def test_private_benchmark_checks_staff_identity_and_strict_envelope():
    data = command()
    data['input']['staff'][0]['id'] = 'real-staff'
    with pytest.raises(ValueError):
        solve_benchmark(data)
    data = command()
    data['overrideHardConditions'] = True
    with pytest.raises(ValueError):
        solve_benchmark(data)


@pytest.mark.parametrize('strategy', ['balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4'])
def test_private_benchmark_returns_verified_summary_without_exporting_placements(strategy):
    original = command()
    original['strategy'] = strategy
    data = deepcopy(original)
    result = solve_benchmark(data)
    assert data == original
    assert result['validation']['status'] == 'VERIFIED'
    # Phone 09:00-10:00 then backoffice with 10-minute preparation:
    # 1000 capacity * 10 minutes shortage, no general surplus, no wishes.
    assert result['validation']['objectiveVector'] == [10000, 0, 0]
    assert result['assignmentCount'] == 31
    assert result['metrics']['initialHintStrategy'] == strategy
    assert len(result['resultSha256']) == 64
    assert 'assignments' not in result and 'daily' not in result['validation']


def test_private_benchmark_preserves_build_termination_instead_of_calling_it_infeasible(monkeypatch):
    from optimizer import benchmark_request
    data = command()
    failure = {'schemaVersion': 'multi-task-v1', 'tenantId': data['input']['tenantId'],
               'teamId': data['input']['teamId'], 'jobId': data['input']['jobId'],
               'inputHash': 'fictional-digest', 'solverStatus': 'UNKNOWN', 'stages': [],
               'metrics': {}, 'publication': 'BLOCKED_A1', 'assignments': None,
               'validation': {'status': 'NOT_RUN', 'violations': []},
               'termination': 'BUILD_COMPLEXITY_LIMIT'}
    monkeypatch.setattr(benchmark_request, 'solve_multi', lambda *args, **kwargs: failure)
    result = solve_benchmark(data)
    assert result['solverStatus'] == 'UNKNOWN' and result['validation']['status'] == 'NOT_RUN'
    assert result['termination'] == 'BUILD_COMPLEXITY_LIMIT'


@pytest.mark.parametrize('failure', ['exit', 'timeout'])
def test_benchmark_process_failures_remain_evidence_and_fail_the_command(monkeypatch, tmp_path, failure):
    output = tmp_path / 'run'
    monkeypatch.setattr(sys, 'argv', ['benchmark', '--fixture', 'basic', '--staff', '1', '--seconds', '1', '--output', str(output)])
    def failed(args, **kwargs):
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(args, kwargs['timeout'])
        return subprocess.CompletedProcess(args, 2, '', 'injected child failure')
    monkeypatch.setattr(subprocess, 'run', failed)
    with pytest.raises(SystemExit) as error:
        benchmark.run()
    assert error.value.code == 1
    report = json.loads((output / 'summary.json').read_text())
    assert len(report['runs']) == 2
    for run in report['runs']:
        if failure == 'exit':
            assert run['exitCode'] == 2
        else:
            assert run['harnessStatus'] == 'PROCESS_TIMEOUT'
