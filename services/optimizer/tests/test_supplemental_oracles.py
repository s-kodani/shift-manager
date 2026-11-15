"""Literal supplemental requirements; expectations use exact hand counts."""
from fractions import Fraction

import pytest

from optimizer.multi_checker import check_multi
from test_capacity_gate import fixture, reference


@pytest.mark.parametrize('slot', [30, 60])
def test_ts_new01_ten_preparation_minutes_are_one_sixth_person_hour(slot):
    data = fixture()
    data['slotMinutes'] = slot
    data['tasks'].append({'id': 'backoffice', 'kind': 'general', 'minimumLevel': 1, 'minimumMinutes': 60})
    data['staff'][0]['skills'].append({'taskId': 'backoffice', 'level': 1, 'capacity': 1000})
    data['transitions'] = [{'fromTaskId': 'phone', 'toTaskId': 'backoffice', 'minutes': 10}]
    data['demand'] = [{'date': '2026-10-01', 'start': m, 'end': m + slot,
                       'taskId': 'phone' if m < 600 else 'backoffice',
                       'direct': 1000, 'calculated': None} for m in range(540, 660, slot)]
    rows = reference(data)
    rows[0]['blocks'] = [{'start': m, 'end': m + slot, 'taskId': 'phone' if m < 600 else 'backoffice',
                         'roleId': None} for m in range(540, 660, slot)]
    report = check_multi(data, rows)
    assert report['status'] == 'VERIFIED'
    assert report['daily'][0]['preparationMinutes'] == 10
    assert report['daily'][0]['workedMinutes'] == 120
    assert report['daily'][0]['processedMinutes'] == 110
    assert report['daily'][0]['runs'] == [['phone', 60], ['backoffice', 60]]
    assert Fraction(report['generalShortage'], 1000 * 60) == Fraction(1, 6)


def test_ts_new02_rest_only_day_is_not_work_and_counts_as_monthly_day_off():
    data = fixture()
    data['patterns'][0].update(breakKind='fixed', fixedBreak=[540, 660])
    data['breakRule'].update(afterStart=0, beforeEnd=0)
    rule = data['staff'][0]['rules'][0]
    rule.update(monthlyMin=0, minDays=1, minOff=31)
    rows = reference(data)
    rows[0]['shift'].update(breakKind='fixed', workedMinutes=0, **{'break': [540, 660]})
    rows[0]['blocks'] = []
    report = check_multi(data, rows)
    assert report['status'] == 'INVALID'
    assert report['violations'] == [f'MONTHLY_DAYS:{data["staff"][0]["id"]}:{rule["id"]}']
    assert report['daily'][0]['workedMinutes'] == 0
    rule['minDays'] = 0
    assert check_multi(data, rows)['status'] == 'VERIFIED'  # all31 days are off


@pytest.mark.parametrize('rounding,required', [('ceil', 4), ('floor', 3)])
def test_ts_new04_ten_ordinary_two_concurrent_and_one_dedicated_person(rounding, required):
    data = fixture(13)
    data['tasks'].append({'id': 'management', 'kind': 'dedicated', 'minimumLevel': 1, 'minimumMinutes': 0})
    for index, staff in enumerate(data['staff']):
        staff['skills'][0]['capacity'] = 500 if index < 10 else 2000
        if index in (10, 11):
            staff['roleIds'] = ['leader']
    data['staff'][12]['skills'].append({'taskId': 'management', 'level': 1, 'capacity': 0})
    rows = reference(data)
    for b in rows[12 * 31]['blocks']:
        b['taskId'] = 'management'
    data['roleRequirements'] = [{'id': 'literal-role', 'date': '2026-10-01',
                                'start': 540, 'end': 660, 'taskId': 'phone',
                                'roleId': 'leader', 'minimum': 0,
                                'ratioNumerator': 1, 'ratioDenominator': 3,
                                'rounding': rounding, 'priority': 'first'}]
    report = check_multi(data, rows)
    assert report['status'] == 'VERIFIED'
    assert report['roleRequirements'][0]['intervals'] == [
        {'start': 540, 'end': 660, 'ordinaryPeople': 10, 'required': required,
         'actual': 2, 'shortage': required - 2}]
    assert report['objective']['roleFirst'] == (required - 2) * 120 * 1000
    assert report['intervals'][0]['processingPeople'] == 12
    assert report['intervals'][0]['ordinaryPeople'] == 10
    assert report['intervals'][0]['rolePeople'] == {'leader': 2}
