import calendar
import json
from datetime import date, timedelta
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

SCHEMA = Path(__file__).resolve().parents[3] / 'packages/contracts/optimizer-input.schema.json'


def dates(data):
    year, month = map(int, data['month'].split('-'))
    return [date(year, month, day) for day in range(1, calendar.monthrange(year, month)[1] + 1)]


def validate_input(data):
    Draft202012Validator(json.loads(SCHEMA.read_text()), format_checker=FormatChecker()).validate(data)
    days = {d.isoformat() for d in dates(data)}
    ids = [s['id'] for s in data['staff']]
    patterns = [p['id'] for p in data['patterns']]
    if len(ids) != len(set(ids)) or len(patterns) != len(set(patterns)):
        raise ValueError('DUPLICATE_ID')
    for p in data['patterns']:
        if p['start'] >= p['end']:
            raise ValueError('OVERNIGHT_OR_EMPTY_PATTERN')
        if (p['breakKind'] == 'fixed') != ('fixedBreak' in p):
            raise ValueError('FIXED_BREAK_REQUIRED_ONLY_FOR_FIXED')
        if 'fixedBreak' in p:
            a, b = p['fixedBreak']
            if not p['start'] <= a < b <= p['end']:
                raise ValueError('INVALID_FIXED_BREAK')
    for s in data['staff']:
        if s['contract']['start'] >= s['contract']['end']:
            raise ValueError('INVALID_CONTRACT')
        for item in s['unavailable'] + s['preferences']:
            if item['date'] not in days:
                raise ValueError('OUTSIDE_MONTH')
            if 'start' in item and item['start'] >= item['end']:
                raise ValueError('INVALID_INTERVAL')
        seen = set()
        for p in s['preferences']:
            key = (p['date'], p['kind'])
            if key in seen:
                raise ValueError('DUPLICATE_PREFERENCE')
            seen.add(key)
            if p['kind'] == 'pattern' and p.get('patternId') not in patterns:
                raise ValueError('UNKNOWN_PATTERN')
            if p['kind'] == 'window' and ('start' not in p or 'end' not in p):
                raise ValueError('WINDOW_REQUIRED')
    demand_seen = set()
    for d in data['demand']:
        if d['date'] not in days or d['end'] - d['start'] != data['slotMinutes']:
            raise ValueError('INVALID_DEMAND_SLOT')
        if d['start'] % data['slotMinutes'] or (d['direct'] is None and d['calculated'] is None):
            raise ValueError('DEMAND_UNSET_OR_UNALIGNED')
        key = (d['date'], d['start'])
        if key in demand_seen:
            raise ValueError('DUPLICATE_DEMAND')
        demand_seen.add(key)
    history_seen = set()
    for h in data['history']:
        # v0 supports previous history only; future-month commitments require
        # the full model rather than silently ignoring consecutive-day effects.
        if h['staffId'] not in ids or date.fromisoformat(h['date']) >= dates(data)[0]:
            raise ValueError('INVALID_HISTORY')
        date.fromisoformat(h['date'])
        key = (h['staffId'], h['date'])
        if key in history_seen:
            raise ValueError('DUPLICATE_HISTORY')
        history_seen.add(key)


def required_history(data, staff):
    first = dates(data)[0]
    span = max((first.weekday() - data['weekStart']) % 7,
               max(r['maxConsecutive'] for r in staff['rules']))
    return [first - timedelta(days=n) for n in range(1, span + 1)]
