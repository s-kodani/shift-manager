"""Explicit diagnostic candidate: request asynchronous stop at a call deadline.

StopSearch is cooperative. This observer cannot promise a hard return deadline;
the HTTP/Container owner still has its independent execution/termination bound.
"""
import math
import threading
import time

from ortools.sat.python import cp_model


def solve_with_deadline(solver, model, seconds, callback=None):
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError('CP_DEADLINE_SECONDS')
    metrics = {'deadlineStopRequested': False, 'deadlineStopAttempts': 0,
               'deadlineStopFirstSeconds': None, 'deadlineMonitorJoined': True}
    if seconds == 0:
        return cp_model.UNKNOWN, metrics
    done = threading.Event()
    started = time.monotonic()
    failures = []

    def monitor():
        if done.wait(max(0, seconds - (time.monotonic() - started))):
            return
        metrics['deadlineStopRequested'] = True
        metrics['deadlineStopFirstSeconds'] = time.monotonic() - started
        while not done.is_set():
            try:
                metrics['deadlineStopAttempts'] += 1
                solver.stop_search()
            except Exception as error:
                failures.append(error)
                return
            # The public wrapper can still be absent on the first request.
            # Retry until this same solve returns, never into a subsequent call.
            if done.wait(.01):
                return

    watcher = threading.Thread(target=monitor, name='optimizer-cp-deadline')
    watcher.start()
    try:
        status = solver.solve(model, callback) if callback is not None else solver.solve(model)
    finally:
        done.set()
        watcher.join()
    if failures:
        raise RuntimeError('CP_DEADLINE_STOP_FAILED') from failures[0]
    return status, metrics
