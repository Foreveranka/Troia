import { describe, expect, it } from 'vitest';
import { ReservationLedger } from '../../src/store/reservation-ledger.js';

const UNIT = 10_000_000n; // 1 USDC @ 7 decimals

describe('ReservationLedger — fail-closed solvency math', () => {
  it('available = balance − Σ ALL held reservations', () => {
    const l = new ReservationLedger(3n * UNIT);
    expect(l.available()).toBe(3n * UNIT);
    l.commit('o1', UNIT, 0, 60_000);
    l.commit('o2', UNIT, 0, 60_000);
    expect(l.sumReserved()).toBe(2n * UNIT);
    expect(l.available()).toBe(UNIT);
  });

  it('TTL expiry NEVER frees capacity — available() ignores time entirely (the BLOCKER fix)', () => {
    const l = new ReservationLedger(1n * UNIT);
    l.commit('o1', UNIT, /*now*/ 0, /*ttl*/ 1); // expiresAt = 1ms — long past for any later "now"
    // no matter how much wall-clock time has notionally passed, the held reservation still counts:
    expect(l.available()).toBe(0n);
    expect(l.sumReserved()).toBe(UNIT);
    // only an explicit release lowers Σreserved
    l.release('o1');
    expect(l.available()).toBe(1n * UNIT);
  });

  it('release is idempotent and order-keyed', () => {
    const l = new ReservationLedger(2n * UNIT);
    l.commit('o1', UNIT, 0, 60_000);
    l.release('o1');
    l.release('o1'); // no-op, no throw
    l.release('missing'); // no-op
    expect(l.available()).toBe(2n * UNIT);
  });

  it('reservationFor exposes the held reservation (with expiresAt as metadata only)', () => {
    const l = new ReservationLedger(UNIT);
    l.commit('o1', UNIT, 1000, 5000);
    const r = l.reservationFor('o1');
    expect(r?.amountStroops).toBe(UNIT);
    expect(r?.reservationId).toBe('res-o1');
    expect(r?.expiresAtMs).toBe(6000); // metadata; never fed to available()
    expect(l.reservationFor('o2')).toBeUndefined();
  });
});
