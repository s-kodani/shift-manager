"""Opt-in saved-reference experiment, fresh processes and fictional data only.

The independent manual reference is an explicit advisory candidate in this
experiment. It is never built into the solver or used by normal business jobs.
"""
import argparse
import hashlib
import json
import platform
import subprocess
import sys
import time
from pathlib import Path

from .multi_checker import check_multi
from .operational_fixture import operational_fixture


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staff', type=int, choices=range(10, 501), default=101)
    parser.add_argument('--slot', type=int, choices=[30, 60], default=30)
    parser.add_argument('--seconds', type=float, default=120)
    parser.add_argument('--trials', type=int, choices=range(1, 4), default=1)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 120:
        parser.error('budget must be within 1..120 seconds')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    data, reference = operational_fixture(args.staff, args.slot)
    source_report = check_multi(data, reference)
    if source_report['status'] != 'VERIFIED':
        raise ValueError('INVALID_REFERENCE')
    input_path, source_path = output / 'input.json', output / 'candidate.json'
    input_path.write_text(json.dumps(data, ensure_ascii=False) + '\n')
    source_path.write_text(json.dumps(reference, ensure_ascii=False) + '\n')
    root = Path(__file__).resolve().parents[3]
    sources = [*sorted(Path(__file__).parent.glob('*.py')),
               root / 'packages/contracts/optimizer-multi-task.schema.json',
               root / 'services/optimizer/uv.lock']
    report = {'fixture': 'operational-v1', 'staff': args.staff, 'slotMinutes': args.slot,
              'budgetSeconds': args.seconds, 'trials': args.trials,
              'scope': 'local Python; explicit fictional manual candidate; excludes API, DB, '
                       'Queues, Docker, Cloudflare and browser; not prior-draft integration',
              'environment': {'system': platform.system(), 'machine': platform.machine(),
                              'python': platform.python_version()},
              'sourceSha256': {str(p.relative_to(root)): digest(p) for p in sources},
              'inputSha256': digest(input_path), 'candidateSha256': digest(source_path),
              'reference': {'status': source_report['status'],
                            'objectiveVector': source_report['objectiveVector']}, 'runs': []}
    def unchanged():
        return all(digest(p) == report['sourceSha256'][str(p.relative_to(root))] for p in sources)

    for trial in range(1, args.trials + 1):
        for kind in (['baseline', 'saved-reference'] if trial % 2 else ['saved-reference', 'baseline']):
            if not unchanged():
                report['runs'].append({'trial': trial, 'kind': kind,
                                       'harnessStatus': 'SOURCE_CHANGED', 'sourceHashesMatch': False})
                (output / 'summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
                raise SystemExit(1)
            target = output / f'{trial}-{kind}.json'
            command = [sys.executable, '-m', 'optimizer', '--input', str(input_path),
                       '--seconds', str(args.seconds), '--hint-strategy', 'balanced-incumbent-v4',
                       '--output', str(target)]
            if kind == 'saved-reference':
                command.extend(['--saved-candidate', str(source_path)])
            started = time.monotonic()
            try:
                process = subprocess.run(command, capture_output=True, text=True,
                                         timeout=args.seconds + 60, check=False)
                (output / f'{trial}-{kind}.log').write_text(process.stdout + process.stderr)
                observation = {'trial': trial, 'kind': kind, 'exitCode': process.returncode,
                               'processSeconds': time.monotonic() - started}
                if process.returncode == 0:
                    result = json.loads(target.read_text())
                    observation.update(solverStatus=result['solverStatus'],
                                       validationStatus=result['validation']['status'],
                                       objectiveVector=result['validation'].get('objectiveVector'),
                                       metrics=result['metrics'], stages=result['stages'],
                                       assignmentCount=len(result['assignments'] or []),
                                       termination=result.get('termination'), resultSha256=digest(target))
                    adopted = result['metrics'].get('savedCandidate', {}).get('adopted', False)
                    observation['noRegressionFromAdoptedCandidate'] = (
                        result['validation']['status'] == 'VERIFIED'
                        and result['validation']['objectiveVector'] <= source_report['objectiveVector']
                    ) if adopted else None
            except subprocess.TimeoutExpired:
                observation = {'trial': trial, 'kind': kind, 'processSeconds': time.monotonic() - started,
                               'harnessStatus': 'PROCESS_TIMEOUT'}
            observation['sourceHashesMatch'] = unchanged()
            if not observation['sourceHashesMatch']:
                observation['harnessStatus'] = 'SOURCE_CHANGED'
            report['runs'].append(observation)
            (output / 'summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(observation, ensure_ascii=False), flush=True)
    if any(r.get('exitCode') != 0 or r.get('validationStatus') == 'INVALID'
           or r.get('noRegressionFromAdoptedCandidate') is False
           or not r.get('sourceHashesMatch') for r in report['runs']):
        raise SystemExit(1)


if __name__ == '__main__':
    run()
