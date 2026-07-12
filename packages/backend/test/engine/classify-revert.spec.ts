import { describe, expect, it } from 'vitest';
import { classifyRevertCause, revertEvent } from '../../src/engine/classify-revert.js';

// The revert-cause partition is money-critical: ONLY the two CERTAIN outcomes (each checked AT/AFTER the on-chain
// replay guard) get special handling — AlreadyProcessed(1) = a prior pay() already delivered USDC (→ UsdcConfirmed),
// BalanceGuard(2) = provably past the guard with no transfer (→ safe auto-void). EVERYTHING else is Indeterminate
// (a bounded re-drive then LossReview, never an auto-void), because Paused(3) / InvalidAmount(5) are checked BEFORE
// the replay guard and so cannot rule out a prior settlement, and an unreadable/unknown code is equally uncertain.
// This table guards the partition against an accidental re-split that would re-open the masked-settlement over-refund.
describe('classifyRevertCause — the money-critical partition', () => {
  it('maps ONLY codes 1 and 2 to a certain cause; every other input is Indeterminate', () => {
    expect(classifyRevertCause(1)).toBe('AlreadyProcessed');
    expect(classifyRevertCause(2)).toBe('BalanceGuard');
    // Paused(3), NotAuthorized(4), InvalidAmount(5), unknown codes, and a null (unreadable) all fall through.
    for (const code of [3, 4, 5, 6, 99, 0, -1, null]) {
      expect(classifyRevertCause(code)).toBe('Indeterminate');
    }
  });
});

describe('revertEvent — the certain-cause factory', () => {
  it('builds the two certain revert events', () => {
    expect(revertEvent('AlreadyProcessed')).toEqual({ type: 'revertAlreadyProcessed' });
    expect(revertEvent('BalanceGuard')).toEqual({ type: 'revertBalanceGuard' });
  });

  it('fails CLOSED if ever handed the budgeted Indeterminate cause (never a silent undefined that would strand the order)', () => {
    // The type excludes 'Indeterminate' at compile time; this exercises the runtime fail-closed default in case the
    // type is ever bypassed — an undefined return would leave the driver with no event and strand UsdcReverted.
    const call = revertEvent as (cause: string) => unknown;
    expect(() => call('Indeterminate')).toThrow();
  });
});
