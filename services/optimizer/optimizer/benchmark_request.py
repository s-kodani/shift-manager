"""Private fictional benchmark envelope; production /solve keeps its defaults."""
import hashlib
import json
import math
import os
import platform
from pathlib import Path

from .multi_model import solve_multi

STRATEGIES = ('legacy-first-v1', 'balanced-coverage-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4')


def solve_benchmark(payload):
    if not isinstance(payload, dict) or set(payload) != {'input', 'strategy', 'budgetSeconds'}:
        raise ValueError('BENCHMARK_ENVELOPE')
    strategy, budget, data = payload['strategy'], payload['budgetSeconds'], payload['input']
    if strategy not in STRATEGIES or isinstance(budget, bool) or not isinstance(budget, (int, float)):
        raise ValueError('BENCHMARK_SETTINGS')
    if not math.isfinite(budget) or not 1 <= budget <= 120:
        raise ValueError('BENCHMARK_BUDGET')
    if (not isinstance(data, dict) or data.get('schemaVersion') != 'multi-task-v1'
            or data.get('tenantId') != 'fictional-company-a' or data.get('teamId') != 'fictional-team-a'
            or not str(data.get('jobId', '')).startswith('fictional-')
            or not isinstance(data.get('staff'), list)
            or any(not isinstance(s, dict) or not str(s.get('id', '')).startswith('fictional-') for s in data['staff'])):
        raise ValueError('FICTIONAL_BENCHMARK_ONLY')
    result = solve_multi(data, budget_seconds=budget, hint_strategy=strategy)
    # Keep exact full-result provenance but avoid transferring thousands of
    # staff-day rows through RPC. This endpoint is not a schedule export/API.
    report = {key: result[key] for key in ('schemaVersion', 'tenantId', 'teamId', 'jobId', 'inputHash',
                                         'solverStatus', 'stages', 'metrics', 'publication')}
    report['validation'] = {k: v for k, v in result['validation'].items()
                            if k not in ('daily', 'roleRequirements', 'intervals')}
    report['assignmentCount'] = len(result['assignments'] or [])
    report['resultSha256'] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    report['benchmark'] = {'strategy': strategy, 'budgetSeconds': budget,
                           'scope': 'private fictional container benchmark; not business job acceptance'}
    report['termination'] = result.get('termination')
    report['runtime'] = {'system': platform.system(), 'machine': platform.machine(),
                         'python': platform.python_version(), 'uid': os.getuid(),
                         'deploymentId': os.environ.get('CLOUDFLARE_DEPLOYMENT_ID')}
    report['sourceSha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                              for p in sorted(Path(__file__).parent.glob('*.py'))}
    return report
