from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from optimizer import calendar_hint
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi
from optimizer.process_budget import solve_in_process
from test_covered_off_hint import covered_fixture


def run(data, enabled, seconds=5, **settings):
    return solve_multi(data, seconds, hint_strategy='balanced-incumbent-v4',
                       bulk_solution_transfer=True, covered_off_hints=True,
                       calendar_fallback=enabled, **settings)


@pytest.mark.parametrize('priority', ['coverage', 'preference'])
@pytest.mark.parametrize('slot', [30, 60])
def test_checked_ordinary_seed_keeps_model_assignments_and_quality_without_calendar(monkeypatch, priority, slot):
    data = covered_fixture()
    data.update(priority=priority, slotMinutes=slot)
    demand = {}
    for row in data['demand']:
        row = dict(row, start=row['start'] - row['start'] % slot)
        row['end'] = row['start'] + slot
        key = row['date'], row['start'], row['taskId']
        demand[key] = row
    data['demand'] = list(demand.values())
    untouched = deepcopy(data)
    original = cp_model.CpSolver.solve
    traces = []
    def observe(solver, model, *a, **kw):
        if solver.parameters.fix_variables_to_their_hinted_value:
            clone = model.clone()
            clone.clear_hints()
            traces.append(str(clone.proto))
            return original(solver, model, *a, **kw)
        return cp_model.UNKNOWN
    monkeypatch.setattr(cp_model.CpSolver, 'solve', observe)
    monkeypatch.setattr(calendar_hint, 'calendar_hints', lambda *a, **kw: pytest.fail('ORDINARY_CANDIDATE_MUST_PREVENT_CALENDAR'))
    baseline, candidate = run(data, False), run(data, True)
    assert data == untouched
    assert traces[0] == traces[1]
    assert baseline['assignments'] == candidate['assignments']
    assert candidate['validation']['status'] == 'VERIFIED'
    assert candidate['validation']['objectiveVector'] == baseline['validation']['objectiveVector']
    assert candidate['metrics']['calendarFallbackHintsEnabled'] is True
    assert candidate['metrics']['calendarRosterHintsEnabled'] is False
    assert candidate['metrics']['calendarFallbackAttempt'] is None


@pytest.mark.parametrize('first_status', [cp_model.INFEASIBLE, cp_model.UNKNOWN])
@pytest.mark.parametrize('priority', ['coverage', 'preference'])
def test_only_unverified_restricted_seed_triggers_calendar_and_independent_check(monkeypatch, first_status, priority):
    data = covered_fixture()
    data['priority'] = priority
    untouched = deepcopy(data)
    original_solve, original_calendar = cp_model.CpSolver.solve, calendar_hint.calendar_hints
    restricted, calendar_calls = [], []
    def calendar(*args, **kwargs):
        calendar_calls.append(True)
        return original_calendar(*args, **kwargs)
    def solve(solver, model, *a, **kw):
        if model.proto.name == 'advisory-calendar-hint-v1':
            return original_solve(solver, model, *a, **kw)
        if solver.parameters.fix_variables_to_their_hinted_value:
            restricted.append(solver.parameters.max_time_in_seconds)
            if len(restricted) == 1:
                return first_status
            return original_solve(solver, model, *a, **kw)
        return cp_model.UNKNOWN
    monkeypatch.setattr(calendar_hint, 'calendar_hints', calendar)
    monkeypatch.setattr(cp_model.CpSolver, 'solve', solve)
    checkpoints = []
    result = run(data, True, checkpoint_callback=checkpoints.append)
    assert checkpoints and checkpoints[0]['metrics']['calendarFallbackAttempt']['adopted'] is True
    assert data == untouched
    assert len(calendar_calls) == 1 and len(restricted) == 2
    assert 0 <= restricted[1] <= restricted[0] <= 5
    assert result['solverStatus'] in ('FEASIBLE', 'OPTIMAL')
    assert result['metrics']['coveredOffHintAttempt']['status'] == cp_model.CpSolver().status_name(first_status)
    assert result['metrics']['calendarFallbackAttempt']['adopted'] is True
    assert check_multi(data, result['assignments'])['objectiveVector'] == result['validation']['objectiveVector']


def test_real_process_transfers_fallback_setting_and_rechecks_result():
    data = covered_fixture()
    result = solve_in_process(data, 3, calendar_fallback=True)
    assert result['metrics']['calendarFallbackHintsEnabled'] is True
    assert result['metrics']['calendarRosterHintsEnabled'] is False
    assert result['metrics']['processBudget']['childReaped'] is True
    assert result['metrics']['processBudget']['parentValidation'] == 'VERIFIED'
    assert check_multi(data, result['assignments'])['status'] == 'VERIFIED'


@pytest.mark.parametrize('setting', [None, 0, 1, 'true'])
def test_fallback_setting_is_boolean(setting):
    with pytest.raises(ValueError, match='CALENDAR_FALLBACK_SETTING'):
        run(covered_fixture(), setting)


def test_fallback_rejects_unconditional_calendar_or_non_v4_configuration():
    with pytest.raises(ValueError, match='CALENDAR_FALLBACK_SETTING'):
        solve_multi(covered_fixture(), calendar_fallback=True)
    with pytest.raises(ValueError, match='CALENDAR_FALLBACK_SETTING'):
        solve_in_process(covered_fixture(), 3, calendar_fallback=True, calendar_roster=True)


def test_missing_history_does_not_allow_calendar_to_invent_work_or_feasibility(monkeypatch):
    data = covered_fixture()
    data['history'] = []
    original = cp_model.CpSolver.solve
    def solve(solver, model, *a, **kw):
        assert model.proto.name != 'advisory-calendar-hint-v1'
        return original(solver, model, *a, **kw) if solver.parameters.fix_variables_to_their_hinted_value else cp_model.UNKNOWN
    monkeypatch.setattr(cp_model.CpSolver, 'solve', solve)
    result = run(data, True)
    assert result['assignments'] is None
    assert result['solverStatus'] == 'UNKNOWN'
    assert result['validation']['status'] == 'NOT_RUN'
    assert result['publication'] == 'BLOCKED_A1'
