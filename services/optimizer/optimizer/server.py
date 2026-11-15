import json
import hashlib
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

from jsonschema import ValidationError

from .model import solve
from .multi_model import solve_multi
from .multi_checker import check_multi
from .benchmark_request import solve_benchmark
from .solve_request import SAVED_PROFILE, decode_saved_request
from .process_budget import solve_in_process, ProcessExecutionError
from .early_candidate import checked_initial_candidate
from .split_process import solve_split

INITIAL_CANDIDATE_PROFILE = 'mvp-checked-hint-v1'
EARLY_CHECKPOINT_PROFILE = 'mvp-early-checkpoint-v1'
SPLIT_PROFILE = 'mvp-split-process-v1'

SOLVE_PROFILES = {'mvp-joint-v1': {'budget_seconds': 120, 'hint_strategy': 'balanced-incumbent-v4',
                                'bulk_solution_transfer': True}}
SOLVE_PROFILES[SAVED_PROFILE] = dict(SOLVE_PROFILES['mvp-joint-v1'])
# Explicit technical candidate for direct diagnostics. Workers keep requesting
# mvp-joint-v1 and reject a differently labelled result before normal storage.
SOLVE_PROFILES['mvp-joint-main-no-presolve-v1'] = {
    **SOLVE_PROFILES['mvp-joint-v1'], 'main_presolve': False}
SOLVE_PROFILES['mvp-joint-tight-run-bounds-v1'] = {
    **SOLVE_PROFILES['mvp-joint-v1'], 'tight_run_bounds': True}
SOLVE_PROFILES['mvp-joint-bulk-solution-transfer-v1'] = {
    **SOLVE_PROFILES['mvp-joint-v1'], 'bulk_solution_transfer': True}
# Fixed original transfer for reproducible diagnostics after normal adoption.
SOLVE_PROFILES['mvp-joint-loop-solution-transfer-v1'] = {
    **SOLVE_PROFILES['mvp-joint-v1'], 'bulk_solution_transfer': False}
SOLVE_PROFILES['mvp-joint-covered-off-hints-v1'] = {
    **SOLVE_PROFILES['mvp-joint-v1'], 'covered_off_hints': True}
SOLVE_PROFILES['mvp-joint-deadline-stop-v1'] = {
    **SOLVE_PROFILES['mvp-joint-covered-off-hints-v1'], 'deadline_stop': True}
PROCESS_PROFILE = 'mvp-joint-process-budget-v1'
PROCESS_STOP_PROFILE = 'mvp-joint-process-stop-75-v1'
CALENDAR_PROFILE = 'mvp-joint-calendar-roster-v1'
CALENDAR_FALLBACK_PROFILE = 'mvp-joint-calendar-fallback-v1'
COMPACT_PROFILE = 'mvp-joint-compact-minutes-v1'
SHARED_PROFILE = 'mvp-joint-shared-build-v1'
COMMON_PROFILE = 'mvp-joint-common-run-v1'


class OptimizerHTTPServer(ThreadingHTTPServer):
    """Health remains responsive; only one solve/check/benchmark runs at once."""

    def __init__(self, address, handler=None):
        self.work_lock = Lock()
        super().__init__(address, handler or Handler)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # No request payload, credentials or tokens in access logs.

    def do_GET(self):
        if self.path != '/health':
            self.send_error(404)
            return
        self.reply(200, {'status': 'ok', 'scope': 'single-task-v0',
                         'profiles': ['single-task-v0', 'multi-task-v1'],
                         'sourceSha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                          for p in sorted(Path(__file__).parent.glob('*.py'))},
                         'runtime': {'uid': os.getuid(),
                                     'hasShell': os.path.exists('/bin/sh'),
                                     'deploymentId': os.environ.get('CLOUDFLARE_DEPLOYMENT_ID')}})

    def do_POST(self):
        if self.path not in ('/solve', '/check', '/benchmark', '/initial-candidate'):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            self.reply(400, {'error': 'INVALID_CONTENT_LENGTH'})
            return
        profile = self.headers.get('X-Optimizer-Profile')
        limit = (16_000_000 if self.path == '/check' or
                 (self.path == '/solve' and profile == SAVED_PROFILE) else 4_000_000)
        if not 0 < length <= limit:
            self.reply(413, {'error': 'BODY_LIMIT'})
            return
        if not self.server.work_lock.acquire(blocking=False):
            self.reply(503, {'error': 'BUSY'})
            return
        try:
            data = json.loads(self.rfile.read(length))
            if self.path == '/initial-candidate':
                if profile != INITIAL_CANDIDATE_PROFILE:
                    raise ValueError('INITIAL_CANDIDATE_PROFILE')
                result = checked_initial_candidate(data, 90)
                result['calculationProfile'] = INITIAL_CANDIDATE_PROFILE
            elif self.path == '/benchmark':
                result = solve_benchmark(data)
            elif self.path == '/check':
                result = check_multi(data['input'], data['assignments'])
            else:
                candidate, source = None, None
                if profile == SAVED_PROFILE:
                    data, candidate, source = decode_saved_request(data)
                engine = solve_multi if data.get('schemaVersion') == 'multi-task-v1' else solve
                if profile is not None and (engine is not solve_multi or
                        profile not in (*SOLVE_PROFILES, PROCESS_PROFILE, PROCESS_STOP_PROFILE, CALENDAR_PROFILE, CALENDAR_FALLBACK_PROFILE, COMPACT_PROFILE, SHARED_PROFILE, COMMON_PROFILE, EARLY_CHECKPOINT_PROFILE, SPLIT_PROFILE)):
                    raise ValueError('SOLVE_PROFILE')
                settings = dict(SOLVE_PROFILES[profile]) if profile in SOLVE_PROFILES else {}
                if profile == SAVED_PROFILE:
                    settings['saved_assignments'] = candidate
                result = (solve_split(data,240) if profile==SPLIT_PROFILE else
                          solve_in_process(data,120,calendar_roster=True,compact_minutes=True,
                          shared_build_facts=True,build_variable_limit=3_500_000,common_runs=True,early_checkpoint=True) if profile==EARLY_CHECKPOINT_PROFILE else
                          solve_in_process(data,120,calendar_roster=True,compact_minutes=True,
                          shared_build_facts=True,build_variable_limit=3_500_000,common_runs=True) if profile==COMMON_PROFILE else
                          solve_in_process(data,120,calendar_roster=True,compact_minutes=True,
                          shared_build_facts=True,build_variable_limit=3_500_000) if profile==SHARED_PROFILE else
                          solve_in_process(data, 120, calendar_roster=True, compact_minutes=True) if profile == COMPACT_PROFILE else
                          solve_in_process(data, 120, calendar_fallback=True) if profile == CALENDAR_FALLBACK_PROFILE else
                          solve_in_process(data, 120, calendar_roster=True) if profile == CALENDAR_PROFILE else
                          solve_in_process(data, 120, execution_seconds=75) if profile == PROCESS_STOP_PROFILE else
                          solve_in_process(data, 120) if profile == PROCESS_PROFILE else
                          engine(data, **settings) if profile is not None else
                          engine(data, budget_seconds=20))
                result['calculationProfile'] = profile or 'legacy-poc-v1'
                if profile == SAVED_PROFILE:
                    result['savedCandidateSource'] = source
            status = 200
        except (ValidationError, ValueError, KeyError, TypeError) as error:
            status, result = 400, {'error': type(error).__name__}
        except ProcessExecutionError as error:
            status, result = 500, {'error': 'MODEL_ERROR'}
            if profile in (COMMON_PROFILE, SHARED_PROFILE, COMPACT_PROFILE, CALENDAR_PROFILE, CALENDAR_FALLBACK_PROFILE, PROCESS_STOP_PROFILE, EARLY_CHECKPOINT_PROFILE, SPLIT_PROFILE):
                result['diagnostics'] = error.diagnostics
        except Exception:
            status, result = 500, {'error': 'MODEL_ERROR'}
        finally:
            self.server.work_lock.release()
        # The engine has finished. A client can receive the complete body and
        # issue its next check before this thread returns from the socket write.
        # Keep BUSY for active work, not for transport of an already final result.
        self.reply(status, result)

    def reply(self, status, body):
        content = json.dumps(body, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A disconnected health/client request cannot receive a reply.


if __name__ == '__main__':
    OptimizerHTTPServer(('0.0.0.0', 8080)).serve_forever()
