"""Reuse only a private file already fully checked by the owning parent."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path

from .candidate_certificate import CandidateCertificate


def parent_precheck(data, path, trusted_sha):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16_000_000:
        raise ValueError("PARENT_CERTIFICATE_FILE")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != trusted_sha:
        raise ValueError("PARENT_CERTIFICATE_SHA")
    value = json.loads(raw)
    input_hash = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    if (
        value.get("inputHash") != input_hash
        or value.get("candidateStatus") != "CHECKED"
        or value.get("solverStatus") != "UNKNOWN"
        or value.get("publication") != "BLOCKED_A1"
        or value.get("validation", {}).get("status") != "VERIFIED"
        or value.get("assignments") is None
    ):
        raise ValueError("PARENT_CERTIFICATE_SCOPE")
    if any(
        value.get(k) != data[k]
        for k in (
            "tenantId",
            "teamId",
            "month",
            "mode",
            "inputVersion",
            "settingsVersion",
            "jobId",
            "attempt",
        )
    ):
        raise ValueError("PARENT_CERTIFICATE_LINEAGE")
    cert = CandidateCertificate(None)
    signature = cert.signature(data, value["assignments"])
    report = deepcopy(value["validation"])

    def precheck(current, rows):
        if cert.signature(current, rows) != signature:
            raise ValueError("PARENT_CERTIFICATE_CONTENT")
        return deepcopy(report)

    return precheck
