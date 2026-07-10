// The rogue-payout detector: attribution for money leaving the pool.
//
// It complements the drift tripwire rather than replacing it. Drift is windowless and always right about the
// TOTAL — it will notice value missing no matter how it left — but it cannot say which transaction, to whom, or
// when. This tail can, and it pays for that with a window: Soroban RPC keeps contract events for a rolling
// period (~7 days on the endpoint we use, and it MOVES), so a tail that was down longer than the window has a
// gap it can never re-read. That gap is declared, not hidden, and drift covers it.
//
// WHY IT CAN ACCUSE. The write-ahead journal records a pay()'s transaction hash durably BEFORE the transaction is
// broadcast. So a transaction cannot land — and therefore cannot emit an outflow event — unless its hash was
// already on disk. An outflow whose hash is absent from that journal was never authorized by us. Not "not yet
// witnessed", not "still settling". Never authorized. There is no timing window to get wrong, and no in-memory
// allowlist for a restart to erase.
//
// Grace, then, is not the correctness mechanism — it is a small margin measured in LEDGER CLOSE TIME (never the
// local clock, which could accuse someone because a container's clock drifted). A suspect is re-checked every
// tick and pages exactly once.
//
// The tick's durable ordering is the crash contract: record what you saw BEFORE you advance the cursor. A crash
// in between re-reads the same page, which is harmless. A cursor advanced past an unrecorded suspect would lose
// a theft forever — the one outcome worse than a false alarm.

import type {
  OutflowEvent,
  PoolFetch,
  PoolActivityPage,
  PoolUpgrade,
  SettlementObservation,
} from '@troia/stellar-client';

/** An outflow we cannot account for, and the chain time at which we first saw it. */
export interface Suspect {
  readonly txHash: string;
  /** The event's own ledger close time. Immutable across restarts, so a catch-up cannot restart the clock. */
  readonly firstSeenLedgerCloseUnix: number;
  readonly ledger: number;
  readonly amountStroops: bigint;
  /** Where the value went — attribution for the page, never part of the verdict. */
  readonly to: string;
  readonly alarmed: boolean;
}

export interface OutflowVerdict {
  /** Escalated this tick: unauthorized, and past grace. Page these, once each. */
  readonly rogue: readonly Suspect[];
  /** First seen this tick and unauthorized. Record them durably before the cursor moves. */
  readonly newSuspects: readonly Suspect[];
  /** Suspects that turned out to be authorized after all. Tombstone them. */
  readonly cleared: readonly string[];
  /** Unauthorized but still inside grace. Keep watching. */
  readonly pending: readonly Suspect[];
}

/**
 * Pure. Fold a page of outflows and the suspects we were already carrying into a verdict.
 *
 * `isAuthorized` must read a LIVE view of the write-ahead journal, not a snapshot: the journal only ever grows,
 * and a hash added between the fetch and this call belongs to a transaction that has not landed yet.
 */
export function judgeOutflows(
  events: readonly OutflowEvent[],
  priorSuspects: readonly Suspect[],
  isAuthorized: (txHash: string) => boolean,
  latestLedgerCloseUnix: number,
  graceSecs: number,
): OutflowVerdict {
  const tracked = new Map<string, Suspect>(priorSuspects.map((s) => [s.txHash, s]));
  const newSuspects: Suspect[] = [];

  for (const e of events) {
    if (isAuthorized(e.txHash)) continue; // ours
    if (tracked.has(e.txHash)) continue; // already carrying it, with its ORIGINAL first-seen time
    const s: Suspect = {
      txHash: e.txHash,
      firstSeenLedgerCloseUnix: e.ledgerCloseUnix,
      ledger: e.ledger,
      amountStroops: e.amountStroops,
      to: e.to,
      alarmed: false,
    };
    tracked.set(e.txHash, s);
    newSuspects.push(s);
  }

  const rogue: Suspect[] = [];
  const cleared: string[] = [];
  const pending: Suspect[] = [];
  for (const s of tracked.values()) {
    if (isAuthorized(s.txHash)) {
      cleared.push(s.txHash); // it was ours after all — the journal is the authority, not our earlier reading
      continue;
    }
    const ageSecs = latestLedgerCloseUnix - s.firstSeenLedgerCloseUnix;
    if (!s.alarmed && ageSecs >= graceSecs) rogue.push({ ...s, alarmed: true });
    else pending.push(s);
  }
  return { rogue, newSuspects, cleared, pending };
}

// ---------------------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------------------

/**
 * Everything the chain said about the pool, kept because the chain will not keep it: Soroban RPC forgets contract
 * events after about a week, and the reconciler needs to look a settlement up by the order's identifier long after
 * that. Durable, and written before the checkpoint moves past the page that produced it.
 */
export interface ChainObservationStore {
  recordOutflow(o: OutflowEvent): void;
  recordSettlement(s: SettlementObservation): void;
  recordUpgrade(u: PoolUpgrade): void;
  /** The pool's own announcement for this order, found by the identifier the CONTRACT indexes — not by the
   *  transaction hash we happen to have recorded. That is what makes it an independent read. */
  settlementByTxId(txIdHex: string): SettlementObservation | undefined;
  /** How much USDC actually left the pool in this transaction. The pool announces an amount; this is the amount
   *  the token contract actually moved. They must agree. */
  outflowStroopsByTx(txHash: string): bigint;
  /** Every time the pool's code was replaced. After the first one, its announcements prove nothing. */
  upgrades(): readonly PoolUpgrade[];
  /**
   * The instant the tail began (or resumed) watching. Nothing before it was ever scanned, so the ABSENCE of an
   * observation before this point is a statement about us, not about the chain. Monotonic: a later start wins,
   * because a re-anchor after a retention gap moves the floor forward.
   */
  recordCoverageStart(unix: number): void;
  coverageStartUnix(): number | null;
}

/** Last-wins checkpoint. Written AFTER everything on the page is durably accounted for. */
export interface CursorStore {
  load(): string | null;
  save(cursor: string): void;
}

/** Durable, because a suspect that lives only in memory is a theft that a restart forgets. */
export interface SuspectStore {
  all(): readonly Suspect[];
  record(s: Suspect): void;
  markAlarmed(txHash: string): void;
  tombstone(txHash: string): void;
}

export interface OutflowTailDeps {
  readonly tail: {
    fetchPoolActivity(req: PoolFetch): Promise<PoolActivityPage>;
    latestLedger(): Promise<number>;
  };
  readonly cursor: CursorStore;
  readonly suspects: SuspectStore;
  readonly observations: ChainObservationStore;
  /** A LIVE view of every pay() hash ever put on the wire. */
  readonly authorized: { has(txHash: string): boolean };
  readonly graceSecs: number;
  /** How far back a cold start anchors. Small: everything before it is an acknowledged, logged blind spot. */
  readonly coldStartMarginLedgers: number;
  /**
   * The same clock the evidence rows are stamped with. Used ONLY to record where our coverage begins, never to
   * judge an outflow — that is ledger close time. The reconciler compares an evidence row's stamp against this
   * one, so both must come from the same clock or the comparison is meaningless.
   */
  readonly nowUnix: () => number;
}

export type OutflowTickReport =
  | {
      readonly kind: 'scanned';
      readonly outflows: number;
      readonly settlements: number;
      readonly upgrades: readonly PoolUpgrade[];
      readonly rogue: readonly Suspect[];
      readonly newSuspects: number;
      readonly cleared: number;
      readonly pending: number;
      readonly latestLedger: number;
      /** Set on the first tick of a cold start: nothing before this ledger was ever examined. */
      readonly coldStartFromLedger: number | null;
    }
  | {
      readonly kind: 'blindSpot';
      readonly fromLedger: number;
      readonly toLedger: number;
      readonly latestLedger: number;
    }
  | { readonly kind: 'stalled'; readonly reason: string };

/**
 * One pass. The durable order is load-bearing:
 *   fetch -> judge -> record new suspects -> mark escalations -> tombstone cleared -> SAVE CURSOR LAST.
 * A crash anywhere before the last step re-reads the same page next boot, and every step is idempotent.
 */
export async function tailOutflows(deps: OutflowTailDeps): Promise<OutflowTickReport> {
  const saved = deps.cursor.load();
  let coldStartFromLedger: number | null = null;
  let req: PoolFetch;
  if (saved === null) {
    const head = await deps.tail.latestLedger();
    coldStartFromLedger = Math.max(1, head - deps.coldStartMarginLedgers);
    // Say where our knowledge begins BEFORE we act on any of it. A payout witnessed before this instant settled in
    // ledgers we never read, so its absence from our observations means nothing and must never be reported as the
    // pool having announced nothing. Recorded conservatively (the anchor is a few minutes older than `now`), which
    // can only widen the "we never looked" window — never narrow it into a false accusation.
    deps.observations.recordCoverageStart(deps.nowUnix());
    req = { startLedger: coldStartFromLedger };
  } else {
    req = { cursor: saved };
  }

  const page = await deps.tail.fetchPoolActivity(req);

  if (page.kind === 'RPC_UNAVAILABLE') {
    // We could not look. Do not advance, do not accuse, do not go quiet.
    return { kind: 'stalled', reason: page.reason };
  }
  if (page.kind === 'CURSOR_BELOW_RETENTION') {
    // The window scrolled past us. Those events are unreachable, by anyone, forever. Re-anchor so the next tick
    // resumes AT head (a cursor resumes strictly after its ledger, so anchor one before), and say so out loud.
    // Coverage restarts here too: a settlement inside the lost window can never be observed, so no order witnessed
    // before now may be accused of having no settlement. Recorded before the cursor, like everything else.
    deps.observations.recordCoverageStart(deps.nowUnix());
    deps.cursor.save(toidAtLedger(Math.max(1, page.latestLedger - 1)));
    return {
      kind: 'blindSpot',
      fromLedger: page.cursorLedger,
      toLedger: page.oldestLedger,
      latestLedger: page.latestLedger,
    };
  }

  // Record what the chain said BEFORE the checkpoint moves past it. Everything after this line is idempotent on
  // a re-read, and nothing before it can be lost by a crash without also losing the checkpoint that skipped it.
  for (const o of page.outflows) deps.observations.recordOutflow(o);
  for (const s of page.settlements) deps.observations.recordSettlement(s);
  for (const u of page.upgrades) deps.observations.recordUpgrade(u);

  const verdict = judgeOutflows(
    page.outflows,
    deps.suspects.all(),
    (h) => deps.authorized.has(h),
    page.latestLedgerCloseUnix,
    deps.graceSecs,
  );

  for (const s of verdict.newSuspects) deps.suspects.record(s);
  for (const s of verdict.rogue) deps.suspects.markAlarmed(s.txHash);
  for (const h of verdict.cleared) deps.suspects.tombstone(h);
  deps.cursor.save(page.cursor); // LAST: everything on this page is now durably accounted for

  return {
    kind: 'scanned',
    outflows: page.outflows.length,
    settlements: page.settlements.length,
    upgrades: page.upgrades,
    rogue: verdict.rogue,
    newSuspects: verdict.newSuspects.length,
    cleared: verdict.cleared.length,
    pending: verdict.pending.length,
    latestLedger: page.latestLedger,
    coldStartFromLedger,
  };
}

/**
 * A cursor positioned at the very end of `ledger`. Measured against the live RPC: resuming from this cursor
 * returns events strictly AFTER `ledger` — the ledger itself is skipped — so anchoring at `L-1` is how you say
 * "start at L". The 19-digit zero padding matches the format the RPC emits.
 */
export function toidAtLedger(ledger: number): string {
  const toid = (BigInt(ledger) << 32n) | 0xffffffffn;
  return `${toid.toString().padStart(19, '0')}-4294967295`;
}

// ---------------------------------------------------------------------------------------------------------
// Stall escalation — the same shape as the drift monitor
// ---------------------------------------------------------------------------------------------------------

export const DEFAULT_TAIL_STALL_AFTER = 3;

export interface TailHealthState {
  readonly consecutiveStalls: number;
  readonly alarmed: boolean;
}

export const INITIAL_TAIL_HEALTH: TailHealthState = { consecutiveStalls: 0, alarmed: false };

export interface TailHealthObservation {
  readonly state: TailHealthState;
  /** The tail has made no forward progress for long enough that someone must look. Fires once per episode. */
  readonly alarm: boolean;
  readonly recovered: boolean;
}

/** A tail that cannot reach its RPC is not a tail that saw nothing. Say so, once, and keep saying nothing after. */
export function observeTailHealth(
  prev: TailHealthState,
  stalled: boolean,
  alarmAfter: number = DEFAULT_TAIL_STALL_AFTER,
): TailHealthObservation {
  if (!stalled) {
    return { state: INITIAL_TAIL_HEALTH, alarm: false, recovered: prev.consecutiveStalls > 0 };
  }
  const consecutiveStalls = prev.consecutiveStalls + 1;
  const due = consecutiveStalls >= alarmAfter;
  return {
    state: { consecutiveStalls, alarmed: prev.alarmed || due },
    alarm: due && !prev.alarmed,
    recovered: false,
  };
}
