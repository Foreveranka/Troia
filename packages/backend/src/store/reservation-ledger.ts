// PURE, synchronous SPIKE-3 solvency ledger: a seeded pool balance + a Map of held reservations keyed by
// orderId. It holds NO clock and NO I/O — the InMemoryStore wraps it under the pool mutex for atomicity.
//
// FAIL-CLOSED RULE (audited BLOCKER fix): available() counts EVERY held reservation. TTL/expiry is NEVER an
// arithmetic input — a wall-clock prune would free a still-in-flight order's capacity with no deadness proof
// (ARCHITECTURE: "deadness is hash-first, not wall-clock; Date.now() is forbidden for deadness"), letting a
// later order over-commit the same balance = insolvency. Capacity is lowered ONLY by an explicit release()
// (the engine on proven-terminal paths; the reconciler after a hash-first deadness proof, reason 'expired').
// expiresAtMs is retained as reconciler-only METADATA (which reservations to investigate), never math.
// Worst case is therefore UNDER-commit (a crashed order's capacity stays locked until proven dead) = a
// delayed payout (liveness), never a negative pool.

import type { ReserveOutcome } from '../ports.js';

export interface Reservation {
  readonly reservationId: string;
  readonly amountStroops: bigint;
  readonly reservedAtMs: number;
  /** reconciler-only metadata — NEVER consulted by available()/sumReserved(). */
  readonly expiresAtMs: number;
}

export class ReservationLedger {
  private readonly reservations = new Map<string, Reservation>();

  constructor(private readonly balanceStroops: bigint) {}

  balance(): bigint {
    return this.balanceStroops;
  }

  /** Σ of EVERY held reservation — no time filter (fail-closed). */
  sumReserved(): bigint {
    let sum = 0n;
    for (const r of this.reservations.values()) sum += r.amountStroops;
    return sum;
  }

  /** balance − Σ held. Can never be made larger by the passage of time. */
  available(): bigint {
    return this.balanceStroops - this.sumReserved();
  }

  reservationFor(orderId: string): Reservation | undefined {
    return this.reservations.get(orderId);
  }

  /**
   * Add a reservation for orderId. LOW-LEVEL: it TRUSTS that the caller (InMemoryStore.reserve) has, under
   * the pool mutex, verified `available() >= amountStroops` and that no active reservation exists for the
   * order. It deliberately does NOT re-check — the check-then-commit separation is what makes the pool mutex
   * load-bearing (a re-check here would make the lock redundant and the SPIKE-3 proof meaningless).
   */
  commit(orderId: string, amountStroops: bigint, nowMs: number, ttlMs: number): ReserveOutcome {
    const reservationId = `res-${orderId}`;
    this.reservations.set(orderId, {
      reservationId,
      amountStroops,
      reservedAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    });
    return { kind: 'reserved', reservationId };
  }

  /** Idempotent: no-op if the order holds no reservation. The ONLY thing that frees capacity. */
  release(orderId: string): void {
    this.reservations.delete(orderId);
  }
}
