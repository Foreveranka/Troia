import { describe, expect, it } from 'vitest';
import { TryDrivenRebalancePolicy } from '../../src/settlement/rebalance-policy.js';
import type { PendingSettlement } from '../../src/settlement/pending-settlement-store.js';

const USDC = 10_000_000n; // 1 USDC @ 7 decimals
const RATE = 340_000_000n; // 34.0 TRY/USDC @ 7 decimals

function rec(overrides: Partial<PendingSettlement> = {}): PendingSettlement {
  return {
    orderId: 'order-001',
    tryKurus: 346_800n, // 3468.00 TRY collected = 100 USDC * 34.0 * 1.02 (2% commission baked in)
    usdcPaidOutStroops: 100n * USDC, // what actually drained the pool
    appliedRateStroops: RATE,
    confirmedAtUnix: 1_000,
    settlesAtUnix: 1_045,
    status: 'settling',
    ...overrides,
  };
}

describe('TryDrivenRebalancePolicy — convert collected TRY to USDC at the LIVE rate', () => {
  const policy = new TryDrivenRebalancePolicy();

  it('mints usdc = collectedTRY / liveRate, with a deterministic per-order ref', () => {
    const req = policy.plan(rec(), RATE); // live rate == the frozen rate (no move)
    // 346_800 kuruş / 34.0 = 102.00 USDC = 1_020_000_000 stroops
    expect(req.usdcStroops).toBe(1_020_000_000n);
    expect(req.ref).toBe('topup:order-001');
    expect(req.valueKurus).toBe(346_800n); // the collected TRY funds this mint (booked EXTERNAL_FUNDING)
  });

  it('the pool GROWS: minted USDC exceeds what drained, by the commission (rate unchanged)', () => {
    const r = rec();
    const req = policy.plan(r, RATE);
    // 102 USDC minted vs 100 USDC drained => +2 USDC surplus == the realized commission
    expect(req.usdcStroops).toBeGreaterThan(r.usdcPaidOutStroops);
    expect(req.usdcStroops - r.usdcPaidOutStroops).toBe(2n * USDC);
  });

  it('the FX risk shows: if TRY weakened in the valör window, fewer USDC are minted', () => {
    const weaker = 360_000_000n; // 36.0 TRY/USDC — TRY lost value vs the 34.0 at charge
    const req = policy.plan(rec(), weaker);
    // 346_800 / 36.0 = 96.333... USDC < the 100 that drained => the commission cushion absorbs the FX loss
    expect(req.usdcStroops).toBeLessThan(rec().usdcPaidOutStroops);
    expect(req.usdcStroops).toBe(963_333_333n); // BigInt division truncates DOWN (never over-mints)
  });

  it('the same order always plans the same ref (idempotent dedup key, never random)', () => {
    const r = rec({ orderId: 'ST-ABC123' });
    expect(policy.plan(r, RATE).ref).toBe(policy.plan(r, RATE).ref);
    expect(policy.plan(r, RATE).ref).toBe('topup:ST-ABC123');
  });

  it('fails closed on a non-positive live rate or non-positive TRY (never mints on a bogus basis)', () => {
    expect(() => policy.plan(rec(), 0n)).toThrow();
    expect(() => policy.plan(rec(), -1n)).toThrow();
    expect(() => policy.plan(rec({ tryKurus: 0n }), RATE)).toThrow();
  });
});
