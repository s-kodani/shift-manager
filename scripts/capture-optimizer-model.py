"""Export a fictional full model before CP search; never a feasibility result."""
import argparse
import hashlib
import json
import time
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/optimizer'))

from optimizer import multi_model  # noqa: E402


class ModelCaptured(Exception):
    pass


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    if (not data.get('tenantId', '').startswith('fictional-')
            or not data.get('teamId', '').startswith('fictional-')
            or not data.get('jobId', '').startswith(('fictional-', 'synthetic-'))
            or any(not staff.get('id', '').startswith('fictional-') for staff in data['staff'])):
        parser.error('fictional input only')
    args.output.mkdir(parents=True, exist_ok=False)
    sources = sorted((ROOT / 'services/optimizer/optimizer').glob('*.py'))
    hashes = {p.name: digest(p) for p in sources}
    started = time.monotonic()
    report = None
    original = multi_model.cp_model.CpSolver.solve

    def capture(solver, model, *unused_args, **unused_kwargs):
        nonlocal report
        before_cp = time.monotonic() - started
        model_path = args.output / 'model.bin'
        export_started = time.monotonic()
        if not model.export_to_file(str(model_path)):
            raise ValueError('MODEL_EXPORT_FAILED')
        export_seconds = time.monotonic() - export_started
        report = {'scope': 'diagnostic full-model construction and initial hints only; '
                          'CP call intercepted; no feasibility or performance acceptance',
                  'staff': len(data['staff']), 'inputSha256': digest(args.input),
                  'canonicalInputHash': hashlib.sha256(json.dumps(
                      data, sort_keys=True).encode()).hexdigest(),
                  'sourceSha256': hashes, 'beforeCpSeconds': before_cp,
                  'exportSeconds': export_seconds, 'modelSha256': digest(model_path),
                  'modelBytes': model_path.stat().st_size,
                  'variables': len(model.proto.variables),
                  'constraints': len(model.proto.constraints),
                  'solverParameters': str(solver.parameters)}
        raise ModelCaptured()

    multi_model.cp_model.CpSolver.solve = capture
    try:
        try:
            multi_model.solve_multi(data, 120, hint_strategy='balanced-incumbent-v4')
        except ModelCaptured:
            pass
    finally:
        multi_model.cp_model.CpSolver.solve = original
    if report is None:
        raise ValueError('FULL_MODEL_NOT_CAPTURED')
    report['sourceHashesMatch'] = hashes == {p.name: digest(p) for p in sources}
    (args.output / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
    if not report['sourceHashesMatch']:
        raise ValueError('SOURCE_CHANGED')
    print(json.dumps({k: v for k, v in report.items() if k != 'sourceSha256'}))


if __name__ == '__main__':
    run()
