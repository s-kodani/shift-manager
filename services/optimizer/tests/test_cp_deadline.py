import threading
from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from optimizer.cp_deadline import solve_with_deadline
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi
from test_covered_off_hint import covered_fixture


def watchers():
    return [t for t in threading.enumerate() if t.name == 'optimizer-cp-deadline']


def test_stop_before_wrapper_exists_is_retried_and_joined():
    class Solver:
        def __init__(self):
            self.first = threading.Event()
            self.stopped = threading.Event()
            self.ready = False

        def solve(self, _model):
            assert self.first.wait(1)
            self.ready = True
            assert self.stopped.wait(1)
            return cp_model.UNKNOWN

        def stop_search(self):
            if self.ready:
                self.stopped.set()
            else:
                self.first.set()

    status, m = solve_with_deadline(Solver(), None, .005)
    assert status == cp_model.UNKNOWN
    assert m['deadlineStopRequested'] and m['deadlineStopAttempts'] >= 2
    assert m['deadlineStopFirstSeconds'] >= .005
    assert m['deadlineMonitorJoined'] and not watchers()


@pytest.mark.parametrize('infeasible', [False, True])
def test_actual_solver_can_finish_before_deadline_with_its_real_status(infeasible):
    model = cp_model.CpModel()
    x = model.new_bool_var('x')
    model.add(x == 1)
    if infeasible:
        model.add(x == 0)
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    status, m = solve_with_deadline(solver, model, 1)
    assert status == (cp_model.INFEASIBLE if infeasible else cp_model.OPTIMAL)
    assert not m['deadlineStopRequested'] and m['deadlineStopAttempts'] == 0
    assert not watchers()


def test_zero_allowance_is_unknown_without_invoking_solver():
    class Solver:
        def solve(self, _model):
            raise AssertionError('MUST_NOT_INVOKE')
    status, m = solve_with_deadline(Solver(), None, 0)
    assert status == cp_model.UNKNOWN and not m['deadlineStopRequested']
    assert not watchers()


def test_solver_exception_still_retires_the_monitor():
    class Solver:
        def solve(self, _model):
            raise RuntimeError('CONTROLLED_SOLVE_FAILURE')
    with pytest.raises(RuntimeError, match='CONTROLLED_SOLVE_FAILURE'):
        solve_with_deadline(Solver(), None, 1)
    assert not watchers()


def test_stop_failure_is_explicit_and_does_not_leave_a_late_monitor():
    attempted = threading.Event()

    class Solver:
        def solve(self, _model):
            assert attempted.wait(1)
            return cp_model.UNKNOWN

        def stop_search(self):
            attempted.set()
            raise RuntimeError('CONTROLLED_STOP_FAILURE')
    with pytest.raises(RuntimeError, match='CP_DEADLINE_STOP_FAILED'):
        solve_with_deadline(Solver(), None, .005)
    assert not watchers()


@pytest.mark.parametrize('seconds', [-1, float('nan'), float('inf')])
def test_invalid_deadline_cannot_start_a_monitor(seconds):
    with pytest.raises(ValueError, match='CP_DEADLINE_SECONDS'):
        solve_with_deadline(None, None, seconds)
    assert not watchers()


def test_deadline_unknown_retains_only_the_already_checked_incumbent(monkeypatch):
    data = covered_fixture()
    data['staff'][-1]['preferences'].append({'date': '2026-10-01', 'kind': 'work'})
    unchanged = deepcopy(data)
    original = cp_model.CpSolver.solve
    stops = {}

    def controlled(self, model, callback=None):
        if self.parameters.fix_variables_to_their_hinted_value:
            return original(self, model, callback)
        event = stops.setdefault(self, threading.Event())
        assert event.wait(6), 'DEADLINE_STOP_NOT_REQUESTED'
        return cp_model.UNKNOWN

    def stop(self):
        stops.setdefault(self, threading.Event()).set()

    monkeypatch.setattr(cp_model.CpSolver, 'solve', controlled)
    monkeypatch.setattr(cp_model.CpSolver, 'stop_search', stop)
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4',
                         bulk_solution_transfer=True, covered_off_hints=True, deadline_stop=True)
    assert data == unchanged
    assert result['solverStatus'] == 'FEASIBLE'
    assert result['validation']['status'] == 'VERIFIED'
    assert result['metrics']['deadlineStopEnabled'] is True
    assert result['stages'][-1]['status'] == 'UNKNOWN'
    assert result['stages'][-1]['deadlineStopRequested'] is True
    assert check_multi(data, result['assignments'])['objectiveVector'] == result['validation']['objectiveVector']
    assert not watchers()


def test_deadline_candidate_setting_requires_a_real_boolean():
    with pytest.raises(ValueError, match='CP_DEADLINE_STOP_SETTING'):
        solve_multi(covered_fixture(), 1, deadline_stop='true')


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
def test_monitor_does_not_change_cp_constraints_objectives_or_checked_quality(monkeypatch, priority):
    data = covered_fixture()
    data['priority'] = priority
    original = cp_model.CpSolver.solve
    traces = []

    def observe(solver, model, *args, **kwargs):
        clone = model.clone()
        traces[-1].append(str(clone.proto))
        return original(solver, model, *args, **kwargs)

    monkeypatch.setattr(cp_model.CpSolver, 'solve', observe)
    results = []
    for enabled in (False, True):
        traces.append([])
        results.append(solve_multi(data, 5, hint_strategy='balanced-incumbent-v4',
            bulk_solution_transfer=True, covered_off_hints=True, deadline_stop=enabled))
    assert traces[0] == traces[1]
    assert results[0]['validation']['objectiveVector'] == results[1]['validation']['objectiveVector']
    assert all(check_multi(data, r['assignments'])['status'] == 'VERIFIED' for r in results)
    assert not watchers()
