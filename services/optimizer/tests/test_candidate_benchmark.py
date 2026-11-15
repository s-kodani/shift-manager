import json
import subprocess
import sys
from pathlib import Path

import pytest

from optimizer import candidate_benchmark


def test_source_change_during_measurement_is_retained_as_failure_not_acceptance(monkeypatch, tmp_path):
    output = tmp_path / 'run'
    monkeypatch.setattr(sys, 'argv', ['candidate_benchmark', '--staff', '10', '--seconds', '1',
                                    '--output', str(output)])
    original, changed, calls = candidate_benchmark.digest, False, 0

    def digest(path):
        return 'injected-source-change' if changed and path.suffix == '.py' else original(path)

    def execute(command, **kwargs):
        nonlocal changed, calls
        calls += 1
        Path(command[command.index('--output') + 1]).write_text(json.dumps({
            'solverStatus': 'UNKNOWN', 'validation': {'status': 'NOT_RUN'},
            'metrics': {}, 'stages': [], 'assignments': None}))
        changed = True  # No repository file is changed by this fault injection.
        return subprocess.CompletedProcess(command, 0, '', '')

    monkeypatch.setattr(candidate_benchmark, 'digest', digest)
    monkeypatch.setattr(subprocess, 'run', execute)
    with pytest.raises(SystemExit) as error:
        candidate_benchmark.run()
    assert error.value.code == 1
    report = json.loads((output / 'summary.json').read_text())
    assert calls == 1
    assert all(r['harnessStatus'] == 'SOURCE_CHANGED' and not r['sourceHashesMatch'] for r in report['runs'])
