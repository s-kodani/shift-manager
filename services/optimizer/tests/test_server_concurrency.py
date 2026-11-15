"""Real loopback HTTP boundary; engines controlled, no solver quality claim."""
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from optimizer import server
from test_zero_proofs import zero_fixture


@pytest.fixture
def live_server():
    http = server.OptimizerHTTPServer(('127.0.0.1', 0))
    thread = Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{http.server_port}'
    finally:
        http.shutdown()
        http.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()


def call(base, path, body=None, profile=None):
    headers = {} if body is None else {'Content-Type': 'application/json'}
    if profile:
        headers['X-Optimizer-Profile'] = profile
    request = Request(base + path, data=None if body is None else json.dumps(body).encode(),
                      headers=headers)
    try:
        response = urlopen(request, timeout=2)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.loads(response.read())


@pytest.mark.parametrize('profile', [None, server.PROCESS_PROFILE])
def test_health_and_busy_check_remain_responsive_during_blocked_solve(live_server, monkeypatch, profile):
    entered, release = Event(), Event()
    calls = []

    def solve(data, **settings):
        entered.set()
        assert release.wait(timeout=5)
        return {'fictional': True}

    monkeypatch.setattr(server, 'solve_multi', solve)
    monkeypatch.setattr(server, 'solve_in_process', lambda data, seconds: solve(data))
    monkeypatch.setattr(server, 'check_multi', lambda *args: calls.append(True) or {'status': 'VERIFIED'})
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(call, live_server, '/solve', {'schemaVersion': 'multi-task-v1'}, profile)
        try:
            assert entered.wait(timeout=2)
            assert call(live_server, '/health')[0] == 200
            assert not pending.done()
            assert call(live_server, '/check', {'input': {}, 'assignments': []}) == (503, {'error': 'BUSY'})
            assert calls == []
        finally:
            release.set()
        assert pending.result(timeout=2)[0] == 200
    assert call(live_server, '/check', {'input': {}, 'assignments': []}) == (200, {'status': 'VERIFIED'})
    assert calls == [True]


def test_engine_error_releases_work_gate_for_next_check(live_server, monkeypatch):
    def fail(*args, **kwargs):
        raise ValueError('fictional secret marker must never leave the server')

    monkeypatch.setattr(server, 'solve_multi', fail)
    monkeypatch.setattr(server, 'check_multi', lambda *args: {'status': 'VERIFIED'})
    assert call(live_server, '/solve', {'schemaVersion': 'multi-task-v1'}) == (400, {'error': 'ValueError'})
    assert call(live_server, '/check', {'input': {}, 'assignments': []}) == (200, {'status': 'VERIFIED'})


@pytest.mark.parametrize('path', ['/solve', '/check', '/benchmark'])
@pytest.mark.parametrize('outcome', ['success', 'invalid', 'failure'])
def test_completed_work_allows_next_check_while_previous_reply_finishes(
        live_server, monkeypatch, path, outcome):
    """A fully received response must not leave a finished engine BUSY."""
    sent, finish_reply, returned = Event(), Event(), Event()
    engine_calls = []
    original_reply = server.Handler.reply

    def engine(*args, **kwargs):
        engine_calls.append(True)
        if len(engine_calls) == 1 and outcome != 'success':
            if outcome == 'invalid':
                raise ValueError('fictional private input')
            raise RuntimeError('fictional private engine failure')
        return {'status': 'VERIFIED'}

    def delayed_reply(handler, status, body):
        original_reply(handler, status, body)
        if handler.path == path and not sent.is_set():
            sent.set()
            try:
                assert finish_reply.wait(timeout=5)
            finally:
                returned.set()

    monkeypatch.setattr(server, 'solve_multi', engine)
    monkeypatch.setattr(server, 'check_multi', engine)
    monkeypatch.setattr(server, 'solve_benchmark', engine)
    monkeypatch.setattr(server.Handler, 'reply', delayed_reply)
    payload = {'input': {}, 'assignments': []} if path == '/check' else {
        'schemaVersion': 'multi-task-v1'}
    try:
        first_status, first_body = call(live_server, path, payload)
        assert sent.wait(timeout=2)
        assert not returned.is_set()
        assert first_status == {'success': 200, 'invalid': 400, 'failure': 500}[outcome]
        if outcome != 'success':
            assert first_body == {'error': 'ValueError' if outcome == 'invalid' else 'MODEL_ERROR'}
        assert call(live_server, '/check', {'input': {}, 'assignments': []}) == (
            200, {'status': 'VERIFIED'})
        assert engine_calls == [True, True]
    finally:
        finish_reply.set()
        assert returned.wait(timeout=2)


@pytest.mark.parametrize('profile', ['mvp-joint-v1', server.PROCESS_PROFILE])
def test_real_independent_http_check_rejects_tampering_after_internal_certificate_reuse(live_server, profile):
    data = zero_fixture()
    status, solved = call(live_server, '/solve', data, profile=profile)
    assert status == 200
    assert solved['metrics']['finalCheckKind'] == 'REUSED_VERIFIED'
    assert call(live_server, '/check', {'input': data, 'assignments': solved['assignments']})[1]['status'] == 'VERIFIED'
    solved['assignments'][0]['date'] = solved['assignments'][1]['date']
    status, checked = call(live_server, '/check', {'input': data, 'assignments': solved['assignments']})
    assert status == 200
    assert checked['status'] == 'INVALID'
    assert checked['violations'] == ['ASSIGNMENT_KEYS']


def test_disconnected_peer_does_not_raise_or_emit_a_second_response(monkeypatch):
    class Disconnected:
        def write(self, _bytes):
            raise BrokenPipeError

    handler = object.__new__(server.Handler)
    handler.wfile = Disconnected()
    statuses = []
    monkeypatch.setattr(handler, 'send_response', statuses.append)
    monkeypatch.setattr(handler, 'send_header', lambda *args: None)
    monkeypatch.setattr(handler, 'end_headers', lambda: None)
    handler.reply(200, {'status': 'ok'})
    assert statuses == [200]
    assert handler.close_connection is True
