import assert from 'node:assert/strict';

// Diagnostic permutation only: no changed rules, candidate thinning or seed.
export function prepareStaffOrderComparison(input, orderedIds) {
  assert.equal(input.schemaVersion, 'multi-task-v1');
  assert(Array.isArray(input.staff) && input.staff.length === 500, 'FULL_500_INPUT_REQUIRED');
  assert(Array.isArray(orderedIds), 'STAFF_ORDER_REQUIRED');
  const people = new Map(input.staff.map(person => [person.id, person]));
  assert.equal(people.size, input.staff.length, 'DUPLICATE_INPUT_STAFF');
  assert.equal(orderedIds.length, people.size, 'STAFF_ORDER_COUNT');
  assert.equal(new Set(orderedIds).size, people.size, 'DUPLICATE_ORDER_STAFF');
  assert(orderedIds.every(id => people.has(id)), 'STAFF_ORDER_MEMBERSHIP');
  assert.notDeepEqual(orderedIds, input.staff.map(person => person.id), 'ORDER_ALREADY_CANONICAL');
  const reordered = structuredClone(input);
  reordered.staff = orderedIds.map(id => structuredClone(people.get(id)));
  assert.deepEqual({ ...reordered, staff: input.staff }, input);
  return reordered;
}
