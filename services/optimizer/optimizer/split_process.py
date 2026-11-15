"""Sequential private process stages; diagnostic profile only."""

import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from .multi_contract import validate_multi
from .process_observation import read_observation
from .process_budget import (
    LINEAGE,
    atomic_result,
    read_result,
    stop_and_reap,
    ProcessExecutionError,
)


class SplitStageFailure(ProcessExecutionError):
    def __init__(self, diagnostics):
        RuntimeError.__init__(self, "SPLIT_STAGE_FAILED")
        self.diagnostics = diagnostics


def envelope(data, rows, report, *, solver_status="UNKNOWN", stages=None):
    value = {
        "schemaVersion": "multi-task-v1",
        **{k: data[k] for k in LINEAGE},
        "inputHash": hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
        "solverStatus": solver_status,
        "validation": report,
        "assignments": rows,
        "stages": stages or [],
        "publication": "BLOCKED_A1",
        "metrics": {},
    }
    if solver_status == "UNKNOWN" and rows is not None:
        value.update(candidateStatus="CHECKED", globalSolverStatus="UNKNOWN")
    return value


def run_stage(root, name, seconds, *, manifest_sha=None):
    command = [sys.executable, "-m", "optimizer.split_process", name, str(root), str(seconds)]
    if manifest_sha is not None:
        command.append(manifest_sha)
    started = time.monotonic()
    child = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        cwd=Path(__file__).resolve().parent.parent,
    )
    expired = False
    try:
        try:
            child.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            expired = True
            stop_and_reap(child)
        if not expired and child.returncode != 0:
            raise SplitStageFailure(
                {
                    "stage": name,
                    "childExitCode": child.returncode,
                    "childReaped": child.poll() is not None,
                    "executionSeconds": time.monotonic() - started,
                    "buildProgress": read_observation(root / "build-progress.json")
                    if name == "build"
                    else None,
                    "solveProgress": read_observation(root / "solve-progress.json")
                    if name == "solve"
                    else None,
                }
            )
        return {
            "name": name,
            "seconds": time.monotonic() - started,
            "expired": expired,
            "exitCode": child.returncode,
            "childReaped": child.poll() is not None,
        }
    finally:
        stop_and_reap(child)


def solve_split(data, budget_seconds=240):
    if (
        not isinstance(budget_seconds, (int, float))
        or isinstance(budget_seconds, bool)
        or not math.isfinite(budget_seconds)
        or not 0 < budget_seconds <= 240
    ):
        raise ValueError("SPLIT_BUDGET")
    validate_multi(data)
    started = time.monotonic()
    deadline = started + budget_seconds
    stages = []
    best = None
    ready = None
    build_observation = None
    build_progress = None
    solve_progress = None
    with tempfile.TemporaryDirectory(prefix="optimizer-split-") as directory:
        root = Path(directory)
        (root / "input.json").write_text(json.dumps(data, allow_nan=False))

        def remaining(maximum):
            return max(0.001, min(maximum, deadline - time.monotonic()))

        stages.append(run_stage(root, "initial", remaining(min(72, budget_seconds * 0.3))))
        if (root / "initial.json").exists():
            initial_sha = hashlib.sha256((root / "initial.json").read_bytes()).hexdigest()
            candidate = read_result(root / "initial.json", data, allow_checked_hint=True)
            if hashlib.sha256((root / "initial.json").read_bytes()).hexdigest() != initial_sha:
                raise ValueError("SPLIT_INITIAL_CHANGED")
            if candidate["assignments"] is not None:
                best = candidate
        if not stages[-1]["expired"] and deadline > time.monotonic():
            stages.append(
                run_stage(
                    root,
                    "build",
                    remaining(120),
                    manifest_sha=initial_sha if best is not None else None,
                )
            )
            build_progress = read_observation(root / "build-progress.json")
            if (root / "build-observation.json").exists():
                raw = (root / "build-observation.json").read_bytes()
                if len(raw) > 65536:
                    raise ValueError("SPLIT_OBSERVATION_LIMIT")
                build_observation = json.loads(raw)
            if not stages[-1]["expired"] and (root / "ready.json").exists():
                raw = (root / "ready.json").read_bytes()
                if len(raw) > 65536:
                    raise ValueError("SPLIT_READY_LIMIT")
                ready = json.loads(raw)
                if ready["status"] == "PREPARED" and deadline > time.monotonic():
                    stages.append(
                        run_stage(
                            root, "solve", remaining(90), manifest_sha=ready["manifestSha256"]
                        )
                    )
                    solve_progress = read_observation(root / "solve-progress.json")
                    path = (
                        root / "cp-final.json"
                        if (root / "cp-final.json").exists()
                        else root / "cp-checkpoint.json"
                    )
                    if path.exists():
                        candidate = read_result(path, data)
                        if candidate["solverStatus"] == "INFEASIBLE" and best is not None:
                            raise RuntimeError("CHECKED_CANDIDATE_MODEL_CONTRADICTION")
                        if candidate["assignments"] is not None:
                            if (
                                candidate["solverStatus"] == "OPTIMAL"
                                and best is not None
                                and candidate["validation"]["objectiveVector"]
                                > best["validation"]["objectiveVector"]
                            ):
                                raise RuntimeError("CHECKED_CANDIDATE_MODEL_CONTRADICTION")
                            if (
                                best is None
                                or candidate["validation"]["objectiveVector"]
                                <= best["validation"]["objectiveVector"]
                            ):
                                best = candidate
        if best is None:
            best = envelope(data, None, {"status": "NOT_RUN", "violations": []})
        if build_observation is not None:
            best["metrics"]["buildObservation"] = build_observation
        if build_progress is not None:
            best["metrics"]["buildProgress"] = build_progress
        if solve_progress is not None:
            best["metrics"]["solveProgress"] = solve_progress
        best["metrics"].update(
            budgetSeconds=budget_seconds,
            splitProcess=True,
            processStages=stages,
            preparedModel=ready,
            totalSeconds=time.monotonic() - started,
        )
        return best


def stage_worker(name, root, seconds, manifest_sha=None):
    root = Path(root)
    data = json.loads((root / "input.json").read_text())
    if name == "initial":
        from .early_candidate import checked_initial_candidate

        def checked(rows, report):
            atomic_result(root / "initial.json", envelope(data, rows, report))

        result = checked_initial_candidate(data, min(90, seconds), on_checked=checked)
        if result["candidateStatus"] == "CHECKED":
            value = envelope(data, result["assignments"], result["validation"])
            value["metrics"]["initialCandidate"] = result["metrics"]
            atomic_result(root / "initial.json", value)
    elif name == "build":
        from .multi_model import solve_multi
        from .model_handoff import save_bundle, ModelPrepared

        build_started = time.monotonic()
        events = []

        def progress(row):
            events.append(dict(row))
            del events[:-64]
            atomic_result(root / "build-progress.json", {"version": 1, "events": events})

        saved = None
        saved_precheck = None
        if manifest_sha is not None:
            raw = (root / "initial.json").read_bytes()
            if len(raw) > 16_000_000 or hashlib.sha256(raw).hexdigest() != manifest_sha:
                raise ValueError("SPLIT_INITIAL_SHA")
            saved = json.loads(raw)["assignments"]
            from .parent_certificate import parent_precheck

            saved_precheck = parent_precheck(data, root / "initial.json", manifest_sha)

        def prepared(*parts):
            before_export = time.monotonic()

            def progress(phase):
                sizes = {
                    name: (root / "bundle" / name).stat().st_size
                    for name in ("model.pb.txt", "layout.json")
                    if (root / "bundle" / name).is_file()
                }
                atomic_result(
                    root / "build-observation.json",
                    {
                        "phase": phase,
                        "seconds": time.monotonic() - build_started,
                        "modelBuildComplete": True,
                        "variables": len(parts[0].proto.variables),
                        "constraints": len(parts[0].proto.constraints),
                        "fileBytes": sizes,
                    },
                )

            digest = save_bundle(
                root / "bundle", data, *parts, progress=progress, export_mode="whole-native-v1"
            )
            manifest = json.loads((root / "bundle" / "manifest.json").read_text())
            atomic_result(
                root / "ready.json",
                {
                    "status": "PREPARED",
                    "manifestSha256": digest,
                    "variables": manifest["variables"],
                    "constraints": manifest["constraints"],
                    "files": manifest["files"],
                    "buildSecondsToPrepared": before_export - build_started,
                    "exportSeconds": time.monotonic() - before_export,
                    "savedPrecheckSource": "bound-parent-file"
                    if saved_precheck
                    else "fresh-checker",
                    "debugNamesEnabled": parts[-1]["debugNamesEnabled"],
                    "modelExportMode": "whole-native-v1",
                },
            )
            raise ModelPrepared()

        try:
            result = solve_multi(
                data,
                seconds,
                hint_strategy="balanced-incumbent-v4",
                saved_assignments=saved,
                saved_precheck=saved_precheck,
                calendar_roster=True,
                compact_minutes=True,
                shared_build_facts=True,
                common_runs=True,
                debug_names=False,
                build_variable_limit=3500000,
                prepared_callback=prepared,
                progress_callback=progress,
            )
        except ModelPrepared:
            return
        atomic_result(
            root / "ready.json",
            {
                "status": "NOT_PREPARED",
                "termination": result.get("termination"),
                "metrics": result["metrics"],
            },
        )
    elif name == "solve":
        from .model_handoff import solve_probe

        events = []

        def progress(row):
            events.append(dict(row))
            del events[:-64]
            atomic_result(root / "solve-progress.json", {"version": 1, "events": events})

        def checked(rows, report, stages):
            atomic_result(
                root / "cp-checkpoint.json",
                envelope(data, rows, report, solver_status="FEASIBLE", stages=stages),
            )

        result = solve_probe(
            root / "bundle",
            data,
            manifest_sha,
            min(90, seconds),
            seed_first=True,
            checkpoint_callback=checked,
            progress_callback=progress,
            release_layout=True,
        )
        if (
            any(s["status"] == "INFEASIBLE" for s in result["stages"])
            and (root / "initial.json").exists()
        ):
            raise RuntimeError("CHECKED_CANDIDATE_MODEL_CONTRADICTION")
        value = envelope(
            data,
            result["assignments"],
            result["validation"],
            solver_status=result["solverStatus"],
            stages=result["stages"],
        )
        value["metrics"]["cpProbe"] = {
            k: v for k, v in result.items() if k not in ("assignments", "validation")
        }
        atomic_result(root / "cp-final.json", value)
    else:
        raise ValueError("SPLIT_STAGE")


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        raise ValueError("SPLIT_ARGUMENTS")
    stage_worker(
        sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4] if len(sys.argv) == 5 else None
    )
