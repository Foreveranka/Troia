// The settlement-sim worker (the heart of the TRY-driven rebalance).
//
// ITS WORK-LIST IS DURABLE. It used to scan the in-memory order registry, which meant a crash between "the payout
// confirmed" and "the next tick" lost the order forever: its outflow was never booked, so the double-entry ledger
// stayed permanently above the chain and the solvency alarm rang for a discrepancy nobody could close; and its
// pool refill simply never happened, silently. Now it scans the durable evidence log, one row per money-good
// payout, written the moment the pay() was witnessed. A restart rediscovers every unfinished order. It mirrors the poll worker: it takes the
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

import type { Clock, OrderFacts } from '../ports.js';
import type { KeyedMutex } from '../store/mutex.js';
import type { PendingSettlementStore } from './pending-settlement-store.js';
import type { RebalancePolicy, TopUpRequest } from './rebalance-policy.js';
import { isDurableLogFailure } from '../ports.js';

// Money-good is no longer a STATE the worker reads from memory. It is a durable evidence row: written the instant
// a pay() is witnessed on chain, never removed, and UsdcConfirmed is forward-only. A row IS the proof.

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

/**
 * The mint write-ahead journal (KNOWN_ISSUES §2). The pool refill's double-spend window is the gap between
 * `topUp` landing on chain and `recordTopUp` reaching the ledger: a crash inside it leaves the mint real and
 * unbooked, `hasRef` still false, and the next life mints AGAIN — on mainnet, the same fiat spent twice. The
 * fix is the same discipline the pay() path uses (persistInFlight precedes submitPay): a durable intent is
 * written BEFORE the mint and cleared only after the booking, so a restart can see the open question.
 *
 * Semantics: `open` is the write-ahead ("about to mint this ref") — it must be DURABLE before returning, and
 * is idempotent within one process life (a clean same-life retry re-opens it). `close` resolves it (the
 * booking landed). `isBlocked` is true only for a ref left open by a PREVIOUS life: the mint may or may not
 * be on chain, nobody in this process can know, so the worker refuses to mint that ref and surfaces it —
 * the mint path's equivalent of LossReview. A same-life open ref is NOT blocked (the rebalance provider's
 * per-ref idempotency makes the in-process retry safe).
 */
export interface MintIntentJournal {
  isBlocked(ref: string): boolean;
  open(ref: string): void;
  close(ref: string): void;
}

/** Narrow injected collaborators (interface-typed; concretes wired at the composition root, like ports.ts). */
/** One money-good payout, as remembered on disk. Everything the worker needs; nothing it does not. */
export interface ConfirmedOrder {
  readonly orderId: string;
  readonly order: OrderFacts;
}

export interface SettlementDeps {
  /** The durable roll of money-good payouts. Backed by the evidence log, so it survives a restart. */
  readonly confirmed: {
    all(): readonly ConfirmedOrder[];
    get(orderId: string): ConfirmedOrder | undefined;
  };
  readonly orderLocks: KeyedMutex;
  readonly clock: Clock;
  readonly pending: PendingSettlementStore;
  readonly policy: RebalancePolicy;
  readonly rebalance: { topUp(req: TopUpRequest): Promise<TopUpExecution> };
  readonly store: { creditPool(stroops: bigint): Promise<void> };
  readonly ledger: {
    /** Has this ref already been booked, in this life or a previous one? The durable answer to "did we already
     *  do this?" — asked BEFORE a side effect, because asking after it is too late. */
    hasRef(ref: string): boolean;
    /** Books the USDC that LEFT the pool for one order (idempotent per orderId; DuplicateRef on a repeat). */
    recordSettlement(input: {
      orderId: string;
      usdcStroops: bigint;
      userTryKurus: bigint;
      spreadKurus: bigint;
      feeKurus?: bigint;
    }): unknown;
    recordTopUp(input: { ref: string; usdcStroops: bigint; valueKurus: bigint }): unknown;
  };
  /** the LIVE rate (TRY per USDC, 7-decimal stroops) read at settle time — the oracle. Throws => fail-closed. */
  readonly rate: { liveRateStroops(): Promise<bigint> };
  readonly demoValorSecs: number;
  /** the mint write-ahead journal. OPTIONAL: absent offline (pure in-memory, exactly as before); the durable
   *  deployment injects it, and only then does the §2 crash window actually close. */
  readonly mintIntents?: MintIntentJournal;
}

export interface SettleReport {
  readonly armed: number;
  readonly settled: number;
  readonly voided: number;
  readonly failed: number;
  readonly skipped: number;
  /** orders whose USDC outflow was booked into the double-entry ledger for the first time. */
  readonly booked: number;
  /** refs refused because a PREVIOUS life opened a mint intent and never resolved it — the mint may be on
   *  chain unbooked. Nothing is minted for them; a human must reconcile (book it or clear the intent). */
  readonly mintBlocked: number;
}

export async function settleAndRebalance(deps: SettlementDeps): Promise<SettleReport> {
  const { confirmed, orderLocks, clock, pending } = deps;
  const report = {
    armed: 0,
    settled: 0,
    voided: 0,
    failed: 0,
    skipped: 0,
    booked: 0,
    mintBlocked: 0,
  };

  // Phase A — ARM (discovery): one pending settlement per money-good payout, due at now + demo valör. A row in
  // the evidence log means the pay() was witnessed on chain, and UsdcConfirmed is forward-only — so a row IS the
  // proof that this order is money-good, durably, whether or not this process ever saw the order.
  for (const c of confirmed.all()) {
    await orderLocks.run(c.orderId, async () => {
      const rec = confirmed.get(c.orderId);
      if (rec === undefined) return;
      let tryKurus: bigint;
      try {
        tryKurus = tryToKurus(rec.order.paidPriceTry);
      } catch {
        return; // malformed price -> skip arming (fail-closed; retried next tick if it becomes parseable)
      }
      if (tryKurus <= 0n) return;

      // Book the USDC that LEFT the pool. This is the outflow half of the double entry, and without it the
      // ledger only ever rises: `nativeBalance('USDC_POOL')` would drift above the chain by the sum of every
      // payout, and the solvency alarm that compares the two would cry wolf on every tick.
      //
      // It happens BEFORE arming, and durably. If the journal write fails, nothing is armed and the order is
      // rediscovered next tick — so a booking can be lost only together with the arming that follows it.
      // DuplicateRef means a previous life already booked it: the journal survived, the in-memory arming did not.
      try {
        deps.ledger.recordSettlement({
          orderId: rec.orderId,
          usdcStroops: rec.order.amountStroops,
          userTryKurus: tryKurus,
          spreadKurus: rec.order.spreadKurus,
          feeKurus: rec.order.feeKurus,
        });
        report.booked += 1;
      } catch (e) {
        if (isDurableLogFailure(e)) throw e; // nothing can be recorded any more — fail fast
        if (!isDuplicateRef(e)) {
          report.skipped += 1; // an unbookable order (a price the ledger rejects); the drift alarm will surface it
          return;
        }
      }

      const now = clock.nowUnix();
      const outcome = pending.recordIfAbsent({
        orderId: rec.orderId,
        tryKurus,
        usdcPaidOutStroops: rec.order.amountStroops,
        appliedRateStroops: rec.order.appliedRateStroops,
        confirmedAtUnix: now,
        settlesAtUnix: now + deps.demoValorSecs,
      });
      if (outcome === 'recorded') report.armed += 1;
    });
  }

  // Phase B — SETTLE: refill the pool exactly once per due record.
  for (const dueRec of pending.due(clock.nowUnix())) {
    await orderLocks.run(dueRec.orderId, async () => {
      // RE-READ inside the lock — a record with no durable evidence is not a money-good payout and is VOIDED,
      // never minted.
      if (confirmed.get(dueRec.orderId) === undefined) {
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
        // ASK THE DURABLE LEDGER BEFORE MINTING. The pending-settlement store lives in memory, so a restart
        // re-arms an order that was already refilled in a previous life; the mint's own idempotency cache is
        // in-memory too, so it would mint a SECOND time on chain. The journal is durable and knows better.
        // The pool base was re-seeded from the chain at boot and already includes that mint, so nothing is
        // credited here either — only the bookkeeping is closed.
        if (deps.ledger.hasRef(req.ref)) {
          // Already booked. A still-open intent here is the benign tail of the WAL (crash between the booking
          // and the close): the question it asked is answered, so resolve it rather than block forever.
          deps.mintIntents?.close(req.ref);
          pending.markSettled(dueRec.orderId);
          report.skipped += 1;
          return;
        }
        // THE §2 GUARD. An intent left open by a PREVIOUS life means a mint may be sitting on chain unbooked —
        // hasRef cannot know (the crash was before the booking), and minting again is exactly the double-spend
        // this journal exists to prevent. Refuse, surface, and let a human reconcile: if the mint landed, they
        // book it (hasRef then short-circuits above and resolves the intent); if it never landed, they clear
        // the intent and the next tick mints normally.
        if (deps.mintIntents?.isBlocked(req.ref) === true) {
          pending.markFailed(dueRec.orderId); // stays visible and retriable — resolution unblocks it
          report.mintBlocked += 1;
          return;
        }
        // WRITE-AHEAD: the intent hits the disk BEFORE the mint can exist. A throw here aborts with nothing
        // minted (and, being a durable-log failure, takes the process down — same rule as every other sink).
        deps.mintIntents?.open(req.ref);
        const result = await deps.rebalance.topUp(req); // mint (idempotent per ref, within this process)
        try {
          deps.ledger.recordTopUp({
            ref: req.ref,
            usdcStroops: result.usdcStroops,
            valueKurus: req.valueKurus,
          });
        } catch (e) {
          if (!isDuplicateRef(e)) throw e; // already booked (restart replay) -> proceed idempotently
        }
        deps.mintIntents?.close(req.ref); // the booking is durable — the write-ahead question is answered
        // creditPool is NOT ref-idempotent, so markSettled is adjacent (no await between): within a process the
        // pair is atomic under the per-order lock, so a re-tick can never double-credit.
        await deps.store.creditPool(result.usdcStroops);
        pending.markSettled(dueRec.orderId);
        report.settled += 1;
      } catch (e) {
        // A poisoned durable log is NOT a transient failure. Swallowing it into markFailed would retry every
        // tick — re-running the mint that precedes the booking — while creditPool is never reached and the
        // /intent solvency gate never rises. Nothing can be booked again in this process, so fail fast and let
        // a restart re-run the boot-time write probe.
        if (isDurableLogFailure(e)) throw e;
        pending.markFailed(dueRec.orderId); // a clean throw minted nothing -> retry next tick
        report.failed += 1;
      }
    });
  }

  return report;
}
