"""Sequential, fresh-process performance observations using fictional data only."""
import argparse
import hashlib
import json
import platform
import subprocess
import sys
import time
from pathlib import Path

from .fixtures import multi_synthetic
from .multi_checker import check_multi
from .operational_fixture import operational_fixture


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', choices=['basic', 'operational-v1'], default='operational-v1')
    parser.add_argument('--staff', type=int, default=101)
    parser.add_argument('--slot', type=int, choices=[30, 60], default=60)
    parser.add_argument('--seconds', type=float, default=30)
    parser.add_argument('--trials', type=int, default=1)
    parser.add_argument('--strategies', nargs='+',
                        choices=['legacy-first-v1', 'balanced-coverage-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4'],
                        default=['legacy-first-v1', 'balanced-coverage-v1'])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.trials <= 20 or args.seconds <= 0 or not 1 <= args.staff <= 500:
        parser.error('positive budget, 1..20 trials, 1..500 staff required')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)  # Never overwrite earlier evidence.
    data, reference = (operational_fixture(args.staff, args.slot)
                       if args.fixture == 'operational-v1' else
                       (multi_synthetic(args.staff, args.slot), None))
    input_path = output / 'input.json'
    input_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    reference_report = None
    if reference is not None:
        reference_report = check_multi(data, reference)
        (output / 'reference.json').write_text(json.dumps(
            {'assignments': reference, 'validation': reference_report}, ensure_ascii=False) + '\n')
        if reference_report['status'] != 'VERIFIED':
            raise ValueError('INVALID_HANDWRITTEN_REFERENCE')
    root = Path(__file__).resolve().parents[3]
    sources = [*sorted(Path(__file__).parent.glob('*.py')),
               *sorted((root / 'packages/contracts').glob('*.json')),
               root / 'services/optimizer/uv.lock']
    report = {'fixture': args.fixture, 'staff': args.staff, 'slotMinutes': args.slot,
              'budgetSeconds': args.seconds, 'trials': args.trials,
              'scope': 'local Python; excludes queue, API, container startup and browser',
              'environment': {'system': platform.system(), 'machine': platform.machine(),
                              'python': platform.python_version()},
              'sourceSha256': {str(p.relative_to(root)): digest(p) for p in sources},
              'inputSha256': digest(input_path), 'reference': None if reference_report is None else
              {'status': reference_report['status'], 'objectiveVector': reference_report['objectiveVector'],
               'sha256': digest(output / 'reference.json')}, 'runs': []}
    for trial in range(1, args.trials + 1):
        # Alternate order to expose simple warm-up/order effects. Each solver
        # has its own process; ru_maxrss is not inherited from an earlier solve.
        strategies = args.strategies if trial % 2 else list(reversed(args.strategies))
        for strategy in strategies:
            result_path = output / f'{trial}-{strategy}.json'
            command = [sys.executable, '-m', 'optimizer', '--input', str(input_path),
                       '--seconds', str(args.seconds), '--hint-strategy', strategy,
                       '--output', str(result_path)]
            started = time.monotonic()
            try:
                process = subprocess.run(command, capture_output=True, text=True,
                                         timeout=args.seconds + 60, check=False)
                (output / f'{trial}-{strategy}.log').write_text(process.stdout + process.stderr)
                observation = {'trial': trial, 'strategy': strategy, 'exitCode': process.returncode,
                               'processSeconds': time.monotonic() - started}
                if process.returncode == 0:
                    result = json.loads(result_path.read_text())
                    observation.update(solverStatus=result['solverStatus'],
                                       termination=result.get('termination'),
                                       validationStatus=result['validation']['status'],
                                       objectiveVector=result['validation'].get('objectiveVector'),
                                       metrics=result['metrics'], stages=result['stages'],
                                       resultSha256=digest(result_path))
            except subprocess.TimeoutExpired:
                observation = {'trial': trial, 'strategy': strategy,
                               'processSeconds': time.monotonic() - started,
                               'harnessStatus': 'PROCESS_TIMEOUT'}
            report['runs'].append(observation)
            (output / 'summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(observation, ensure_ascii=False), flush=True)
            if observation.get('validationStatus') == 'INVALID':
                raise ValueError('SOLVER_RETURNED_INVALID_RESULT')
    if any(r.get('exitCode') != 0 for r in report['runs']):
        raise SystemExit(1)  # Preserve diagnostic runs without masking child failure or timeout.


if __name__ == '__main__':
    run()
