"""Diagnostic process boundary; normal solves still run in-process.

Only this request's private files and process group are owned by this module.
A forced deadline is an execution outcome, never a proof of infeasibility.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

from .multi_checker import check_multi
from .multi_contract import validate_multi
from .process_observation import read_observation

LINEAGE = ('tenantId', 'teamId', 'month', 'mode', 'inputVersion',
           'settingsVersion', 'jobId', 'attempt')


class ProcessExecutionError(RuntimeError):
    def __init__(self, diagnostics):
        super().__init__('PROCESS_EXECUTION_FAILED')
        self.diagnostics = diagnostics


def atomic_result(path, result):
    path = Path(path)
    pending = path.with_suffix('.pending')
    with pending.open('w', encoding='utf8') as out:
        json.dump(result, out, separators=(',', ':'), allow_nan=False)
    os.replace(pending, path)


def read_result(path, data, *, allow_checked_hint=False, allow_reference=False):
    if Path(path).stat().st_size > 16_000_000:
        raise ValueError('PROCESS_RESULT_LIMIT')
    result = json.loads(Path(path).read_text(encoding='utf8'))
    expected = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    if (result.get('schemaVersion') != 'multi-task-v1' or result.get('inputHash') != expected
            or any(result.get(k) != data[k] for k in LINEAGE)):
        raise ValueError('PROCESS_RESULT_LINEAGE')
    assignments = result.get('assignments')
    if assignments is not None:
        checked = check_multi(data, assignments)
        statuses = ('VERIFIED', 'HISTORY_UNVERIFIED') if allow_reference else ('VERIFIED',)
        if (checked['status'] not in statuses
                or result.get('validation', {}).get('status') != checked['status']
                or checked['objectiveVector'] != result['validation'].get('objectiveVector')):
            raise ValueError('PROCESS_RESULT_NOT_VERIFIED')
        if checked['status'] == 'HISTORY_UNVERIFIED' and result.get('publication') != 'BLOCKED_A1':
            raise ValueError('PROCESS_RESULT_STATUS')
        checked_hint = (allow_checked_hint and checked['status'] == 'VERIFIED'
            and result.get('solverStatus') == 'UNKNOWN'
            and result.get('candidateStatus') == 'CHECKED'
            and result.get('globalSolverStatus') in ('NOT_RUN', 'UNKNOWN')
            and result.get('publication') == 'BLOCKED_A1')
        if result.get('solverStatus') not in ('FEASIBLE', 'OPTIMAL') and not checked_hint:
            raise ValueError('PROCESS_RESULT_STATUS')
        result['validation'] = checked
    elif (result.get('solverStatus') not in ('UNKNOWN', 'INFEASIBLE')
          or result.get('validation', {}).get('status') != 'NOT_RUN'):
        raise ValueError('PROCESS_RESULT_STATUS')
    return result


def stop_and_reap(child):
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=1)
    if child.poll() is None:
        raise RuntimeError('PROCESS_NOT_REAPED')


def solve_in_process(data, budget_seconds=120, *, execution_seconds=None, calendar_roster=False, compact_minutes=False,
                     shared_build_facts=False, build_variable_limit=1_000_000, common_runs=False,
                     early_checkpoint=False, calendar_fallback=False):
    if not isinstance(calendar_fallback, bool) or (calendar_fallback and calendar_roster):
        raise ValueError('CALENDAR_FALLBACK_SETTING')
    if not isinstance(early_checkpoint, bool):
        raise ValueError('EARLY_CHECKPOINT_SETTING')
    if not isinstance(common_runs,bool):
        raise ValueError('COMMON_RUN_SETTING')
    if (not isinstance(build_variable_limit,int) or isinstance(build_variable_limit,bool)
            or not 1_000_000<=build_variable_limit<=3_500_000):
        raise ValueError('BUILD_VARIABLE_LIMIT')
    if not isinstance(shared_build_facts,bool) or (shared_build_facts and not compact_minutes):
        raise ValueError('SHARED_BUILD_FACTS_SETTING')
    if not isinstance(compact_minutes, bool):
        raise ValueError('COMPACT_MINUTES_SETTING')
    if not isinstance(calendar_roster, bool):
        raise ValueError('CALENDAR_ROSTER_SETTING')
    if not math.isfinite(budget_seconds) or budget_seconds <= 0:
        raise ValueError('PROCESS_BUDGET')
    execution_seconds = budget_seconds if execution_seconds is None else execution_seconds
    if (not math.isfinite(execution_seconds) or execution_seconds <= 0
            or execution_seconds > budget_seconds):
        raise ValueError('PROCESS_EXECUTION_BUDGET')
    validate_multi(data)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='optimizer-process-') as directory:
        root = Path(directory)
        (root / 'input.json').write_text(json.dumps(data, allow_nan=False), encoding='utf8')
        child = subprocess.Popen([sys.executable, '-m', 'optimizer.process_budget',
                                  str(root), str(budget_seconds), '1' if calendar_roster else '0',
                                  '1' if compact_minutes else '0','1' if shared_build_facts else '0',
                                  str(build_variable_limit),'1' if common_runs else '0',
                                  '1' if early_checkpoint else '0','1' if calendar_fallback else '0'],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True,
                                 cwd=Path(__file__).resolve().parent.parent)
        expired = False
        try:
            try:
                child.wait(timeout=execution_seconds)
            except subprocess.TimeoutExpired:
                expired = True
                stop_and_reap(child)
            process_seconds = time.monotonic() - started
            observation = read_observation(root / 'progress.json')
            if not expired and child.returncode != 0:
                raise ProcessExecutionError({'progress': observation,
                    'childExitCode': child.returncode, 'childReaped': child.poll() is not None,
                    'executionSeconds': process_seconds})
            final = root / 'final.json'
            checkpoint = root / 'checkpoint.json'
            if not expired:
                result = read_result(final, data, allow_checked_hint=early_checkpoint,
                                     allow_reference=True)
            elif checkpoint.exists():
                result = read_result(checkpoint, data, allow_checked_hint=early_checkpoint)
                if result['assignments'] is None:
                    raise ValueError('PROCESS_CHECKPOINT_MISSING_CANDIDATE')
                # The committed prefix is feasible, not a completed proof for
                # the interrupted stage or all lower objectives.
                if result.get('candidateStatus') != 'CHECKED':
                    result['solverStatus'] = 'FEASIBLE'
            else:
                result = {'schemaVersion': 'multi-task-v1', **{k: data[k] for k in LINEAGE},
                    'inputHash': hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
                    'solverStatus': 'UNKNOWN', 'validation': {'status': 'NOT_RUN', 'violations': []},
                    'assignments': None, 'stages': [], 'publication': 'BLOCKED_A1',
                    'metrics': {'budgetSeconds': budget_seconds,
                                'initialHintStrategy': 'balanced-incumbent-v4',
                                'coveredOffHintsEnabled': True, 'deadlineStopEnabled': False,
                                'calendarRosterHintsEnabled': calendar_roster,
                                'calendarFallbackHintsEnabled': calendar_fallback,
                                'compactMinutesEnabled': compact_minutes,
                                'sharedBuildFactsEnabled': shared_build_facts,
                                'buildVariableLimit': build_variable_limit,'commonRunsEnabled':common_runs}}
            if expired:
                result['termination'] = 'PROCESS_DEADLINE'
            result['metrics']['processBudget'] = {'seconds': execution_seconds, 'expired': expired,
                'childExitCode': child.returncode, 'childReaped': child.poll() is not None,
                'executionSeconds': process_seconds, 'totalSeconds': time.monotonic() - started,
                'terminationStatus': 'UNKNOWN' if expired else 'COMPLETED',
                'parentValidation': result['validation']['status']}
            result['metrics']['processObservation'] = observation
            result['metrics']['earlyCheckpointEnabled'] = early_checkpoint
            return result
        finally:
            stop_and_reap(child)


def worker(directory, budget, calendar_roster=False, compact_minutes=False,
           shared_build_facts=False, build_variable_limit=1_000_000, common_runs=False,
           early_checkpoint=False, calendar_fallback=False):
    from .multi_model import solve_multi
    root = Path(directory)
    data = json.loads((root / 'input.json').read_text(encoding='utf8'))
    events = []

    def progress(row):
        events.append(row)
        del events[:-64]
        atomic_result(root / 'progress.json', {'version': 1, 'events': events})

    starting, initial = time.monotonic(), None

    def retain_initial(rows, report):
        nonlocal initial
        initial = {'schemaVersion': 'multi-task-v1', **{k: data[k] for k in LINEAGE},
            'inputHash': hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
            'solverStatus': 'UNKNOWN', 'candidateStatus': 'CHECKED', 'globalSolverStatus': 'NOT_RUN',
            'validation': report, 'assignments': rows, 'stages': [], 'publication': 'BLOCKED_A1',
            'metrics': {'budgetSeconds': budget, 'earlyCheckpointEnabled': True}}
        atomic_result(root / 'checkpoint.json', initial)

    if early_checkpoint:
        from .early_candidate import checked_initial_candidate
        generated = checked_initial_candidate(data, min(90, budget*.6), on_checked=retain_initial)
        if initial is not None:
            initial['metrics']['initialCandidate'] = generated['metrics']
            initial['globalSolverStatus'] = 'UNKNOWN'
            atomic_result(root / 'checkpoint.json', initial)

    def retain_cp(result):
        if initial is None or result['validation']['objectiveVector'] <= initial['validation']['objectiveVector']:
            result['metrics']['budgetSeconds'] = budget
            atomic_result(root / 'checkpoint.json', result)

    remaining = max(.001, budget-(time.monotonic()-starting)) if early_checkpoint else budget
    result = solve_multi(data, remaining, hint_strategy='balanced-incumbent-v4',
        bulk_solution_transfer=True, covered_off_hints=True,
        calendar_roster=calendar_roster, calendar_fallback=calendar_fallback,
        compact_minutes=compact_minutes,
        shared_build_facts=shared_build_facts,build_variable_limit=build_variable_limit,
        common_runs=common_runs,
        progress_callback=progress,
        saved_assignments=initial['assignments'] if initial is not None else None,
        checkpoint_callback=retain_cp)
    if early_checkpoint:
        if initial is not None:
            if (result['solverStatus'] == 'INFEASIBLE' or
                (result['solverStatus'] == 'OPTIMAL' and result['validation']['objectiveVector'] > initial['validation']['objectiveVector'])):
                raise RuntimeError('CHECKED_CANDIDATE_MODEL_CONTRADICTION')
            if (result['assignments'] is None or
                    result['validation']['objectiveVector'] > initial['validation']['objectiveVector']):
                initial['metrics']['globalSearch'] = {'solverStatus': result['solverStatus'],
                    'budgetSeconds': remaining, 'metrics': result['metrics'], 'stages': result['stages']}
                result = initial
            else:
                result['metrics']['initialCandidate'] = generated['metrics']
        result['metrics']['globalSearchBudgetSeconds'] = remaining
        result['metrics']['budgetSeconds'] = budget
    atomic_result(root / 'final.json', result)


if __name__ == '__main__':
    if len(sys.argv) not in (9, 10) or any(v not in ('0', '1') for v in [*sys.argv[3:6],*sys.argv[7:]]):
        raise ValueError('PROCESS_ARGUMENTS')
    worker(sys.argv[1], float(sys.argv[2]), sys.argv[3] == '1', sys.argv[4] == '1',
           sys.argv[5] == '1',int(sys.argv[6]),sys.argv[7]=='1',sys.argv[8]=='1',len(sys.argv)==10 and sys.argv[9]=='1')
