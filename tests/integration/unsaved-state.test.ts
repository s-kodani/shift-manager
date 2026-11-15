import { expect, it } from 'vitest';
import { UnsavedState } from '../../apps/web/product/unsaved-state';

it('a successful save of one form does not remove protection from another form', () => {
  const state = new UnsavedState(), calendar = Symbol(), policy = Symbol();
  state.setDirty(calendar, true);
  state.setDirty(policy, true);
  expect(state.hasDirty(calendar)).toBe(true);
  state.remove(calendar);
  expect(state.shouldWarnOnUnload).toBe(true);
  state.remove(policy);
  expect(state.shouldWarnOnUnload).toBe(false);
});

it('a rejected or uncertain save remains protected until acknowledged or unmounted', () => {
  const state = new UnsavedState(), form = Symbol(), operation = Symbol();
  state.setDirty(form, true);
  state.setPending(operation, true);
  expect(state.blocked).toBe(true);
  // A definite refusal allows editing again; it does not acknowledge the input.
  state.setPending(operation, false);
  expect(state.blocked).toBe(false);
  expect(state.shouldWarnOnUnload).toBe(true);
  state.setDirty(form, false);
  state.setPending(operation, true);
  // Even clean input must not lose an operation awaiting its original receipt.
  expect(state.shouldWarnOnUnload).toBe(true);
  state.remove(operation);
  expect(state.shouldWarnOnUnload).toBe(false);
});

it('the submitting form is excluded only for checking other unsaved forms', () => {
  const state = new UnsavedState(), own = Symbol(), other = Symbol();
  state.setDirty(own, true);
  expect(state.hasDirty(own)).toBe(false);
  expect(state.shouldWarnOnUnload).toBe(true);
  state.setDirty(other, true);
  expect(state.hasDirty(own)).toBe(true);
  state.remove(other);
  expect(state.hasDirty(own)).toBe(false);
});

it('same-ID receipt acknowledgment clears only its still-mounted uncontrolled form', () => {
  const state = new UnsavedState(), own = Symbol(), other = Symbol();
  state.setDirty(own, true); state.setDirty(other, true);
  state.registerReceipt(own, () => state.setDirty(own, false));
  state.acknowledge(own);
  expect(state.hasDirty(other)).toBe(false);
  expect(state.hasDirty()).toBe(true);
  state.remove(own);
  state.setDirty(other, false);
  state.acknowledge(own);
  expect(state.shouldWarnOnUnload).toBe(false);
});
