from copy import deepcopy
from itertools import product

import pytest

from optimizer.contract import dates
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from optimizer.multi_model import solve_multi


def fixture(case, slot_minutes):
    data = multi_synthetic(1, slot_minutes, tiny=True)
    staff = data['staff'][0]
    sid, day = staff['id'], '2026-10-01'
    shift = {'patternId': 'short', 'start': 540, 'end': 660,
             'breakKind': 'auto', 'break': None, 'workedMinutes': 120, 'cancelled': []}
    # Hand-written active intervals, independent of the model's activity code.
    intervals = [(540, 660)]
    if case == 'meeting':
        data['events'] = [{'id': 'fictional-meeting', 'date': day, 'start': 570, 'end': 600,
                           'kind': 'meeting', 'staffIds': [sid]}]
        intervals = [(540, 570), (600, 660)]
    elif case == 'fragmented':
        data['events'] = [{'id': 'fictional-training', 'date': day, 'start': 577, 'end': 584,
                           'kind': 'training', 'staffIds': [sid]}]
        intervals = [(540, 577), (584, 660)]
        data['transitions'][0]['minutes'] = 7
    elif case in ('fixed-break', 'cancelled'):
        data['patterns'][0].update(breakKind='fixed', fixedBreak=[570, 600])
        shift.update(breakKind='fixed', **{'break': [570, 600]}, workedMinutes=90)
        intervals = [(540, 570), (600, 660)]
        if case == 'cancelled':
            data['mode'] = 'reallocation'
            shift.update(cancelled=[[600, 630]], workedMinutes=60)
            intervals = [(540, 570), (630, 660)]
            data['published'] = [{'staffId': sid, 'date': d.isoformat(),
                                  'shift': deepcopy(shift) if d.day == 1 else None}
                                 for d in dates(data)]
    elif case == 'event-only':
        data['events'] = [{'id': 'fictional-training', 'date': day, 'start': 540, 'end': 660,
                           'kind': 'training', 'staffIds': [sid]}]
        intervals = []
    elif case == 'fixed-exception':
        data['locks'] = [{'id': 'fictional-lock', 'staffId': sid, 'date': day,
                          'parts': ['pattern', 'time', 'break'], 'shift': deepcopy(shift)}]
        staff['unavailable'].append({'date': day, 'start': 540, 'end': 600})
        data['exceptions'] = [{'id': 'fictional-exception', 'staffId': sid, 'date': day,
                               'lockId': 'fictional-lock', 'start': 540, 'end': 600,
                               'reason': 'Fictional approved fixed exception'}]
    elif case != 'plain':
        raise AssertionError(case)
    staff['rules'][0].update(monthlyMin=shift['workedMinutes'], monthlyMax=shift['workedMinutes'])
    return data, shift, intervals


CASES = ['plain', 'meeting', 'fragmented', 'fixed-break', 'cancelled', 'event-only', 'fixed-exception']


def enumerated_assignments(data, shift, intervals):
    minutes = {m for start, end in intervals for m in range(start, end)}
    slots = sorted({m - m % data['slotMinutes'] for m in minutes})
    for selected in product(['phone', 'backoffice'], repeat=len(slots)):
        by_slot = dict(zip(slots, selected))
        # Output is one full logical task slot when it contains active time.
        # The checker independently excludes rest/cancel/event minutes inside
        # that block; fragmented minute intervals are not output task blocks.
        blocks = [{'start': slot, 'end': slot + data['slotMinutes'],
                   'taskId': by_slot[slot], 'roleId': None} for slot in slots]
        yield [{'staffId': data['staff'][0]['id'], 'date': d.isoformat(),
                'shift': deepcopy(shift) if d.day == 1 else None,
                'blocks': deepcopy(blocks) if d.day == 1 else []} for d in dates(data)]


@pytest.mark.parametrize('slot_minutes', [30, 60])
@pytest.mark.parametrize('case', CASES)
def test_tighter_domains_preserve_every_other_model_fact(monkeypatch, case, slot_minutes):
    from optimizer import multi_model

    data, _, intervals = fixture(case, slot_minutes)
    original = deepcopy(data)
    captured = []

    class Captured(Exception):
        pass

    def capture(_solver, model, *args, **kwargs):
        captured.append(model.clone())
        raise Captured()

    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', capture)
    for tight in (False, True):
        with pytest.raises(Captured):
            solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', tight_run_bounds=tight)
    old, new = captured
    active_count = sum(end - start for start, end in intervals)
    runs = 0
    for left, right in zip(old.proto.variables, new.proto.variables, strict=True):
        assert left.name == right.name
        if left.name.startswith('run:'):
            runs += 1
            assert list(left.domain) == [0, 1440]
            assert list(right.domain) == [0, active_count]
            right.domain.clear()
            right.domain.extend(left.domain)
    assert bool(runs) == bool(active_count)
    # Includes all variable definitions, constraints, objective and initial
    # hints. Normalize only the proved redundant run domain before comparing.
    assert str(new.proto) == str(old.proto)
    assert data == original


@pytest.mark.parametrize('slot_minutes', [30, 60])
@pytest.mark.parametrize('case', CASES)
def test_tighter_domains_match_independent_exhaustive_choices(case, slot_minutes):
    data, shift, intervals = fixture(case, slot_minutes)
    unchanged = deepcopy(data)
    reports = [check_multi(data, rows) for rows in enumerated_assignments(data, shift, intervals)]
    feasible = [r['objectiveVector'] for r in reports if r['status'] == 'VERIFIED']
    assert feasible
    for tight in (False, True):
        result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', tight_run_bounds=tight)
        assert result['solverStatus'] == 'OPTIMAL'
        assert result['validation']['status'] == 'VERIFIED'
        assert check_multi(data, result['assignments'])['objectiveVector'] == min(feasible)
        assert result['metrics']['tightRunBoundsEnabled'] is tight
        summary = result['metrics']['runDomainSummary']
        active_count = sum(end - start for start, end in intervals)
        assert summary['maximumUpper'] == ((active_count if tight else 1440) if active_count else 0)
        assert summary['sumUpper'] == summary['variables'] * summary['maximumUpper']
    assert data == unchanged


@pytest.mark.parametrize('slot_minutes', [30, 60])
def test_impossible_minimum_continuity_remains_infeasible(slot_minutes):
    data, shift, intervals = fixture('cancelled', slot_minutes)
    for task in data['tasks']:
        task['minimumMinutes'] = 61  # Only 60 active minutes remain, bridged over the interruption.
    assert all(check_multi(data, rows)['status'] == 'INVALID'
               for rows in enumerated_assignments(data, shift, intervals))
    for tight in (False, True):
        assert solve_multi(data, 5, tight_run_bounds=tight)['solverStatus'] == 'INFEASIBLE'


def test_invalid_technical_setting_is_rejected_and_budget_failure_identifies_domains():
    data, _, _ = fixture('plain', 30)
    with pytest.raises(ValueError, match='TIGHT_RUN_BOUNDS_SETTING'):
        solve_multi(data, tight_run_bounds=1)
    result = solve_multi(data, 0, tight_run_bounds=True)
    assert result['solverStatus'] == 'UNKNOWN'
    assert result['validation']['status'] == 'NOT_RUN'
    assert result['metrics']['tightRunBoundsEnabled'] is True


@pytest.mark.parametrize('slot_minutes', [30, 60])
def test_multiple_patterns_and_automatic_break_positions_preserve_all_candidates(monkeypatch, slot_minutes):
    from optimizer import multi_model

    data, short, short_intervals = fixture('plain', slot_minutes)
    data['patterns'].append({'id': 'long', 'start': 540, 'end': 720, 'breakKind': 'auto'})
    data['staff'][0]['rules'][0]['monthlyMax'] = 150
    choices = [(short, short_intervals)]
    for start in (570, 600, 630, 660):
        shift = {**short, 'patternId': 'long', 'end': 720, 'break': [start, start + 30],
                 'workedMinutes': 150}
        choices.append((shift, [(540, start), (start + 30, 720)]))
    expected = []
    for shift, intervals in choices:
        for rows in enumerated_assignments(data, shift, intervals):
            report = check_multi(data, rows)
            if report['status'] == 'VERIFIED':
                expected.append(report['objectiveVector'])
    assert expected
    # Union of the long candidates' active minutes is 180, but no selected
    # candidate has more than 150 active minutes. Off remains a candidate too.
    original_solve = multi_model.cp_model.CpSolver.solve
    captured = []

    def observe(solver, model, *args, **kwargs):
        if not captured:
            captured.append(model.clone())
        return original_solve(solver, model, *args, **kwargs)

    monkeypatch.setattr(multi_model.cp_model.CpSolver, 'solve', observe)
    result = solve_multi(data, 5, hint_strategy='balanced-incumbent-v4', tight_run_bounds=True)
    assert result['solverStatus'] == 'OPTIMAL'
    assert check_multi(data, result['assignments'])['objectiveVector'] == min(expected)
    run_domains = [list(v.domain) for v in captured[0].proto.variables if v.name.startswith('run:')]
    assert run_domains and all(domain == [0, 150] for domain in run_domains)
