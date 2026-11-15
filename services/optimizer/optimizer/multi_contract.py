"""Versioned multi-task contract; semantic input checks shared without solver logic."""
import json
from datetime import date
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from .contract import dates

ROOT = Path(__file__).resolve().parents[3] / 'packages/contracts'
SCHEMA = json.loads((ROOT / 'optimizer-multi-task.schema.json').read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
OUTPUT = {'type': 'array', 'items': {'$ref': '#/$defs/assignment'}, '$defs': SCHEMA['$defs']}
OUTPUT_VALIDATOR = Draft202012Validator(OUTPUT, format_checker=FormatChecker())


def unique(values, label):
    if len(values) != len(set(values)):
        raise ValueError(f'DUPLICATE_{label}')


def interval(a, b):
    if a >= b:
        raise ValueError('EMPTY_OR_REVERSED_INTERVAL')


def integer_representation(value):
    if isinstance(value, float):
        raise ValueError('INTEGER_VALUES_REQUIRED')
    if isinstance(value, dict):
        for item in value.values():
            integer_representation(item)
    if isinstance(value, list):
        for item in value:
            integer_representation(item)


def validate_multi(data, *, allow_manual_exceptions=False):
    VALIDATOR.validate(data)
    integer_representation(data)
    ds = {d.isoformat() for d in dates(data)}
    for collection in ('staff', 'patterns', 'tasks', 'roles', 'events',
                       'roleRequirements', 'locks', 'exceptions'):
        unique([x['id'] for x in data[collection]], collection.upper())
    staff = {x['id'] for x in data['staff']}
    tasks = {x['id']: x for x in data['tasks']}
    roles = {x['id'] for x in data['roles']}
    patterns = {x['id']: x for x in data['patterns']}

    def local_day(value):
        if value not in ds:
            raise ValueError('OUTSIDE_MONTH')

    def known_staff(value):
        if value not in staff:
            raise ValueError('UNKNOWN_STAFF')

    def shift(value):
        if value is None:
            return
        p = patterns.get(value['patternId'])
        if p is None:
            raise ValueError('UNKNOWN_PATTERN')
        interval(value['start'], value['end'])
        if value['break']:
            interval(*value['break'])
            if not value['start'] <= value['break'][0] < value['break'][1] <= value['end']:
                raise ValueError('BREAK_OUTSIDE_ATTENDANCE')
        for a, b in value['cancelled']:
            interval(a, b)
            if not value['start'] <= a < b <= value['end']:
                raise ValueError('CANCELLATION_OUTSIDE_ATTENDANCE')
        unique([tuple(x) for x in value['cancelled']], 'CANCELLATION')
        intervals = sorted(value['cancelled'])
        if any(a[1] > b[0] for a, b in zip(intervals, intervals[1:])):
            raise ValueError('OVERLAPPING_CANCELLATION')

    for p in patterns.values():
        interval(p['start'], p['end'])
        if (p['breakKind'] == 'fixed') != ('fixedBreak' in p):
            raise ValueError('FIXED_BREAK_REQUIRED_ONLY_FOR_FIXED')
        if 'fixedBreak' in p:
            interval(*p['fixedBreak'])
            if not p['start'] <= p['fixedBreak'][0] < p['fixedBreak'][1] <= p['end']:
                raise ValueError('INVALID_FIXED_BREAK')
    for r in data['roles']:
        unique(r['allowedTasks'], 'ROLE_TASK')
        if any(t not in tasks or tasks[t]['kind'] != 'general' for t in r['allowedTasks']):
            raise ValueError('INVALID_ROLE_TASK')
    for s in data['staff']:
        interval(s['contract']['start'], s['contract']['end'])
        unique([x['id'] for x in s['rules']], 'STAFF_RULE')
        unique([x['taskId'] for x in s['skills']], 'SKILL')
        if any(x['taskId'] not in tasks for x in s['skills']) or not set(s['roleIds']) <= roles:
            raise ValueError('UNKNOWN_SKILL_OR_ROLE')
        for x in s['skills']:
            if tasks[x['taskId']]['kind'] == 'dedicated' and x['capacity'] != 0:
                raise ValueError('DEDICATED_CAPACITY_MUST_BE_ZERO')
        unique([(x['date'], x['kind']) for x in s['preferences']], 'PREFERENCE')
        for x in s['unavailable'] + s['preferences']:
            local_day(x['date'])
            if 'start' in x:
                interval(x['start'], x['end'])
        for x in s['preferences']:
            if x['kind'] == 'pattern' and x.get('patternId') not in patterns:
                raise ValueError('UNKNOWN_PREFERENCE_PATTERN')
            if x['kind'] == 'window' and ('start' not in x or 'end' not in x):
                raise ValueError('PREFERENCE_WINDOW_REQUIRED')
            if x['kind'] in ('work', 'off') and any(k in x for k in ('start', 'end', 'patternId')):
                raise ValueError('UNEXPECTED_PREFERENCE_FIELDS')
    unique([(x['fromTaskId'], x['toTaskId']) for x in data['transitions']], 'TRANSITION')
    for t in data['transitions']:
        if t['fromTaskId'] not in tasks or t['toTaskId'] not in tasks or t['fromTaskId'] == t['toTaskId']:
            raise ValueError('INVALID_TRANSITION_PAIR')
        if t['minutes'] > data['slotMinutes']:
            raise ValueError('PREPARATION_EXCEEDS_SLOT')
    unique([(x['date'], x['start'], x['taskId']) for x in data['demand']], 'DEMAND')
    for x in data['demand']:
        local_day(x['date'])
        if x['taskId'] not in tasks or tasks[x['taskId']]['kind'] != 'general':
            raise ValueError('INVALID_DEMAND_TASK')
        if x['end'] - x['start'] != data['slotMinutes'] or x['start'] % data['slotMinutes']:
            raise ValueError('INVALID_DEMAND_SLOT')
        if x['direct'] is None and x['calculated'] is None:
            raise ValueError('DEMAND_UNSET')
    for e in data['events']:
        local_day(e['date'])
        interval(e['start'], e['end'])
        for sid in e['staffIds']:
            known_staff(sid)
    rounding, policies, scopes = set(), {}, {}
    for r in data['roleRequirements']:
        local_day(r['date'])
        interval(r['start'], r['end'])
        if r['roleId'] not in roles or (r['taskId'] is not None and r['taskId'] not in tasks):
            raise ValueError('UNKNOWN_ROLE_REQUIREMENT_SCOPE')
        if r['taskId'] is not None and tasks[r['taskId']]['kind'] != 'general':
            raise ValueError('ROLE_REQUIREMENT_REQUIRES_GENERAL_TASK')
        rounding.add(r['rounding'])
        if len(rounding) > 1:
            raise ValueError('ROLE_ROUNDING_MUST_BE_COMPANY_WIDE')
        policy = policies.setdefault(r['taskId'], r['priority'])
        if policy != r['priority']:
            raise ValueError('ROLE_PRIORITY_MUST_BE_SCOPE_WIDE')
        scope = scopes.setdefault((r['date'], r['taskId'], r['roleId']), [])
        if any(a < r['end'] and r['start'] < b for a, b in scope):
            raise ValueError('OVERLAPPING_ROLE_REQUIREMENT')
        scope.append((r['start'], r['end']))
    locks = {x['id']: x for x in data['locks']}
    for x in data['locks'] + data['published']:
        known_staff(x['staffId'])
        local_day(x['date'])
        shift(x['shift'])
    unique([(x['staffId'], x['date']) for x in data['published']], 'PUBLISHED_SHIFT')
    for x in data['exceptions']:
        known_staff(x['staffId'])
        local_day(x['date'])
        interval(x['start'], x['end'])
        if x['lockId'] is None:
            if not allow_manual_exceptions:
                raise ValueError('UNFIXED_EXCEPTION_REQUIRES_MANUAL_CHECK')
            if not x['reason'].strip():
                raise ValueError('MANUAL_EXCEPTION_REQUIRES_REASON')
            continue
        lock = locks.get(x['lockId'])
        if not x['reason'].strip() or not lock or lock['staffId'] != x['staffId'] or lock['date'] != x['date']:
            raise ValueError('INVALID_FIXED_EXCEPTION')
        if lock['shift'] is None or not {'pattern', 'time', 'break'} <= set(lock['parts']):
            raise ValueError('EXCEPTION_REQUIRES_EXACT_FIXED_SHIFT')
        if not lock['shift']['start'] <= x['start'] < x['end'] <= lock['shift']['end']:
            raise ValueError('EXCEPTION_OUTSIDE_FIXED_SHIFT')
    if data['mode'] == 'draft':
        if data['published'] or any(x['shift'] and x['shift']['cancelled'] for x in data['locks']):
            raise ValueError('DRAFT_CANNOT_CANCEL_OR_HAVE_PUBLISHED_BASE')
    else:
        expected = {(sid, day) for sid in staff for day in ds}
        if {(x['staffId'], x['date']) for x in data['published']} != expected:
            raise ValueError('PUBLISHED_BASE_MUST_COVER_MONTH')
    unique([(x['staffId'], x['date']) for x in data['history']], 'HISTORY')
    for h in data['history']:
        known_staff(h['staffId'])
        if h['date'] in ds:
            raise ValueError('HISTORY_INSIDE_MONTH')
        date.fromisoformat(h['date'])
    # Bounds are conservative, far below CP-SAT int64: no float or silent rounding.
    upper = len(staff) * 31 * 1440 * 10000 * (len(tasks) + len(data['roleRequirements']) + 1)
    if upper >= 2**60:
        raise ValueError('INTEGER_OBJECTIVE_BOUND')
