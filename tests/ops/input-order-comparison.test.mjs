import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareStaffOrderComparison } from '../../scripts/input-order-comparison.mjs';

const fixture = () => ({ schemaVersion: 'multi-task-v1', tenantId: 'fictional-company',
  staff: Array.from({ length: 500 }, (_, i) => ({ id: 'fictional-' + i, rules: [{ monthlyMin: i }],
    unavailable: [{ date: '2026-10-02', start: i, end: i + 1 }] })),
  locks: [{ staffId: 'fictional-0', parts: ['time'], shift: { start: 540, end: 720 } }],
  exceptions: [{ staffId: 'fictional-0', reason: '架空の理由' }], priority: 'coverage' });
test('diagnostic changes only order; all 500 person conditions, locks and metadata survive and input stays immutable', () => {
  const input = fixture(), original = structuredClone(input), order = input.staff.map(s => s.id).reverse();
  const variant = prepareStaffOrderComparison(input, order);
  assert.deepEqual(variant.staff, original.staff.toReversed());
  assert.deepEqual({ ...variant, staff: original.staff }, original);
  variant.staff[0].rules[0].monthlyMin = -1;
  assert.deepEqual(input, original);
});
test('reject thinning, duplicate/replaced staff, smaller fixtures and unchanged comparison', () => {
  const input = fixture(), order = input.staff.map(s => s.id).reverse();
  assert.throws(() => prepareStaffOrderComparison(input, order.slice(1)), /STAFF_ORDER_COUNT/);
  assert.throws(() => prepareStaffOrderComparison(input, [...order.slice(1), order[1]]), /DUPLICATE_ORDER_STAFF/);
  assert.throws(() => prepareStaffOrderComparison(input, [...order.slice(1), 'outsider']), /STAFF_ORDER_MEMBERSHIP/);
  assert.throws(() => prepareStaffOrderComparison({ ...input, staff: input.staff.slice(0, 101) }, order), /FULL_500_INPUT_REQUIRED/);
  assert.throws(() => prepareStaffOrderComparison(input, input.staff.map(s => s.id)), /ORDER_ALREADY_CANONICAL/);
});
