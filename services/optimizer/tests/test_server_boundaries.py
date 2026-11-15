import io
import json
import hashlib
from pathlib import Path
from threading import Lock
from types import SimpleNamespace

import pytest

from optimizer import server


def test_health_exposes_source_provenance_without_request_data(monkeypatch):
    handler = object.__new__(server.Handler)
    handler.path = '/health'
    responses = []
    monkeypatch.setattr(handler, 'reply', lambda status, payload: responses.append((status, payload)))
    handler.do_GET()
    status, body = responses[0]
    assert status == 200
    assert body['sourceSha256']['server.py'] == hashlib.sha256(Path(server.__file__).read_bytes()).hexdigest()
    assert 'saved_candidate.py' in body['sourceSha256']
    assert set(body['runtime']) == {'uid', 'hasShell', 'deploymentId'}


def request(path, body, monkeypatch, length=None, profile=None):
    handler = object.__new__(server.Handler)
    handler.path = path
    handler.headers = {'Content-Length': str(len(body)) if length is None else length}
    if profile is not None:
        handler.headers['X-Optimizer-Profile'] = profile
    handler.rfile = io.BytesIO(body)
    handler.server = SimpleNamespace(work_lock=Lock())
    responses = []
    monkeypatch.setattr(handler, 'reply', lambda status, payload: responses.append((status, payload)))
    handler.do_POST()
    return responses


def test_large_checker_request_does_not_raise_solver_input_limit(monkeypatch):
    calls = []
    monkeypatch.setattr(server, 'check_multi', lambda data, assignments: calls.append(
        (data, assignments)) or {'status': 'VERIFIED'})
    body = json.dumps({'input': {}, 'assignments': ['x' * 4_000_000]}).encode()
    assert request('/check', body, monkeypatch) == [(200, {'status': 'VERIFIED'})]
    assert len(calls) == 1  # Transport boundary only; no real-checker claim.
    for path in ('/solve', '/benchmark'):
        assert request(path, body, monkeypatch) == [(413, {'error': 'BODY_LIMIT'})]


@pytest.mark.parametrize('length, expected', [
    ('16000001', (413, {'error': 'BODY_LIMIT'})),
    ('-1', (413, {'error': 'BODY_LIMIT'})),
    ('invalid', (400, {'error': 'INVALID_CONTENT_LENGTH'})),
])
def test_bad_lengths_are_rejected_before_reading(monkeypatch, length, expected):
    assert request('/check', b'', monkeypatch, length) == [expected]


def test_reply_is_compact_utf8_json(monkeypatch):
    handler = object.__new__(server.Handler)
    handler.wfile = io.BytesIO()
    headers = {}
    monkeypatch.setattr(handler, 'send_response', lambda status: None)
    monkeypatch.setattr(handler, 'send_header', lambda key, value: headers.update({key: value}))
    monkeypatch.setattr(handler, 'end_headers', lambda: None)
    server.Handler.reply(handler, 200, {'a': [1, 2], 'reason': '架空'})
    wire = handler.wfile.getvalue()
    assert b': ' not in wire and b', ' not in wire
    assert json.loads(wire) == {'a': [1, 2], 'reason': '架空'}
    assert headers['Content-Length'] == str(len(wire))
    assert headers['Connection'] == 'close'


@pytest.mark.parametrize('profile, expected', [(None, {'budget_seconds': 20}),
    ('mvp-joint-v1', {'budget_seconds': 120, 'hint_strategy': 'balanced-incumbent-v4',
                      'bulk_solution_transfer': True}),
    ('mvp-joint-main-no-presolve-v1', {'budget_seconds': 120,
                                    'hint_strategy': 'balanced-incumbent-v4', 'main_presolve': False,
                                    'bulk_solution_transfer': True}),
    ('mvp-joint-tight-run-bounds-v1', {'budget_seconds': 120,
                                   'hint_strategy': 'balanced-incumbent-v4', 'tight_run_bounds': True,
                                   'bulk_solution_transfer': True}),
    ('mvp-joint-bulk-solution-transfer-v1', {'budget_seconds': 120,
                                        'hint_strategy': 'balanced-incumbent-v4', 'bulk_solution_transfer': True}),
    ('mvp-joint-loop-solution-transfer-v1', {'budget_seconds': 120,
                                        'hint_strategy': 'balanced-incumbent-v4', 'bulk_solution_transfer': False}),
    ('mvp-joint-covered-off-hints-v1', {'budget_seconds': 120,
                                    'hint_strategy': 'balanced-incumbent-v4',
                                    'bulk_solution_transfer': True, 'covered_off_hints': True}),
    ('mvp-joint-deadline-stop-v1', {'budget_seconds': 120,
                                 'hint_strategy': 'balanced-incumbent-v4',
                                 'bulk_solution_transfer': True, 'covered_off_hints': True,
                                 'deadline_stop': True})])
def test_versioned_normal_profile_is_bounded_and_preserved_on_results(monkeypatch, profile, expected):
    calls = []
    monkeypatch.setattr(server, 'solve_multi', lambda data, **settings: calls.append(settings) or {})
    result = request('/solve', b'{"schemaVersion":"multi-task-v1"}', monkeypatch, profile=profile)
    assert calls == [expected]
    assert result == [(200, {'calculationProfile': profile or 'legacy-poc-v1'})]


@pytest.mark.parametrize('profile', ['arbitrary', 'balanced-incumbent-v4', '240'])
def test_http_cannot_inject_arbitrary_strategy_or_budget(monkeypatch, profile):
    calls = []
    monkeypatch.setattr(server, 'solve_multi', lambda *args, **kwargs: calls.append(True))
    assert request('/solve', b'{"schemaVersion":"multi-task-v1"}', monkeypatch, profile=profile) == [(400, {'error': 'ValueError'})]
    assert calls == []


def test_process_diagnostic_is_explicit_and_cannot_alter_normal_settings(monkeypatch):
    calls = []
    monkeypatch.setattr(server, 'solve_in_process', lambda data, seconds: calls.append(seconds) or {})
    monkeypatch.setattr(server, 'solve_multi', lambda *a, **k: pytest.fail('IN_PROCESS_SOLVE'))
    assert request('/solve', b'{"schemaVersion":"multi-task-v1"}', monkeypatch,
                   profile=server.PROCESS_PROFILE) == [(200, {'calculationProfile': server.PROCESS_PROFILE})]
    assert calls == [120]


def test_forced_stop_profile_has_fixed_parent_75_and_internal_120(monkeypatch):
    calls = []
    monkeypatch.setattr(server, 'solve_in_process', lambda data, seconds, **kw: calls.append((seconds, kw)) or {})
    assert request('/solve', b'{"schemaVersion":"multi-task-v1"}', monkeypatch,
        profile=server.PROCESS_STOP_PROFILE) == [(200, {'calculationProfile': server.PROCESS_STOP_PROFILE})]
    assert calls == [(120, {'execution_seconds': 75})]


def test_calendar_profile_is_explicit_and_keeps_internal_budget(monkeypatch):
    calls=[]
    monkeypatch.setattr(server,'solve_in_process',lambda data,seconds,**kw:calls.append((seconds,kw)) or {})
    assert request('/solve',b'{"schemaVersion":"multi-task-v1"}',monkeypatch,
        profile=server.CALENDAR_PROFILE)==[(200,{'calculationProfile':server.CALENDAR_PROFILE})]
    assert calls==[(120,{'calendar_roster':True})]


def test_compact_profile_keeps_calendar_and_minute_storage_explicit(monkeypatch):
    calls=[]
    monkeypatch.setattr(server,'solve_in_process',lambda data,seconds,**kw:calls.append((seconds,kw)) or {})
    assert request('/solve',b'{"schemaVersion":"multi-task-v1"}',monkeypatch,
        profile=server.COMPACT_PROFILE)==[(200,{'calculationProfile':server.COMPACT_PROFILE})]
    assert calls==[(120,{'calendar_roster':True,'compact_minutes':True})]


def test_shared_profile_has_fixed_diagnostic_limits_without_user_parameters(monkeypatch):
    calls=[]
    monkeypatch.setattr(server,'solve_in_process',lambda data,seconds,**kw:calls.append((seconds,kw)) or {})
    assert request('/solve',b'{"schemaVersion":"multi-task-v1"}',monkeypatch,
        profile=server.SHARED_PROFILE)==[(200,{'calculationProfile':server.SHARED_PROFILE})]
    assert calls==[(120,{'calendar_roster':True,'compact_minutes':True,'shared_build_facts':True,
                         'build_variable_limit':3_500_000})]


def test_common_run_profile_is_fixed_and_explicit(monkeypatch):
    calls=[]
    monkeypatch.setattr(server,'solve_in_process',lambda data,seconds,**kw:calls.append((seconds,kw)) or {})
    assert request('/solve',b'{"schemaVersion":"multi-task-v1"}',monkeypatch,
        profile=server.COMMON_PROFILE)==[(200,{'calculationProfile':server.COMMON_PROFILE})]
    assert calls==[(120,{'calendar_roster':True,'compact_minutes':True,'shared_build_facts':True,
                         'build_variable_limit':3_500_000,'common_runs':True})]


def test_multi_task_profile_cannot_change_legacy_single_task_settings(monkeypatch):
    assert request('/solve', b'{}', monkeypatch, profile='mvp-joint-v1') == [(400, {'error': 'ValueError'})]


def seeded_request():
    return {'schemaVersion': 'solve-seed-v1', 'input': {'schemaVersion': 'multi-task-v1'},
            'savedCandidate': {'source': {'draftId': 'fictional-draft', 'draftRevision': 1},
                               'assignments': []}}


@pytest.mark.parametrize('candidate', [True, False])
def test_saved_profile_is_an_explicit_bounded_envelope_with_source_echo(monkeypatch, candidate):
    body = seeded_request()
    if not candidate:
        body['savedCandidate'] = None
    calls = []
    monkeypatch.setattr(server, 'solve_multi', lambda data, **settings: calls.append((data, settings)) or {})
    assert request('/solve', json.dumps(body).encode(), monkeypatch, profile='mvp-joint-seed-v1') == [
        (200, {'calculationProfile': 'mvp-joint-seed-v1',
               'savedCandidateSource': {'draftId': 'fictional-draft', 'draftRevision': 1} if candidate else None})]
    assert calls == [(body['input'], {'budget_seconds': 120, 'hint_strategy': 'balanced-incumbent-v4',
                                    'bulk_solution_transfer': True,
                                    'saved_assignments': [] if candidate else None})]


@pytest.mark.parametrize('kind', ['plain-input', 'extra-setting', 'wrong-schema', 'wrong-input',
                                  'bad-candidate', 'null-assignments', 'bad-source', 'bool-revision'])
def test_saved_envelope_rejects_shape_and_setting_injection_before_solving(monkeypatch, kind):
    body = seeded_request()
    if kind == 'plain-input':
        body = body['input']
    elif kind == 'extra-setting':
        body['budgetSeconds'] = 999
    elif kind == 'wrong-schema':
        body['schemaVersion'] = 'multi-task-v1'
    elif kind == 'wrong-input':
        body['input']['schemaVersion'] = 'single-task-v0'
    elif kind == 'bad-candidate':
        body['savedCandidate']['locks'] = []
    elif kind == 'null-assignments':
        body['savedCandidate']['assignments'] = None
    elif kind == 'bad-source':
        body['savedCandidate']['source']['tenantId'] = 'other'
    else:
        body['savedCandidate']['source']['draftRevision'] = True
    calls = []
    monkeypatch.setattr(server, 'solve_multi', lambda *args, **kwargs: calls.append(True))
    assert request('/solve', json.dumps(body).encode(), monkeypatch, profile='mvp-joint-seed-v1') == [(400, {'error': 'ValueError'})]
    assert calls == []


@pytest.mark.parametrize('kind,expected', [('candidate-large', 200), ('candidate-over', 400),
                                         ('input-over', 400), ('envelope-over', 413)])
def test_saved_transport_keeps_independent_input_and_candidate_bounds(monkeypatch, kind, expected):
    body = seeded_request()
    if kind == 'input-over':
        body['input']['padding'] = 'x' * 4_000_000
    else:
        body['savedCandidate']['assignments'] = ['x' * (16_000_000 if kind == 'envelope-over'
                                                     else 8_000_000 if kind == 'candidate-over' else 4_000_000)]
    calls = []
    monkeypatch.setattr(server, 'solve_multi', lambda *args, **kwargs: calls.append(True) or {})
    assert request('/solve', json.dumps(body).encode(), monkeypatch,
                   profile='mvp-joint-seed-v1')[0][0] == expected
    assert len(calls) == (1 if expected == 200 else 0)


def test_calendar_fallback_profile_only_changes_the_advisory_fallback(monkeypatch):
    calls = []
    monkeypatch.setattr(server, 'solve_in_process', lambda data, seconds, **kw: calls.append((seconds, kw)) or {})
    assert request('/solve', b'{"schemaVersion":"multi-task-v1"}', monkeypatch,
                   profile=server.CALENDAR_FALLBACK_PROFILE) == [(200, {'calculationProfile': server.CALENDAR_FALLBACK_PROFILE})]
    assert calls == [(120, {'calendar_fallback': True})]
