"""Diagnostic checked starting point; no global CP optimization or proof."""

from dataclasses import dataclass
import hashlib
import json
import math
import time

from .contract import dates
from .candidate_catalog import CandidateCatalog
from .interval_hint import interval_hints
from .minute_set import MinuteSet
from .multi_checker import check_multi
from .multi_contract import validate_multi
from .multi_model import candidates_multi, active_minutes, active_slot_geometry
from .candidate_certificate import CandidateCertificate


@dataclass(frozen=True, slots=True)
class HintIndex:
    index: int


class CandidateBudget(Exception):
    pass


def checked_initial_candidate(data, budget_seconds=90, on_checked=None):
    if on_checked is not None and not callable(on_checked):
        raise ValueError('INITIAL_CHECKPOINT_CALLBACK')
    if (
        not isinstance(budget_seconds, (int, float))
        or isinstance(budget_seconds, bool)
        or not math.isfinite(budget_seconds)
        or not 0 < budget_seconds <= 90
    ):
        raise ValueError("INITIAL_CANDIDATE_BUDGET")
    validate_multi(data)
    started = time.monotonic()
    phases, attempts, best, best_report = {}, [], None, None
    certificate = CandidateCertificate(check_multi)
    next_index = 0

    def check_budget():
        if time.monotonic() >= started + budget_seconds:
            raise CandidateBudget()

    def symbol():
        nonlocal next_index
        value = HintIndex(next_index)
        next_index += 1
        return value

    def timed(name, callback):
        tick = time.monotonic()
        try:
            return callback()
        finally:
            phases[name] = phases.get(name, 0) + time.monotonic() - tick

    tasks = {t["id"]: t for t in data["tasks"]}
    roles = {r["id"]: r for r in data["roles"]}
    requirements = {}
    for r in data["roleRequirements"]:
        requirements.setdefault(r["date"], []).append(r)
    days = dates(data)
    catalog = CandidateCatalog(data, candidates_multi)
    candidates, active, xs, choices, role_choices = {}, {}, {}, {}, {}
    minute_pool, edge_cache, geometry_cache = {}, {}, {}
    boundaries = {d.isoformat(): {0, 1440, *range(0, 1440, data["slotMinutes"])} for d in days}

    def inputs():
        for staff in data["staff"]:
            for d in days:
                check_budget()
                key = staff["id"], d.isoformat()
                candidates[key] = catalog.get(staff, d)
                xs[key] = [symbol() for _ in candidates[key]]
                for i, shift in enumerate(candidates[key]):
                    minutes = active_minutes(data, staff["id"], key[1], shift, compact=True)
                    minutes = minute_pool.setdefault(minutes.bits, minutes)
                    active[key, i] = minutes
                    if minutes.bits not in edge_cache:
                        edges = set()
                        for m in minutes:
                            if m - 1 not in minutes:
                                edges.add(m)
                            if m + 1 not in minutes:
                                edges.add(m + 1)
                        edge_cache[minutes.bits] = edges
                    boundaries[key[1]].update(edge_cache[minutes.bits])
        for day, edges in boundaries.items():
            for b in range(0, 1440, data["slotMinutes"]):
                for transition in data["transitions"]:
                    if b + transition["minutes"] <= 1440:
                        edges.add(b + transition["minutes"])
            for r in data["roleRequirements"]:
                if r["date"] == day:
                    edges.update((r["start"], r["end"]))

    segments = {}

    def indexes():
        for day, edges in boundaries.items():
            points = sorted(edges)
            segments[day] = list(zip(points, points[1:]))
        needed = {
            (day, a, task)
            for day, intervals in segments.items()
            for a, _b in intervals
            for task in tasks
            if tasks[task]["kind"] == "general"
            and any(
                r["start"] <= a < r["end"] and r["taskId"] in (None, task)
                for r in requirements.get(day, [])
            )
        }
        for staff in data["staff"]:
            eligible = [
                s["taskId"]
                for s in staff["skills"]
                if s["level"] >= tasks[s["taskId"]]["minimumLevel"]
            ]
            allowed_roles = {
                task: [r for r in staff["roleIds"] if task in roles[r]["allowedTasks"]]
                for task in eligible
            }
            for d in days:
                check_budget()
                key = staff["id"], d.isoformat()
                bits = 0
                for i in range(len(candidates[key])):
                    bits |= active[key, i].bits
                possible = MinuteSet.from_bits(bits)
                if bits not in geometry_cache:
                    geometry_cache[bits] = tuple(
                        sorted(active_slot_geometry(possible, data["slotMinutes"]))
                    )
                choices[key] = {
                    b: {task: symbol() for task in eligible} for b in geometry_cache[bits]
                }
                for a, b in segments[key[1]]:
                    if a not in possible:
                        continue
                    for task in eligible:
                        if tasks[task]["kind"] != "general":
                            continue
                        allowed = allowed_roles[task] if (key[1], a, task) in needed else []
                        if allowed:
                            role_choices.setdefault(key, {})[a, b, task] = {
                                None: None,
                                **{role: symbol() for role in allowed},
                            }

    def extract(hints):
        result = []
        for key, options in candidates.items():
            check_budget()
            selected = [i for i, x in enumerate(xs[key]) if hints.get(x.index) == 1]
            if len(selected) != 1:
                return None
            i = selected[0]
            shift = options[i]
            available = active[key, i]
            slots = {m - m % data["slotMinutes"] for m in available}
            blocks = []
            for b, variables in choices[key].items():
                if b not in slots:
                    continue
                chosen = [task for task, var in variables.items() if hints.get(var.index) == 1]
                if len(chosen) != 1:
                    return None
                blocks.append(
                    {
                        "start": b,
                        "end": b + data["slotMinutes"],
                        "taskId": chosen[0],
                        "roleId": None,
                    }
                )
            intervals = [
                {"start": a, "end": b, "roleId": role}
                for (a, b, _task), variables in role_choices.get(key, {}).items()
                for role, var in variables.items()
                if var is not None and hints.get(var.index) == 1
            ]
            result.append(
                {
                    "staffId": key[0],
                    "date": key[1],
                    "shift": shift,
                    "blocks": blocks,
                    "roleIntervals": sorted(intervals, key=lambda r: r["start"]),
                }
            )
        return result

    expired = False
    try:
        timed("candidates", inputs)
        timed("indexes", indexes)
        for off in (False, True):
            hints = timed(
                "hints",
                lambda: interval_hints(
                    data,
                    candidates,
                    active,
                    choices,
                    role_choices,
                    xs,
                    segments,
                    check_budget,
                    prefer_qualified_role=True,
                    covered_off_hints=off,
                    calendar_roster=True,
                ),
            )
            rows = timed("extract", lambda: extract(hints))
            report = certificate.lookup(data, rows) if rows is not None else None
            if report is None:
                report = (timed("independentCheck", lambda: certificate.check(data, rows))
                          if rows is not None else {"status": "NOT_RUN"})
            attempts.append(
                {
                    "coveredOffHints": off,
                    "validationStatus": report["status"],
                    "objectiveVector": report.get("objectiveVector"),
                }
            )
            if report["status"] == "VERIFIED" and (
                best is None or report["objectiveVector"] < best_report["objectiveVector"]
            ):
                best, best_report = rows, report
                if on_checked is not None:
                    on_checked(best, best_report)
            check_budget()
    except CandidateBudget:
        expired = True
    return {
        "schemaVersion": "initial-candidate-v1",
        **{
            k: data[k]
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
        },
        "inputHash": hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
        "candidateStatus": "CHECKED" if best is not None else "NOT_CREATED",
        "globalSolverStatus": "NOT_RUN",
        "validation": best_report or {"status": "NOT_RUN", "violations": []},
        "assignments": best,
        "publication": "BLOCKED_A1",
        "metrics": {
            "budgetSeconds": budget_seconds,
            "expired": expired,
            "phaseSeconds": phases,
            "attempts": attempts,
            "metadataIndexes": next_index,
            "candidateCatalogHits": catalog.hits,
            "totalSeconds": time.monotonic() - started,
            "candidateCertificate": certificate.metrics(),
        },
    }
