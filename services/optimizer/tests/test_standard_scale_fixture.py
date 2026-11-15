from copy import deepcopy

import pytest

from optimizer.contract import dates
from optimizer.multi_checker import check_multi
from optimizer.multi_model import candidates_multi
from optimizer.operational_fixture import standard_scale_fixture


@pytest.mark.parametrize('slot', [30, 60])
def test_standard_reference_satisfies_hard_rules_with_real_five_tasks_and_ten_patterns(slot):
    data, reference = standard_scale_fixture(10, slot)
    unchanged = deepcopy(data)
    assert len(data['tasks']) == 5 and len(data['patterns']) == 10
    assert len({(p['start'],p['end'],p['breakKind']) for p in data['patterns']}) == 10
    assert {d['taskId'] for d in data['demand']} == {'phone','backoffice','chat','email'}
    assert {b['taskId'] for r in reference for b in r['blocks']} == {t['id'] for t in data['tasks']}
    for staff in data['staff']:
        assert {s['taskId'] for s in staff['skills']} == {t['id'] for t in data['tasks']}
        assert len(staff['rules']) == 3
        assert all(r['monthlyMin'] == 2400 and r['weeklyMax'] == 750 and r['monthlyMax'] == 3300
                   for r in staff['rules'])
    report = check_multi(data, reference)
    assert report['status'] == 'VERIFIED' and not report['violations']
    assert data == unchanged
    assert len(reference) == 10*31
    assert data['history'] and data['events'] and data['locks'] and data['exceptions']
    # A normal, non-event/unavailable/fixed date must admit each pattern, not
    # merely register names that are impossible under the day contract/rules.
    for staff in data['staff']:
        options = candidates_multi(data, staff, dates(data)[4])
        assert {o['patternId'] for o in options if o} == {p['id'] for p in data['patterns']}


def test_monthly_fixture_keeps_direct_demand_and_both_role_priorities():
    data, _ = standard_scale_fixture(101)
    first = [d for d in data['demand'] if d['date']=='2026-10-01' and d['start']==540]
    assert sum(d['direct'] for d in first) == 101*500
    assert all(d['direct'] != d['calculated'] for d in first)
    assert {r['priority'] for r in data['roleRequirements']} == {'first','same'}
