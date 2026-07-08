// Demo-valör settlement simulation (TRY-driven rebalance). On testnet there is no real iyzico bank
// settlement, so this store models it: when an order's USDC is delivered and irreversible (state enters
// {UsdcConfirmed, Reconciled}), a settlement-sim worker records ONE pending settlement whose settlesAt is
// confirmedAt + the compressed demo valör (45s). When the clock passes settlesAt, the worker converts the
// collected TRY to USDC at the LIVE rate and tops up the pool. This store is the pure bookkeeping half:
// one record per order (ever), a monotone status, and a single-winner claim() — it holds NO clock and NO
// I/O (the worker passes nowUnix; the InMemoryStore/mutex serialize the worker's mutations), mirroring
// ReservationLedger. In-memory for the PoC; a durable store (Phase-2) is a drop-in behind this interface.

import { canonicalizeOrderId } from '@troia/core';

export type SettlementStatus = 'pending' | 'settling' | 'settled' | 'voided';

export interface PendingSettlementInput {
  /** raw orderId; canonicalized (NFC) on the way in so NFC-variant redeliveries collapse to ONE record. */
  readonly orderId: string;
  /** the collected TRY in kuruş — drives the Model-B refill (converted to USDC at the LIVE rate on settle). */
  readonly tryKurus: bigint;
  /** the USDC that drained the pool for this order (reference / narrative). */
  readonly usdcPaidOutStroops: bigint;
  /** the frozen applied rate at charge time (reference). */
  readonly appliedRateStroops: bigint;
  /** clock at first discovery of the order in {UsdcConfirmed, Reconciled}. */
  readonly confirmedAtUnix: number;
  /** confirmedAtUnix + demoValorSecs — the record is only `due` once now passes this. */
  readonly settlesAtUnix: number;
}

export interface PendingSettlement extends PendingSettlementInput {
  readonly status: SettlementStatus;
}

export interface PendingSettlementStore {
  /** One record per canonical orderId, EVER. 'recorded' on the first discovery, 'exists' on any repeat —
   *  the foundation of settle-once (a re-discovery of a settled/voided order never resurrects it). */
  recordIfAbsent(rec: PendingSettlementInput): 'recorded' | 'exists';
  /** A fresh materialized snapshot of records ready to refill (status 'pending' AND settlesAt <= now).
   *  A copy, so the worker mutating the store mid-scan is safe (mirrors OrderRegistry.ordersInStates). */
  due(nowUnix: number): readonly PendingSettlement[];
  /** Single-winner CAS pending -> settling. Returns true to exactly ONE caller; false to a loser / a
   *  non-pending / an unknown order. Run under the shared per-order lock, this serializes the refill. */
  claim(orderId: string): boolean;
  /** settling -> settled (terminal). No-op off a non-settling record (defensive; recovery-safe). */
  markSettled(orderId: string): void;
  /** settling -> pending, so a later tick retries (a transient mint failure left nothing on-chain). */
  markFailed(orderId: string): void;
  /** pending|settling -> voided (a money-bad order — reverted/refunded — is NEVER refilled). Cannot
   *  override a settled record. */
  markVoided(orderId: string): void;
  get(orderId: string): PendingSettlement | undefined;
}

export class InMemoryPendingSettlementStore implements PendingSettlementStore {
  private readonly records = new Map<string, PendingSettlement>();

  recordIfAbsent(rec: PendingSettlementInput): 'recorded' | 'exists' {
    const orderId = canonicalizeOrderId(rec.orderId);
    if (this.records.has(orderId)) return 'exists';
    this.records.set(orderId, { ...rec, orderId, status: 'pending' });
    return 'recorded';
  }

  due(nowUnix: number): readonly PendingSettlement[] {
    const out: PendingSettlement[] = [];
    for (const r of this.records.values()) {
      if (r.status === 'pending' && r.settlesAtUnix <= nowUnix) out.push(r);
    }
    return out; // fresh array each call
  }

  claim(orderIdRaw: string): boolean {
    const orderId = canonicalizeOrderId(orderIdRaw);
    const r = this.records.get(orderId);
    if (!r || r.status !== 'pending') return false;
    this.records.set(orderId, { ...r, status: 'settling' });
    return true;
  }

  markSettled(orderIdRaw: string): void {
    this.fromSettling(orderIdRaw, 'settled');
  }

  markFailed(orderIdRaw: string): void {
    this.fromSettling(orderIdRaw, 'pending');
  }

  markVoided(orderIdRaw: string): void {
    const orderId = canonicalizeOrderId(orderIdRaw);
    const r = this.records.get(orderId);
    if (!r || r.status === 'settled' || r.status === 'voided') return; // settled is terminal
    this.records.set(orderId, { ...r, status: 'voided' });
  }

  get(orderIdRaw: string): PendingSettlement | undefined {
    return this.records.get(canonicalizeOrderId(orderIdRaw));
  }

  private fromSettling(orderIdRaw: string, to: SettlementStatus): void {
    const orderId = canonicalizeOrderId(orderIdRaw);
    const r = this.records.get(orderId);
    if (!r || r.status !== 'settling') return; // defensive no-op off a non-settling record
    this.records.set(orderId, { ...r, status: to });
  }
}
