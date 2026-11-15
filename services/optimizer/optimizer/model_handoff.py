"""Private, hash-bound model handoff probe; no normal profile integration."""

import hashlib
import json
import math
from pathlib import Path
import time

from ortools.sat.python import cp_model, cp_model_helper

from .contract import dates
from .multi_checker import check_multi
from .multi_contract import validate_multi
from .stream_export import write_layout
from .chunked_model_export import export_model, export_whole_model
from .process_observation import memory_usage

LINEAGE = (
    "tenantId",
    "teamId",
    "month",
    "mode",
    "inputVersion",
    "settingsVersion",
    "jobId",
    "attempt",
)
LIMITS = {"model.pb.txt": 1_500_000_000, "layout.json": 256_000_000, "manifest.json": 65_536}


class ModelPrepared(Exception):
    pass


class HandoffObserver:
    def __init__(self, callback):
        if callback is not None and not callable(callback):
            raise ValueError("MODEL_HANDOFF_PROGRESS")
        self.callback, self.started, self.errors = callback, time.monotonic(), 0

    def emit(self, phase, model=None, event="phase", status=None):
        if self.callback is None:
            return
        current, maximum = memory_usage()
        try:
            self.callback(
                {
                    "event": event,
                    "phase": phase,
                    "seconds": time.monotonic() - self.started,
                    "variables": len(model.proto.variables) if model is not None else 0,
                    "constraints": len(model.proto.constraints) if model is not None else 0,
                    "rssBytes": current,
                    "maxRssBytes": maximum,
                    "modelBuildComplete": model is not None,
                    "cpStatus": status,
                }
            )
        except Exception:
            self.errors += 1


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def input_sha(data):
    return sha(json.dumps(data, sort_keys=True).encode())


def expression_record(name, value):
    if type(value) is int:
        return {"name": name, "vars": [], "coeffs": [], "offset": value}
    expression = cp_model_helper.FlatIntExpr(value)
    if not expression.is_integer:
        raise ValueError("MODEL_HANDOFF_NONINTEGER_OBJECTIVE")
    return {
        "name": name,
        "vars": [v.index for v in expression.vars],
        "coeffs": list(expression.coeffs),
        "offset": expression.offset,
    }


def save_bundle(
    root,
    data,
    model,
    objectives,
    candidates,
    xs,
    active,
    choices,
    role_choices,
    settings,
    progress=None,
    export_mode="chunked-native-v1",
):
    if export_mode not in ("chunked-native-v1", "whole-native-v1"):
        raise ValueError("MODEL_HANDOFF_EXPORT_MODE")
    root = Path(root)
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    if progress is not None:
        progress("model-export")
    if export_mode == "whole-native-v1":
        export_whole_model(root / "model.pb.txt", model, LIMITS["model.pb.txt"])
    else:
        export_model(root / "model.pb.txt", model.proto, LIMITS["model.pb.txt"])
    if progress is not None:
        progress("layout")
    pools, slots_cache = [], {}

    def rows():
        for key, options in candidates.items():
            active_ids = []
            for i in range(len(options)):
                minutes = active[key, i]
                signature = minutes.bits if hasattr(minutes, "bits") else tuple(sorted(minutes))
                if signature not in slots_cache:
                    slots_cache[signature] = len(pools)
                    pools.append(sorted({m - m % data["slotMinutes"] for m in minutes}))
                active_ids.append(slots_cache[signature])
            yield {
                "staffId": key[0],
                "date": key[1],
                "options": options,
                "x": [x.index for x in xs[key]],
                "activePools": active_ids,
                "tasks": [
                    [b, [[task, var.index] for task, var in values.items()]]
                    for b, values in choices[key].items()
                ],
                "roles": [
                    [a, b, role, var.index]
                    for (a, b, _task), variables in role_choices.get(key, {}).items()
                    for role, var in variables.items()
                    if role is not None
                ],
            }

    expressions = []
    for name, objective in objectives:
        expressions.append(expression_record(name, objective))
    layout = {
        "version": 1,
        "slotMinutes": data["slotMinutes"],
        "activeSlotPools": pools,
        "objectives": expressions,
        "settings": {**settings, "modelExportMode": export_mode},
    }
    write_layout(root / "layout.json", rows(), layout, LIMITS["layout.json"])
    if progress is not None:
        progress("manifest")
    manifest = {
        "version": 1,
        "inputHash": input_sha(data),
        "lineage": {k: data[k] for k in LINEAGE},
        "variables": len(model.proto.variables),
        "constraints": len(model.proto.constraints),
        "files": {
            name: {"sha256": file_sha(root / name), "bytes": (root / name).stat().st_size}
            for name in ("model.pb.txt", "layout.json")
        },
    }
    for name, info in manifest["files"].items():
        if info["bytes"] > LIMITS[name]:
            raise ValueError("MODEL_HANDOFF_LIMIT")
    raw = json.dumps(manifest, separators=(",", ":"), allow_nan=False).encode()
    (root / "manifest.pending").write_bytes(raw)
    (root / "manifest.pending").replace(root / "manifest.json")
    return sha(raw)


def load_bundle(root, data, expected_manifest_sha, *, observer=None):
    observer = observer if observer is not None else HandoffObserver(None)
    observer.emit("loadInput")
    validate_multi(data)
    observer.emit("loadFiles")
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("MODEL_HANDOFF_PATH")
    for name, limit in LIMITS.items():
        p = root / name
        if p.is_symlink() or not p.is_file() or p.stat().st_size > limit:
            raise ValueError("MODEL_HANDOFF_LIMIT")
    raw = (root / "manifest.json").read_bytes()
    if sha(raw) != expected_manifest_sha:
        raise ValueError("MODEL_HANDOFF_MANIFEST_SHA")
    manifest = json.loads(raw)
    if (
        set(manifest) != {"version", "inputHash", "lineage", "variables", "constraints", "files"}
        or type(manifest["version"]) is not int
        or manifest["version"] != 1
        or any(
            type(manifest[k]) is not int or manifest[k] < 0 for k in ("variables", "constraints")
        )
        or manifest["inputHash"] != input_sha(data)
        or manifest["lineage"] != {k: data[k] for k in LINEAGE}
        or set(manifest["files"]) != {"model.pb.txt", "layout.json"}
    ):
        raise ValueError("MODEL_HANDOFF_LINEAGE")
    for name, info in manifest["files"].items():
        if (root / name).stat().st_size != info["bytes"] or file_sha(root / name) != info["sha256"]:
            raise ValueError("MODEL_HANDOFF_FILE_SHA")
    model = cp_model.CpModel()
    observer.emit("loadProto")
    if not model.proto.parse_text_format((root / "model.pb.txt").read_text()):
        raise ValueError("MODEL_HANDOFF_PROTO")
    observer.emit("validateProto", model)
    if model.validate():
        raise ValueError("MODEL_HANDOFF_PROTO")
    if (
        len(model.proto.variables) != manifest["variables"]
        or len(model.proto.constraints) != manifest["constraints"]
    ):
        raise ValueError("MODEL_HANDOFF_COUNTS")
    observer.emit("loadLayout", model)
    layout = json.loads((root / "layout.json").read_bytes())
    observer.emit("validateLayout", model)
    if (
        set(layout)
        != {"version", "slotMinutes", "rows", "activeSlotPools", "objectives", "settings"}
        or type(layout["version"]) is not int
        or layout["version"] != 1
        or layout["slotMinutes"] != data["slotMinutes"]
    ):
        raise ValueError("MODEL_HANDOFF_LAYOUT")
    count = len(model.proto.variables)
    settings = layout["settings"]
    expected_settings = {
        "initialHintStrategy",
        "mainPresolveEnabled",
        "commonRunsEnabled",
        "calendarRosterHintsEnabled",
        "compactMinutesEnabled",
        "sharedBuildFactsEnabled",
        "debugNamesEnabled",
        "modelExportMode",
    }
    if (
        set(settings) != expected_settings
        or any(
            type(settings[k]) is not bool
            for k in expected_settings - {"initialHintStrategy", "modelExportMode"}
        )
        or settings["modelExportMode"] not in ("chunked-native-v1", "whole-native-v1")
        or settings["initialHintStrategy"]
        not in (
            "legacy-first-v1",
            "balanced-coverage-v1",
            "balanced-incumbent-v1",
            "balanced-incumbent-v2",
            "balanced-incumbent-v3",
            "balanced-incumbent-v4",
        )
    ):
        raise ValueError("MODEL_HANDOFF_SETTINGS")

    def index(value, boolean=False):
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError("MODEL_HANDOFF_INDEX")
        positive = value if value >= 0 else -value - 1
        if not 0 <= positive < count or (not boolean and value < 0):
            raise ValueError("MODEL_HANDOFF_INDEX")
        if boolean and list(model.proto.variables[positive].domain) not in ([0, 1], [0, 0], [1, 1]):
            raise ValueError("MODEL_HANDOFF_BOOLEAN")

    wanted = {(s["id"], d.isoformat()) for s in data["staff"] for d in dates(data)}
    actual = []
    task_ids = {t["id"] for t in data["tasks"]}
    role_ids = {r["id"] for r in data["roles"]}
    for pool in layout["activeSlotPools"]:
        if (
            not isinstance(pool, list)
            or pool != sorted(set(pool))
            or any(type(b) is not int or not 0 <= b < 1440 or b % data["slotMinutes"] for b in pool)
        ):
            raise ValueError("MODEL_HANDOFF_SLOTS")
    for row in layout["rows"]:
        if set(row) != {"staffId", "date", "options", "x", "activePools", "tasks", "roles"}:
            raise ValueError("MODEL_HANDOFF_ROW")
        actual.append((row["staffId"], row["date"]))
        if len(row["options"]) != len(row["x"]) or len(row["x"]) != len(row["activePools"]):
            raise ValueError("MODEL_HANDOFF_CANDIDATES")
        for value in row["x"]:
            index(value, True)
        for value in row["activePools"]:
            if type(value) is not int or not 0 <= value < len(layout["activeSlotPools"]):
                raise ValueError("MODEL_HANDOFF_POOL")
        for b, items in row["tasks"]:
            if type(b) is not int or not 0 <= b < 1440 or b % data["slotMinutes"]:
                raise ValueError("MODEL_HANDOFF_SLOTS")
            for task, value in items:
                if task not in task_ids:
                    raise ValueError("MODEL_HANDOFF_TASK")
                index(value, True)
        for a, b, role, value in row["roles"]:
            if (
                type(a) is not int
                or type(b) is not int
                or not 0 <= a < b <= 1440
                or role not in role_ids
            ):
                raise ValueError("MODEL_HANDOFF_ROLE")
            index(value, True)
    if len(actual) != len(wanted) or set(actual) != wanted:
        raise ValueError("MODEL_HANDOFF_ROWS")
    observer.emit("restoreObjectives", model)
    names = []
    expressions = []
    for item in layout["objectives"]:
        if set(item) != {"name", "vars", "coeffs", "offset"} or len(item["vars"]) != len(
            item["coeffs"]
        ):
            raise ValueError("MODEL_HANDOFF_OBJECTIVE")
        names.append(item["name"])
        if any(type(n) is not int for n in [*item["coeffs"], item["offset"]]):
            raise ValueError("MODEL_HANDOFF_OBJECTIVE")
        for value in item["vars"]:
            index(value)
        expressions.append(
            sum(
                c * model.get_int_var_from_proto_index(i)
                for i, c in zip(item["vars"], item["coeffs"])
            )
            + item["offset"]
        )
    expected = (
        ["roleFirst", "combined", "missed", "surplus"]
        if data["priority"] == "coverage"
        else ["missed", "roleFirst", "combined", "surplus"]
    )
    if not any(r["priority"] == "first" for r in data["roleRequirements"]):
        expected.remove("roleFirst")
    if names != expected:
        raise ValueError("MODEL_HANDOFF_OBJECTIVE_ORDER")
    observer.emit("modelReady", model)
    return model, layout, list(zip(names, expressions)), manifest


def extract_assignments(layout, values):
    def selected(index):
        value = values[index if index >= 0 else -index - 1]
        if value not in (0, 1):
            raise ValueError("MODEL_HANDOFF_SOLUTION_BOOLEAN")
        return bool(value if index >= 0 else 1 - value)

    rows = []
    for row in layout["rows"]:
        options = [i for i, x in enumerate(row["x"]) if selected(x)]
        if len(options) != 1:
            raise ValueError("MODEL_HANDOFF_SOLUTION_CANDIDATE")
        i = options[0]
        slots = set(layout["activeSlotPools"][row["activePools"][i]])
        blocks = []
        for b, items in row["tasks"]:
            if b not in slots:
                continue
            tasks = [task for task, index in items if selected(index)]
            if len(tasks) != 1:
                raise ValueError("MODEL_HANDOFF_SOLUTION_TASK")
            blocks.append(
                {"start": b, "end": b + layout["slotMinutes"], "taskId": tasks[0], "roleId": None}
            )
        roles = [
            {"start": a, "end": b, "roleId": role}
            for a, b, role, index in row["roles"]
            if selected(index)
        ]
        rows.append(
            {
                "staffId": row["staffId"],
                "date": row["date"],
                "shift": row["options"][i],
                "blocks": blocks,
                "roleIntervals": sorted(roles, key=lambda r: r["start"]),
            }
        )
    return rows


def solve_probe(
    root,
    data,
    expected_manifest_sha,
    seconds=10,
    *,
    seed_first=False,
    checkpoint_callback=None,
    progress_callback=None,
    release_layout=False,
):
    if not isinstance(release_layout, bool):
        raise ValueError("MODEL_HANDOFF_LAYOUT_RELEASE")
    if (
        not isinstance(seconds, (int, float))
        or isinstance(seconds, bool)
        or not math.isfinite(seconds)
        or not 0 < seconds <= 90
    ):
        raise ValueError("MODEL_HANDOFF_BUDGET")
    started = time.monotonic()
    observer = HandoffObserver(progress_callback)
    model, layout, objectives, manifest = load_bundle(
        root, data, expected_manifest_sha, observer=observer
    )
    loaded = time.monotonic()
    main_presolve = layout["settings"]["mainPresolveEnabled"]
    if release_layout:
        layout = None
        observer.emit("releaseLayout", model)
    deadline = started + seconds
    best, report, vector = None, None, None
    stages = []
    optimal = True
    seed = None

    def accept(solver):
        if release_layout:
            observer.emit("reloadLayout", model)
            path = Path(root) / "layout.json"
            info = manifest["files"]["layout.json"]
            if path.is_symlink() or not path.is_file() or path.stat().st_size != info["bytes"]:
                raise ValueError("MODEL_HANDOFF_LAYOUT_CHANGED")
            with path.open("rb") as source:
                raw = source.read(LIMITS["layout.json"] + 1)
            if len(raw) > LIMITS["layout.json"] or sha(raw) != info["sha256"]:
                raise ValueError("MODEL_HANDOFF_LAYOUT_CHANGED")
            extraction_layout = json.loads(raw)
            del raw
        else:
            extraction_layout = layout
        observer.emit("extractSolution", model)
        values = list(solver.response_proto.solution)
        if len(values) != len(model.proto.variables):
            raise ValueError("MODEL_HANDOFF_SOLUTION_LENGTH")
        rows = extract_assignments(extraction_layout, values)
        del extraction_layout
        del values
        observer.emit("checkSolution", model)
        checked = check_multi(data, rows)
        native = [int(solver.value(expression)) for _name, expression in objectives]
        if checked["status"] != "VERIFIED" or checked["objectiveVector"] != native:
            raise ValueError("MODEL_HANDOFF_CHECK_MISMATCH")
        if vector is not None and native > vector:
            return best, report, vector
        if checkpoint_callback is not None:
            checkpoint_callback(rows, checked, stages)
        return rows, checked, native

    if seed_first and deadline > time.monotonic():
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = 0
        solver.parameters.fix_variables_to_their_hinted_value = True
        solver.parameters.stop_after_first_solution = True
        solver.parameters.max_time_in_seconds = min(30, (deadline - time.monotonic()) * 0.5)
        observer.emit("initialFeasibility", model, "cpStart")
        status = solver.solve(model)
        observer.emit("initialFeasibility", model, "cpEnd", solver.status_name(status))
        seed = {"scope": "hint-restricted-feasibility", "status": solver.status_name(status)}
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            best, report, vector = accept(solver)
        del solver
    for position, (name, objective) in enumerate(objectives):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            optimal = False
            break
        if vector is not None:
            for earlier in range(position + 1):
                model.add(objectives[earlier][1] <= vector[earlier])
        model.minimize(objective)
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = 0
        solver.parameters.cp_model_presolve = main_presolve
        solver.parameters.max_time_in_seconds = remaining
        observer.emit("search", model, "cpStart")
        status = solver.solve(model)
        observer.emit("search", model, "cpEnd", solver.status_name(status))
        stages.append({"name": name, "status": solver.status_name(status)})
        if status not in (cp_model.FEASIBLE, cp_model.OPTIMAL):
            optimal = False
            break
        best, report, vector = accept(solver)
        model.add(objective <= vector[position])
        optimal &= status == cp_model.OPTIMAL
    return {
        "scope": "model-handoff-probe; not normal profile integration",
        "solverStatus": "OPTIMAL"
        if best is not None and optimal and len(stages) == len(objectives)
        else "FEASIBLE"
        if best is not None
        else "UNKNOWN",
        "validation": report or {"status": "NOT_RUN", "violations": []},
        "assignments": best,
        "stages": stages,
        "modelVariables": manifest["variables"],
        "modelConstraints": manifest["constraints"],
        "seed": seed,
        "loadSeconds": loaded - started,
        "observationFailures": observer.errors,
        "layoutReleasedDuringCp": release_layout,
        "totalSeconds": time.monotonic() - started,
    }


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 5:
        raise ValueError("MODEL_HANDOFF_ARGUMENTS")
    data = json.loads(Path(sys.argv[2]).read_text())
    result = solve_probe(sys.argv[1], data, sys.argv[3], float(sys.argv[4]))
    print(json.dumps(result, separators=(",", ":")))
