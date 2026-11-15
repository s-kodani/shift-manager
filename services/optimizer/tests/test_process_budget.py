import json
from copy import deepcopy
from pathlib import Path
import subprocess
import sys
import time

import pytest

from optimizer import process_budget as boundary
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi
from test_covered_off_hint import covered_fixture


def checked(data):
    return solve_multi(data, 3, hint_strategy='balanced-incumbent-v4',
                       bulk_solution_transfer=True, covered_off_hints=True)


def controlled_child(monkeypatch, script, result=None, filename='checkpoint.json'):
    original = subprocess.Popen
    children = []
    roots = []

    def create(command, **settings):
        root = Path(command[3])
        roots.append(root)
        if result is not None:
            boundary.atomic_result(root / filename, result)
        child = original([sys.executable, '-c', script], **settings)
        children.append(child)
        return child
    monkeypatch.setattr(boundary.subprocess, 'Popen', create)
    return children, roots


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
def test_real_child_preserves_normal_checked_optimum_and_is_reaped(monkeypatch, priority):
    data = covered_fixture()
    data['priority'] = priority
    original = subprocess.Popen
    children = []

    def create(*args, **kwargs):
        child = original(*args, **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(boundary.subprocess, 'Popen', create)
    baseline = checked(data)
    unchanged = deepcopy(data)
    result = boundary.solve_in_process(data, 3)
    assert data == unchanged
    assert result['solverStatus'] == baseline['solverStatus'] == 'OPTIMAL'
    assert result['validation']['objectiveVector'] == baseline['validation']['objectiveVector']
    assert check_multi(data, result['assignments'])['status'] == 'VERIFIED'
    assert result['metrics']['processBudget']['childReaped']
    assert not result['metrics']['processBudget']['expired']
    assert len(children) == 1 and children[0].poll() == 0


@pytest.mark.parametrize('ignore_term', [False, True])
def test_timeout_without_committed_candidate_is_unknown_and_reaped(monkeypatch, ignore_term):
    script = ('import signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);' if ignore_term else '')
    script += 'import time;time.sleep(10)'
    children, roots = controlled_child(monkeypatch, script)
    result = boundary.solve_in_process(covered_fixture(), .2)
    assert result['solverStatus'] == 'UNKNOWN'
    assert result['assignments'] is None and result['validation']['status'] == 'NOT_RUN'
    assert result['termination'] == 'PROCESS_DEADLINE'
    assert result['metrics']['processBudget']['terminationStatus'] == 'UNKNOWN'
    assert result['metrics']['processBudget']['executionSeconds'] < 2.5
    assert children[0].poll() == (-9 if ignore_term else -15)
    assert not roots[0].exists()


def test_timeout_retains_and_rechecks_only_committed_verified_candidate(monkeypatch):
    data = covered_fixture()
    candidate = checked(data)
    children, roots = controlled_child(monkeypatch, 'import time;time.sleep(10)', candidate)
    result = boundary.solve_in_process(data, .1)
    assert result['solverStatus'] == 'FEASIBLE'
    assert result['validation']['objectiveVector'] == candidate['validation']['objectiveVector']
    assert result['metrics']['processBudget']['parentValidation'] == 'VERIFIED'
    assert children[0].poll() is not None and not roots[0].exists()


@pytest.mark.parametrize('fallback', [False, True])
def test_real_process_returns_completed_reference_with_actual_parent_status(monkeypatch, fallback):
    data = multi_synthetic(1, tiny=True)
    data['history'] = []
    untouched = deepcopy(data)
    original, children, roots = subprocess.Popen, [], []

    def create(command, **settings):
        roots.append(Path(command[3]))
        child = original(command, **settings)
        children.append(child)
        return child

    monkeypatch.setattr(boundary.subprocess, 'Popen', create)
    result = boundary.solve_in_process(data, 5, calendar_fallback=fallback)
    assert data == untouched
    assert result['solverStatus'] == 'OPTIMAL'
    assert len(result['assignments']) == 31
    actual = check_multi(data, result['assignments'])
    assert actual['status'] == result['validation']['status'] == 'HISTORY_UNVERIFIED'
    assert actual['violations'] == [] and actual['missingHistory']
    assert result['validation'] == actual
    assert result['publication'] == 'BLOCKED_A1'
    assert result['metrics']['processBudget']['parentValidation'] == 'HISTORY_UNVERIFIED'
    assert result['metrics']['processBudget']['expired'] is False
    assert result['metrics']['processBudget']['childReaped'] is True
    assert len(children) == 1 and children[0].poll() == 0 and not roots[0].exists()


def test_reference_result_does_not_become_a_verified_checkpoint():
    data = multi_synthetic(1, tiny=True)
    data['history'] = []
    checkpoints = []
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4',
                         bulk_solution_transfer=True, covered_off_hints=True,
                         calendar_fallback=True, checkpoint_callback=checkpoints.append)
    assert result['validation']['status'] == 'HISTORY_UNVERIFIED'
    assert checkpoints == []


def test_deadline_still_rejects_an_unverified_reference_checkpoint(monkeypatch):
    data = multi_synthetic(1, tiny=True)
    data['history'] = []
    candidate = checked(data)
    children, roots = controlled_child(monkeypatch, 'import time;time.sleep(10)', candidate)
    with pytest.raises(ValueError, match='PROCESS_RESULT_NOT_VERIFIED'):
        boundary.solve_in_process(data, .1, calendar_fallback=True)
    assert children[0].poll() is not None and not roots[0].exists()


@pytest.mark.parametrize('damage', ['claimed-verified', 'constraint', 'objective', 'publication', 'checked-hint'])
def test_completed_reference_cannot_hide_violations_or_change_its_classification(monkeypatch, damage):
    data = multi_synthetic(1, tiny=True)
    data['history'] = []
    candidate = checked(data)
    if damage == 'claimed-verified':
        candidate['validation']['status'] = 'VERIFIED'
    elif damage == 'constraint':
        row = next(a for a in candidate['assignments'] if a['shift'])
        row['shift']['workedMinutes'] += 30
    elif damage == 'objective':
        candidate['validation']['objectiveVector'][0] += 1
    elif damage == 'publication':
        candidate['publication'] = 'READY'
    else:
        candidate.update(solverStatus='UNKNOWN', candidateStatus='CHECKED', globalSolverStatus='NOT_RUN')
    children, roots = controlled_child(monkeypatch, 'pass', candidate, 'final.json')
    with pytest.raises(ValueError, match='PROCESS_RESULT_'):
        boundary.solve_in_process(data, 5, calendar_fallback=True, early_checkpoint=damage == 'checked-hint')
    assert children[0].poll() == 0 and not roots[0].exists()


@pytest.mark.parametrize('damage', ['lineage', 'constraint', 'objective'])
def test_invalid_checkpoint_is_rejected_and_child_still_reaped(monkeypatch, damage):
    data = covered_fixture()
    candidate = checked(data)
    if damage == 'lineage':
        candidate['jobId'] = 'other-job'
    elif damage == 'constraint':
        candidate['assignments'][0]['blocks'] = []
        # Ensure this row actually contains required work.
        row = next(a for a in candidate['assignments'] if a['shift'])
        row['blocks'] = []
    else:
        candidate['validation']['objectiveVector'][0] += 1
    children, roots = controlled_child(monkeypatch, 'import time;time.sleep(10)', candidate)
    with pytest.raises(ValueError, match='PROCESS_RESULT_'):
        boundary.solve_in_process(data, .1)
    assert children[0].poll() is not None and not roots[0].exists()


def test_partial_pending_write_cannot_be_used_as_candidate(monkeypatch):
    children, roots = controlled_child(monkeypatch, 'import time;time.sleep(10)',
                                        {'unfinished': True}, 'checkpoint.pending')
    result = boundary.solve_in_process(covered_fixture(), .1)
    assert result['solverStatus'] == 'UNKNOWN' and result['assignments'] is None
    assert children[0].poll() is not None and not roots[0].exists()


def test_crash_is_execution_failure_even_if_a_verified_checkpoint_exists(monkeypatch):
    data = covered_fixture()
    children, roots = controlled_child(monkeypatch, 'raise SystemExit(7)', checked(data))
    with pytest.raises(RuntimeError, match='PROCESS_EXECUTION_FAILED'):
        boundary.solve_in_process(data, 1)
    assert children[0].poll() == 7 and not roots[0].exists()


def test_atomic_write_replaces_whole_document_without_pending_file(tmp_path):
    path = tmp_path / 'checkpoint.json'
    boundary.atomic_result(path, {'version': 1, 'rows': [1, 2]})
    boundary.atomic_result(path, {'version': 2, 'rows': [3]})
    assert json.loads(path.read_text()) == {'version': 2, 'rows': [3]}
    assert not path.with_suffix('.pending').exists()


@pytest.mark.parametrize('seconds', [0, -1, float('nan'), float('inf')])
def test_invalid_budget_cannot_create_a_child(seconds):
    with pytest.raises(ValueError, match='PROCESS_BUDGET'):
        boundary.solve_in_process({}, seconds)


@pytest.mark.parametrize('seconds', [0, -1, float('nan'), float('inf'), 121])
def test_diagnostic_execution_limit_cannot_extend_or_invalidate_normal_budget(seconds):
    with pytest.raises(ValueError, match='PROCESS_EXECUTION_BUDGET'):
        boundary.solve_in_process({}, 120, execution_seconds=seconds)


def test_real_proven_infeasibility_is_distinct_from_forced_deadline():
    data = covered_fixture()
    staff = data['staff'][-1]
    staff['unavailable'].append({'date': '2026-10-01', 'start': 540, 'end': 600})
    data['locks'] = [{'id': 'fictional-conflict', 'staffId': staff['id'], 'date': '2026-10-01',
        'parts': ['pattern', 'time', 'break'], 'shift': {'patternId': 'short', 'start': 540,
        'end': 600, 'breakKind': 'auto', 'break': None, 'workedMinutes': 60, 'cancelled': []}}]
    result = boundary.solve_in_process(data, 3)
    assert result['solverStatus'] == 'INFEASIBLE' and result['assignments'] is None
    assert result['validation']['status'] == 'NOT_RUN'
    assert not result['metrics']['processBudget']['expired']


def test_checkpoint_callback_keeps_identical_normal_cp_proto_and_objective(monkeypatch):
    from ortools.sat.python import cp_model
    original = cp_model.CpSolver.solve
    traces = []
    checkpoints = []

    def observe(solver, model, *args, **kwargs):
        traces[-1].append(str(model.proto))
        return original(solver, model, *args, **kwargs)
    monkeypatch.setattr(cp_model.CpSolver, 'solve', observe)
    data = covered_fixture()
    results = []
    for callback in (None, checkpoints.append):
        traces.append([])
        results.append(solve_multi(data, 3, hint_strategy='balanced-incumbent-v4',
            bulk_solution_transfer=True, covered_off_hints=True, checkpoint_callback=callback))
    assert traces[0] == traces[1]
    assert results[0]['validation']['objectiveVector'] == results[1]['validation']['objectiveVector']
    assert checkpoints and all(check_multi(data, c['assignments'])['status'] == 'VERIFIED' for c in checkpoints)


def test_deadline_terminates_a_child_actually_running_cp_sat(monkeypatch):
    original_create = subprocess.Popen
    original_stop = boundary.stop_and_reap
    observations = []
    roots = []
    children = []
    script = '''
import sys
from pathlib import Path
from ortools.sat.python import cp_model
root = Path(sys.argv[1])
model = cp_model.CpModel()
for i in range(30): model.new_bool_var('fictional_'+str(i))
solver = cp_model.CpSolver()
solver.parameters.enumerate_all_solutions = True
solver.parameters.num_search_workers = 1
solver.parameters.max_time_in_seconds = 30
class Started(cp_model.CpSolverSolutionCallback):
    started = False
    def on_solution_callback(self):
        if not self.started:
            (root/'cp-start').write_text('started')
            self.started = True
solver.solve(model, Started())
(root/'cp-finish').write_text('finished')
'''

    def create(command, **settings):
        roots.append(Path(command[3]))
        child = original_create([sys.executable, '-c', script, command[3]], **settings)
        children.append(child)
        # This test targets termination during actual CP search. Loading
        # OR-Tools in a fresh interpreter is a separate phase, and can take
        # longer than the one-second wait under test. Establish readiness
        # with a real solution callback before returning the test child.
        deadline = time.monotonic() + 10
        while not (roots[0]/'cp-start').exists():
            if child.poll() is not None or time.monotonic() >= deadline:
                original_stop(child)
                pytest.fail('test child did not enter CP search within readiness bound')
            time.sleep(.01)
        return child

    def stop(child):
        observations.append((child.poll(), (roots[0]/'cp-start').exists(),
                             (roots[0]/'cp-finish').exists()))
        return original_stop(child)

    monkeypatch.setattr(boundary.subprocess, 'Popen', create)
    monkeypatch.setattr(boundary, 'stop_and_reap', stop)
    result = boundary.solve_in_process(covered_fixture(), 1)
    assert observations[0] == (None, True, False)
    assert result['solverStatus'] == 'UNKNOWN' and result['termination'] == 'PROCESS_DEADLINE'
    assert children[0].poll() == -15 and not roots[0].exists()


def test_exit_between_term_wait_and_kill_is_still_reaped(monkeypatch):
    class Child:
        pid = 123
        returncode = None
        waits = 0

        def poll(self):
            return self.returncode

        def wait(self, timeout):
            self.waits += 1
            if self.waits == 1:
                raise subprocess.TimeoutExpired('fictional-child', timeout)
            self.returncode = 0
            return 0
    child = Child()
    signals = []

    def signal_group(pid, kind):
        signals.append(kind)
        if len(signals) == 2:
            raise ProcessLookupError
    monkeypatch.setattr(boundary.os, 'killpg', signal_group)
    boundary.stop_and_reap(child)
    assert child.poll() == 0 and child.waits == 2 and len(signals) == 2
