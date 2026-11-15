"""Bounded progress without request values, identifiers, or model contents."""

import json
import math
from pathlib import Path
import resource
import sys

PHASES = {
    "inputValidation",
    "savedCandidatePrecheck",
    "candidates",
    "duties",
    "rules",
    "objectives",
    "initialHints",
    "initialFeasibility",
    "competingHints",
    "competingFeasibility",
    "search",
    "finalCheck",
    "loadInput",
    "loadFiles",
    "loadProto",
    "validateProto",
    "loadLayout",
    "validateLayout",
    "restoreObjectives",
    "modelReady",
    "extractSolution",
    "checkSolution",
    "releaseLayout",
    "reloadLayout",
}
EVENTS = {"phase", "buildProgress", "cpStart", "cpEnd"}
STATUSES = {"UNKNOWN", "MODEL_INVALID", "FEASIBLE", "INFEASIBLE", "OPTIMAL"}
KEYS = {
    "event",
    "phase",
    "seconds",
    "variables",
    "constraints",
    "rssBytes",
    "maxRssBytes",
    "modelBuildComplete",
    "cpStatus",
}


def memory_usage():
    maximum = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    maximum *= 1 if sys.platform == "darwin" else 1024
    current = None
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                current = int(line.split()[1]) * 1024
                break
    except (OSError, ValueError, IndexError):
        pass
    return current, maximum


def read_observation(path):
    try:
        with Path(path).open() as source:
            raw = source.read(65_537)
        if len(raw.encode("utf8")) > 65_536:
            raise ValueError("limit")
        value = json.loads(raw)
        if (set(value) != {"version", "events"} or type(value["version"]) is not int
                or value["version"] != 1):
            raise ValueError("schema")
        rows = value["events"]
        if not isinstance(rows, list) or not 1 <= len(rows) <= 64:
            raise ValueError("rows")
        for row in rows:
            if (
                not isinstance(row, dict)
                or set(row) != KEYS
                or row["event"] not in EVENTS
                or row["phase"] not in PHASES
                or not isinstance(row["modelBuildComplete"], bool)
                or row["cpStatus"] not in STATUSES | {None}
            ):
                raise ValueError("row")
            for key in ("seconds", "variables", "constraints", "maxRssBytes", "rssBytes"):
                number = row[key]
                if key == "rssBytes" and number is None:
                    continue
                if (
                    not isinstance(number, (int, float))
                    or isinstance(number, bool)
                    or not math.isfinite(number)
                    or number < 0
                    or (key != "seconds" and not isinstance(number, int))
                ):
                    raise ValueError("number")
        return {"available": True, "events": rows}
    except FileNotFoundError:
        return {"available": False, "reason": "NO_PROGRESS"}
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        return {"available": False, "reason": "INVALID_PROGRESS"}
