import assert from 'node:assert/strict';

// Compare checked final values in the input's stage order, never a weighted sum.
export function compareCheckedObjectives(reference, actual) {
  for (const report of [reference, actual]) {
    assert.equal(report.status, 'VERIFIED', 'UNVERIFIED_QUALITY_COMPARISON');
    assert(Array.isArray(report.objectiveOrder) && report.objectiveOrder.length > 0);
    assert.equal(new Set(report.objectiveOrder).size, report.objectiveOrder.length);
    assert.equal(report.objectiveVector.length, report.objectiveOrder.length);
    assert(report.objectiveVector.every(Number.isSafeInteger));
    assert.deepEqual(report.objectiveVector, report.objectiveOrder.map(name => report.objective[name]));
  }
  assert.deepEqual(actual.objectiveOrder, reference.objectiveOrder, 'OBJECTIVE_ORDER_MISMATCH');
  assert.deepEqual(actual.units, reference.units, 'OBJECTIVE_UNITS_MISMATCH');
  const index = actual.objectiveVector.findIndex((value, i) => value !== reference.objectiveVector[i]);
  return { relation: index < 0 ? 'EQUAL' : actual.objectiveVector[index] < reference.objectiveVector[index]
    ? 'BETTER' : 'WORSE', decidingStage: index < 0 ? null : reference.objectiveOrder[index],
    reference: reference.objectiveVector, actual: actual.objectiveVector,
    generalShortage: { reference: reference.generalShortage, actual: actual.generalShortage },
    roleSameShortage: { reference: reference.roleSameShortage, actual: actual.roleSameShortage } };
}
