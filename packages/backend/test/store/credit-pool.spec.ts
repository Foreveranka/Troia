import { describe, expect, it } from 'vitest';
import { ReservationLedger } from '../../src/store/reservation-ledger.js';
import { InMemoryStore } from '../../src/store/in-memory-store.js';

const USDC = 10_000_000n; // 1 USDC @ 7 decimals

describe('ReservationLedger.credit — raise the pool base for a landed rebalance top-up', () => {
  it('credit raises balance() and available() by exactly the amount; held reservations untouched', () => {
    const l = new ReservationLedger(3n * USDC);
    l.commit('o1', USDC, 0, 60_000);
    expect(l.available()).toBe(2n * USDC);

    l.credit(5n * USDC);
    expect(l.balance()).toBe(8n * USDC); // base rose
    expect(l.available()).toBe(7n * USDC); // +5, the reservation is still held
    expect(l.sumReserved()).toBe(USDC); // reservations untouched
  });

  it('credit rejects a non-positive amount (a top-up is always > 0)', () => {
    const l = new ReservationLedger(USDC);
    expect(() => l.credit(0n)).toThrow();
    expect(() => l.credit(-1n)).toThrow();
  });
});

describe('InMemoryStore.creditPool — the /intent gate sees a landed refill', () => {
  it('raises availableStroops + balance by the credited amount (a mint that landed lifts headroom)', async () => {
    const store = new InMemoryStore({ balanceStroops: 100n * USDC, baseSeq: 1000n });
    expect(store.availableStroops()).toBe(100n * USDC);

    await store.reserve('o1', 40n * USDC, 60_000, 0);
    expect(store.availableStroops()).toBe(60n * USDC); // a payout drained headroom

    await store.creditPool(25n * USDC); // a rebalance mint landed
    expect(store.availableStroops()).toBe(85n * USDC); // 60 + 25 — the gate now reflects the refill
    expect(store.poolBalanceStroops()).toBe(125n * USDC);
  });
});
