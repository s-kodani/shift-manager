import test from 'node:test';
import assert from 'node:assert/strict';
import {compareCheckedObjectives} from '../../scripts/quality-comparison.mjs';

function report(values, order = ['roleFirst', 'combined', 'missed', 'surplus']) {
  return { status: 'VERIFIED', objectiveOrder: order, objectiveVector: values,
    objective: Object.fromEntries(order.map((name, i) => [name, values[i]])),
    units: { capacityScale: 1000, coverage: 'scaled-person-minute', missed: 'preference-item' },
    generalShortage: values[1], roleSameShortage: 0 };
}
test('lower-priority improvements cannot disguise worse first-stage coverage', () => {
  const result = compareCheckedObjectives(report([0, 100, 5, 1000]), report([1, 0, 0, 0]));
  assert.equal(result.relation, 'WORSE'); assert.equal(result.decidingStage, 'roleFirst');
  assert.equal(compareCheckedObjectives(report([1, 0, 0, 0]), report([0, 100, 5, 1000])).relation, 'BETTER');
});
test('the checked preference-first order is preserved without combining different units', () => {
  const order = ['missed', 'roleFirst', 'combined', 'surplus'];
  const result = compareCheckedObjectives(report([5, 0, 0, 0], order), report([4, 1000, 2000, 3000], order));
  assert.equal(result.relation, 'BETTER'); assert.equal(result.decidingStage, 'missed');
  assert.equal(compareCheckedObjectives(report([0, 10, 2, 3]), report([0, 10, 2, 3])).relation, 'EQUAL');
});
test('unverified, differently ordered, scaled or inconsistent results cannot form a comparison', () => {
  const ref = report([0, 100, 5, 1000]);
  for (const change of [ {status:'HISTORY_UNVERIFIED'}, {status:'INVALID'},
    {objectiveOrder:['combined','roleFirst','missed','surplus']}, {units:{capacityScale:1}},
    {objectiveVector:[0,100,5]}, {objectiveVector:[0,100,5,0.5]},
    {objectiveVector:[0,100,5,900]}, {objectiveOrder:['roleFirst','combined','missed','missed']} ]) {
    assert.throws(() => compareCheckedObjectives(ref, {...ref, ...change}));
  }
});
