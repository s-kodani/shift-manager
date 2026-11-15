"""A single, content-bound VERIFIED certificate owned by one solve invocation.

This is not used by the independent HTTP checker or by persistence/publication.
Changing any input or assignment, even in-place, requires a fresh check.
"""
from copy import deepcopy
import hashlib
import json
import time


class CandidateCertificate:
    def __init__(self, checker):
        self.checker = checker
        self._signature = None
        self._report = None
        self.check_calls = 0
        self.reuse_hits = 0
        self.fingerprint_seconds = 0

    def signature(self, data, assignments):
        tick = time.monotonic()
        # Includes lineage/versions, rules, locks, exceptions, history, wishes,
        # exact-minute duties and all assignment fields. JSON is unambiguous;
        # no projection or rounding may turn changed conditions into a hit.
        # ASCII escaping also preserves JSON's escaped lone-surrogate strings;
        # UTF-8 encoding of an unescaped surrogate would reject a checker-valid
        # input. Do not normalize or replace any string when hashing it.
        content = json.dumps([data, assignments], sort_keys=True, ensure_ascii=True,
                             separators=(',', ':'), allow_nan=False).encode()
        signature = hashlib.sha256(content).digest()
        self.fingerprint_seconds += time.monotonic() - tick
        return signature

    def lookup(self, data, assignments, expected_vector=None):
        if (self._report is None or (expected_vector is not None and self._report['objectiveVector'] != expected_vector)
                or self.signature(data, assignments) != self._signature):
            return None
        self.reuse_hits += 1
        # Callers cannot corrupt the retained certificate by annotating a report.
        return deepcopy(self._report)

    def check(self, data, assignments, expected_vector=None):
        # Always performs a fresh check, including every CP feasibility seed.
        # Only a subsequent explicit lookup may reuse this certificate.
        before = self.signature(data, assignments)
        self._signature, self._report = None, None
        self.check_calls += 1
        report = self.checker(data, assignments)
        if (report['status'] == 'VERIFIED' and (expected_vector is None or report['objectiveVector'] == expected_vector)
                and self.signature(data, assignments) == before):
            self._signature, self._report = before, deepcopy(report)
        return report

    def metrics(self):
        return {'scope': 'single-solve-call', 'signature': 'sha256-full-json-v1',
                'checkerCalls': self.check_calls, 'reuseHits': self.reuse_hits,
                'fingerprintSeconds': self.fingerprint_seconds}
