import { describe, expect, it } from 'vitest';
import { InMemoryPendingSettlementStore } from '../../src/settlement/pending-settlement-store.js';
import type { PendingSettlementInput } from '../../src/settlement/pending-settlement-store.js';

const USDC = 10_000_000n; // 1 USDC @ 7 decimals
const RATE = 340_000_000n; // 34.0 TRY/USDC @ 7 decimals

// A settled order's arm-time facts. settlesAt = confirmedAt + 45s (the compressed demo valor).
function input(overrides: Partial<PendingSettlementInput> = {}): PendingSettlementInput {
  const confirmedAtUnix = overrides.confirmedAtUnix ?? 1_000;
  return {
    orderId: 'order-001',
    tryKurus: 340_000n, // 3400.00 TRY in kurus -- drives the Model-B refill
    usdcPaidOutStroops: 100n * USDC, // what drained the pool (reference)
    appliedRateStroops: RATE,
    confirmedAtUnix,
    settlesAtUnix: confirmedAtUnix + 45,
    ...overrides,
  };
}

describe('InMemoryPendingSettlementStore -- one record per order, monotone status', () => {
  it('recordIfAbsent is idempotent per CANONICAL orderId (NFC variants collapse to one record)', () => {
    const s = new InMemoryPendingSettlementStore();
    const nfc = 'order-caf\u00e9'; // precomposed U+00E9 (NFC)
    const nfd = nfc.normalize('NFD'); // 'e' + U+0301 combining acute (NFD) -- same identity, different raw bytes
    expect(nfd).not.toBe(nfc); // guard: raw strings genuinely differ, so this really exercises canonicalization

    expect(s.recordIfAbsent(input({ orderId: nfd }))).toBe('recorded');
    expect(s.recordIfAbsent(input({ orderId: nfc }))).toBe('exists'); // collapses, no second record
    expect(s.get(nfc)?.tryKurus).toBe(340_000n); // reachable under either normalization
  });

  it('due() returns ONLY pending records whose settlesAt has passed -- excludes future, and returns a copy', () => {
    const s = new InMemoryPendingSettlementStore();
    s.recordIfAbsent(input({ orderId: 'due-now', confirmedAtUnix: 1_000 })); // settlesAt = 1045
    s.recordIfAbsent(input({ orderId: 'not-yet', confirmedAtUnix: 2_000 })); // settlesAt = 2045

    expect(s.due(1_044).map((r) => r.orderId)).toEqual([]); // 1s before its mark
    expect(s.due(1_045).map((r) => r.orderId)).toEqual(['due-now']); // exactly at the mark
    expect(s.due(9_999).map((r) => r.orderId)).toEqual(['due-now', 'not-yet']);

    const first = s.due(9_999);
    const second = s.due(9_999);
    expect(first).not.toBe(second); // a fresh materialized array each call (safe against mid-scan mutation)
  });

  it('claim() is a single-winner CAS: pending -> settling; a second claim loses; a settling record is not due', () => {
    const s = new InMemoryPendingSettlementStore();
    s.recordIfAbsent(input({ orderId: 'o1', confirmedAtUnix: 0 }));

    expect(s.claim('o1')).toBe(true); // winner
    expect(s.claim('o1')).toBe(false); // loser -- already settling
    expect(s.get('o1')?.status).toBe('settling');
    expect(s.due(9_999).map((r) => r.orderId)).toEqual([]); // settling records are never re-dispatched
    expect(s.claim('missing')).toBe(false); // unknown order
  });

  it('markSettled ends the lifecycle (settling -> settled); it never re-appears in due()', () => {
    const s = new InMemoryPendingSettlementStore();
    s.recordIfAbsent(input({ orderId: 'o1', confirmedAtUnix: 0 }));
    s.claim('o1');
    s.markSettled('o1');
    expect(s.get('o1')?.status).toBe('settled');
    expect(s.due(9_999)).toEqual([]);
    // one record ever: a later discovery of the same order does not resurrect it
    expect(s.recordIfAbsent(input({ orderId: 'o1' }))).toBe('exists');
    // defensive: markSettled off a non-settling record is a no-op (does not corrupt state)
    s.markSettled('o1');
    expect(s.get('o1')?.status).toBe('settled');
  });

  it('markFailed returns a claimed record to pending so a later tick retries it (transient mint failure)', () => {
    const s = new InMemoryPendingSettlementStore();
    s.recordIfAbsent(input({ orderId: 'o1', confirmedAtUnix: 0 }));
    s.claim('o1');
    s.markFailed('o1');
    expect(s.get('o1')?.status).toBe('pending');
    expect(s.due(9_999).map((r) => r.orderId)).toEqual(['o1']); // retryable next tick
  });

  it('markVoided fences a money-bad order out forever (never refilled), but the record still exists', () => {
    const s = new InMemoryPendingSettlementStore();
    s.recordIfAbsent(input({ orderId: 'o1', confirmedAtUnix: 0 }));
    s.markVoided('o1');
    expect(s.get('o1')?.status).toBe('voided');
    expect(s.due(9_999)).toEqual([]); // never dispatched
    expect(s.recordIfAbsent(input({ orderId: 'o1' }))).toBe('exists'); // one record ever -- no resurrection

    // a settled order is terminal -- a later void cannot override it
    const s2 = new InMemoryPendingSettlementStore();
    s2.recordIfAbsent(input({ orderId: 'o2', confirmedAtUnix: 0 }));
    s2.claim('o2');
    s2.markSettled('o2');
    s2.markVoided('o2');
    expect(s2.get('o2')?.status).toBe('settled');
  });
});
