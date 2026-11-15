/** In-memory flags only; input values and credentials never enter this registry. */
export class UnsavedState {
  private dirty = new Set<symbol>();
  private pending = new Set<symbol>();
  private receipts = new Map<symbol, () => void>();
  submission: symbol | null = null;

  setDirty(id: symbol, dirty: boolean) {
    if (dirty) this.dirty.add(id);
    else this.dirty.delete(id);
  }
  setPending(id: symbol, pending: boolean) {
    if (pending) this.pending.add(id);
    else this.pending.delete(id);
  }
  remove(id: symbol) {
    this.dirty.delete(id);
    this.pending.delete(id);
    this.receipts.delete(id);
  }
  registerReceipt(id: symbol, accepted: () => void) { this.receipts.set(id, accepted); }
  acknowledge(id?: symbol) { if (id) this.receipts.get(id)?.(); }
  hasDirty(except?: symbol) {
    return [...this.dirty].some(id => id !== except);
  }
  get blocked() { return this.pending.size > 0; }
  get shouldWarnOnUnload() { return this.blocked || this.hasDirty(); }
}
