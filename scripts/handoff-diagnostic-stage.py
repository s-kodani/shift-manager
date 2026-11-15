"""Runs inside one owned local image; not a Worker or normal solve endpoint."""

import hashlib
import json
from pathlib import Path
import sys

from optimizer.model_handoff import LINEAGE, input_sha
from optimizer.process_budget import read_result
from optimizer.process_observation import read_observation
from optimizer.split_process import run_stage, SplitStageFailure

root, stage, seconds = Path(sys.argv[1]), sys.argv[2], float(sys.argv[3])
assert stage in ("initial", "build", "solve")
assert 0 < seconds <= {"initial": 72, "build": 180, "solve": 90}[stage]
trusted = sys.argv[4] if len(sys.argv) == 5 else None
data = json.loads((root / "input.json").read_text())
try:
    result = run_stage(root, stage, seconds, manifest_sha=trusted)
except SplitStageFailure as error:
    result = {"name": stage, "failure": error.diagnostics}
if stage == "initial" and not result.get("expired") and "failure" not in result:
    path = root / "initial.json"
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    checked = read_result(path, data, allow_checked_hint=True)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    assert checked["assignments"] is not None
    result.update(
        initialSha256=before,
        validation=checked["validation"]["status"],
        objectiveVector=checked["validation"]["objectiveVector"],
    )
if stage == "build":
    result["progress"] = read_observation(root / "build-progress.json")
    path = root / "ready.json"
    if not result.get("expired") and "failure" not in result and path.is_file():
        ready = json.loads(path.read_text())
        result["ready"] = ready
        if ready["status"] == "PREPARED":
            raw = (root / "bundle/manifest.json").read_bytes()
            assert hashlib.sha256(raw).hexdigest() == ready["manifestSha256"]
            manifest = json.loads(raw)
            assert manifest["inputHash"] == input_sha(data)
            assert manifest["lineage"] == {k: data[k] for k in LINEAGE}
if stage == "solve":
    result["progress"] = read_observation(root / "solve-progress.json")
    if "failure" not in result:
        path = root / (
            "cp-final.json" if (root / "cp-final.json").exists() else "cp-checkpoint.json"
        )
        if path.is_file():
            checked = read_result(path, data)
            validation = {k: v for k, v in checked["validation"].items() if k != "preferences"}
            validation["preferenceItems"] = len(checked["validation"].get("preferences", []))
            result.update(
                solverStatus=checked["solverStatus"],
                validation=validation,
                rows=len(checked["assignments"] or []),
            )
print(json.dumps(result, separators=(",", ":"), allow_nan=False))
