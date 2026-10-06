import { FailedRejectGate, FORCE_REJECT_WINDOW_MS } from '../failedReject';

describe('FailedRejectGate (a failed reject never lingers)', () => {
  it('allows forcing the same change right after its reject failed', () => {
    const gate = new FailedRejectGate();
    expect(gate.begin('move-del', 1000)).toBe(false);
    gate.fail('move-del', 1000);
    expect(gate.begin('move-del', 2000)).toBe(true);
  });

  it('a decision on another change clears the failure: later actions act only on their own change', () => {
    const gate = new FailedRejectGate();
    gate.begin('move-del', 0);
    gate.fail('move-del', 0);
    expect(gate.begin('added-updated', 10)).toBe(false); // the other card
    expect(gate.failedId).toBeNull();
    expect(gate.begin('move-del', 20)).toBe(false); // no longer forced: a normal reject again
  });

  it('expires, and an undo clears it', () => {
    const gate = new FailedRejectGate();
    gate.fail('a', 0);
    expect(gate.begin('a', FORCE_REJECT_WINDOW_MS + 1)).toBe(false);
    gate.fail('b', 0);
    gate.clear();
    expect(gate.begin('b', 1)).toBe(false);
  });
});
