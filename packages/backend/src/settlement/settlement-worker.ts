// The settlement-sim worker (the heart of the TRY-driven rebalance). It mirrors the poll worker: it takes the
// registry + the SHARED per-order lock + injected collaborators, and drives a money-safe step under that lock
// so a tick and a concurrent webhook/poll for one order serialize. It touches the pure money-first core NOT AT
// ALL — it works by DISCOVERY (a state scan), never a new reducer effect.
//
// Two phases per tick:
//   A) ARM: scan orders in {UsdcConfirmed, Reconciled} — the only states where the pool was truly drained AND
//      the charge can never be reversed — and record ONE pending settlement each, due at now + the compressed
//      demo valör (default 30s). recordIfAbsent is per-canonical-order idempotent, so re-discovery never re-arms.
//   B) SETTLE: for each due record, RE-READ the order (a record whose order is no longer money-good is voided,
//      never minted), win the single-writer claim() CAS, then refill EXACTLY the collected TRY converted to USDC
//      at the LIVE rate: topUp (mint, idempotent per `topup:<orderId>` ref) -> recordTopUp (book) -> creditPool
//      (raise the /intent gate) -> markSettled. Mint-and-book-or-neither: any throw before markSettled leaves
//      nothing booked/credited and returns the record to pending for a later retry (a clean throw minted nothing;
//      the deterministic ref makes a within-process re-mint a cache hit). Fail-closed on an unreadable rate.

import type { State } from '@troia/core';
import type { Clock } from '../ports.js';
import type { OrderRegistry } from '../http/order-registry.js';
import type { KeyedMutex } from '../store/mutex.js';
import type { PendingSettlementStore } from './pending-settlement-store.js';
import type { RebalancePolicy, TopUpRequest } from './rebalance-policy.js';

/** The states where the pool is proven drained AND the charge is irreversible — the only refill anchor. */
const SETTLEMENT_STATES: readonly State[] = ['UsdcConfirmed', 'Reconciled'];

function isMoneyGood(state: State): boolean {
  return state === 'UsdcConfirmed' || state === 'Reconciled';
}

/** Parse a server-computed "N" / "N.M" / "N.MM" TRY price into kuruş (× 100). Throws on anything else so a
 *  malformed price fails closed (the order is skipped/retried, never minted on a bogus basis). */
export function tryToKurus(paidPriceTry: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(paidPriceTry.trim());
  if (m === null) throw new RangeError(`malformed paidPriceTry: ${paidPriceTry}`);
  const whole = BigInt(m[1] as string);
  const frac = (m[2] ?? '').padEnd(2, '0'); // "4" -> "40", "" -> "00"
  return whole * 100n + BigInt(frac);
}

function isDuplicateRef(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'DuplicateRef';
}

/** The mint/buy execution result the worker needs (structurally satisfied by @troia/rebalance's TopUpResult). */
export interface TopUpExecution {
  readonly usdcStroops: bigint;
  readonly txHash: string;
}

/** Narrow injected collaborators (interface-typed; concretes wired at the composition root, like ports.ts). */
export interface SettlementDeps {
  readonly registry: OrderRegistry;
  readonly orderLocks: KeyedMutex;
  readonly clock: Clock;
  readonly pending: PendingSettlementStore;
  readonly policy: RebalancePolicy;
  readonly rebalance: { topUp(req: TopUpRequest): Promise<TopUpExecution> };
  readonly store: { creditPool(stroops: bigint): Promise<void> };
  readonly ledger: {
    recordTopUp(input: { ref: string; usdcStroops: bigint; valueKurus: bigint }): unknown;
  };
  /** the LIVE rate (TRY per USDC, 7-decimal stroops) read at settle time — the oracle. Throws => fail-closed. */
  readonly rate: { liveRateStroops(): Promise<bigint> };
  readonly demoValorSecs: number;
}

export interface SettleReport {
  readonly armed: number;
  readonly settled: number;
  readonly voided: number;
  readonly failed: number;
  readonly skipped: number;
}

export async function settleAndRebalance(deps: SettlementDeps): Promise<SettleReport> {
  const { registry, orderLocks, clock, pending } = deps;
  const report = { armed: 0, settled: 0, voided: 0, failed: 0, skipped: 0 };

  // Phase A — ARM (discovery): one pending settlement per money-good order, due at now + demo valör.
  for (const snap of registry.ordersInStates(SETTLEMENT_STATES)) {
    await orderLocks.run(snap.ctx.orderId, async () => {
      const rec = registry.getByOrderId(snap.ctx.orderId);
      if (rec === undefined || !isMoneyGood(rec.state)) return;
      let tryKurus: bigint;
      try {
        tryKurus = tryToKurus(rec.ctx.paidPriceTry);
      } catch {
        return; // malformed price -> skip arming (fail-closed; retried next tick if it becomes parseable)
      }
      if (tryKurus <= 0n) return;
      const now = clock.nowUnix();
      const outcome = pending.recordIfAbsent({
        orderId: rec.ctx.orderId,
        tryKurus,
        usdcPaidOutStroops: rec.ctx.amountStroops,
        appliedRateStroops: rec.ctx.appliedRateStroops,
        confirmedAtUnix: now,
        settlesAtUnix: now + deps.demoValorSecs,
      });
      if (outcome === 'recorded') report.armed += 1;
    });
  }

  // Phase B — SETTLE: refill the pool exactly once per due record.
  for (const dueRec of pending.due(clock.nowUnix())) {
    await orderLocks.run(dueRec.orderId, async () => {
      // RE-READ inside the lock — a record whose order is no longer money-good (defensive: UsdcConfirmed is
      // forward-only in practice) is VOIDED, never minted.
      const rec = registry.getByOrderId(dueRec.orderId);
      if (rec === undefined || !isMoneyGood(rec.state)) {
        pending.markVoided(dueRec.orderId);
        report.voided += 1;
        return;
      }
      if (!pending.claim(dueRec.orderId)) {
        report.skipped += 1; // lost the single-winner CAS to a concurrent tick
        return;
      }
      try {
        const liveRate = await deps.rate.liveRateStroops(); // live CEX rate; throws -> fail-closed (no mint)
        const req = deps.policy.plan(dueRec, liveRate);
        const result = await deps.rebalance.topUp(req); // mint (idempotent per ref)
        try {
          deps.ledger.recordTopUp({
            ref: req.ref,
            usdcStroops: result.usdcStroops,
            valueKurus: req.valueKurus,
          });
        } catch (e) {
          if (!isDuplicateRef(e)) throw e; // already booked (restart replay) -> proceed idempotently
        }
        // creditPool is NOT ref-idempotent, so markSettled is adjacent (no await between): within a process the
        // pair is atomic under the per-order lock, so a re-tick can never double-credit.
        await deps.store.creditPool(result.usdcStroops);
        pending.markSettled(dueRec.orderId);
        report.settled += 1;
      } catch {
        pending.markFailed(dueRec.orderId); // a clean throw minted nothing -> retry next tick
        report.failed += 1;
      }
    });
  }

  return report;
}
