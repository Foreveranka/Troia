// The reconciler, running. Until now it only ever ran offline, over a hand-built fixture; the `Reconciled` state
// was unreachable in production and the "did a DIFFERENT transaction settle this order?" branch was a tautology,
// because the demo built the chain's side of the comparison out of its own expected values.
//
// The independence comes from HOW an order finds its settlement. Not by the transaction hash we recorded — that
// would be asking our own records to confirm our own records. By `tx_id`, the identifier the CONTRACT indexes,
// derived from the order id. Whatever transaction emitted `payment_made` under that identifier is the transaction
// that actually settled the order. If it is not the one we recorded, that is a divergence, and it is now a thing
// this system can see.
//
// Four ways the audit refuses to say MATCHED, each for its own reason:
//
//   the pool's code was replaced   — after an `upgrade()`, `payment_made` means whatever the new code says it
//                                    means. Every announcement it makes afterwards is a claim, not a proof.
//   the announcement lies          — the pool announces an amount; the token contract records what actually moved.
//                                    Upgraded code could transfer one number and announce another. They must agree.
//   the chain no longer has it     — a durable local observation outlives the chain it describes. After a testnet
//                                    reset the settlement is simply gone, and reconciling MATCHED off that stale
//                                    cache would assert the chain agrees about something it never heard of.
//   we cannot look                 — an RPC we cannot reach is not a chain that says no. Retry; never conclude.
//
// And it never advances an order on anything less. `Reconciled` is terminal, and it means "the chain agrees".

import type { PoolUpgrade, SettlementObservation, TxLiveness } from '@troia/stellar-client';
import type { EvidenceRow } from '../ports.js';
import type { ChainObservationStore } from './outflow-worker.js';

/** The offline reconciler's verdicts, reproduced structurally so this package takes no dependency on it. */
export type Verdict =
  'MATCHED' | 'CORRUPT_LOCAL' | 'CHAIN_DIVERGENCE' | 'EVIDENCE_TAMPERED' | 'UNSETTLED';

export interface FieldDiff {
  readonly field: string;
  readonly local_value: string;
  readonly chain_value: string;
}

export interface GroundTruth {
  readonly verdict: Verdict;
  readonly signature_valid: boolean;
  readonly hash_consistent: boolean;
  readonly chain_bound: boolean;
  readonly field_diff: readonly FieldDiff[];
}

/** The three artifacts, in the offline reconciler's own shapes. Assembled here; judged by it. */
export interface BusinessIntent {
  readonly order_id: string;
  readonly destination: string;
  readonly amount_stroops: string;
  readonly memo_hex: string;
}
export interface LedgerEvidence {
  readonly signed_xdr: string;
  readonly hash: string;
}
export interface ChainSnapshot {
  readonly function: 'pay';
  readonly contract_id: string;
  readonly source_account: string;
  readonly tx_id_hex: string;
  readonly amount_stroops: string;
  readonly applied_rate_stroops: string;
  readonly merchant: string;
  readonly memo_hex: string;
}
export interface ChainEvidence {
  readonly tx_hash: string;
  readonly fetched_at_ledger: number;
  readonly horizon_snapshot: ChainSnapshot;
}

/** `resolveGroundTruth` from @troia/reconciler, injected so this package acquires no Stellar SDK import. */
export type ResolveGroundTruth = (
  intent: BusinessIntent,
  ledger: LedgerEvidence,
  chain: ChainEvidence | null,
  operatorPublic: string,
  passphrase: string,
) => GroundTruth;

/** The audit's outcome for one order. `advance` is true only for the one verdict that permits it. */
export type OrderAudit =
  | { readonly kind: 'reconciled'; readonly orderId: string }
  | {
      readonly kind: 'diverged';
      readonly orderId: string;
      readonly verdict: Verdict;
      readonly detail: string;
      readonly fieldDiff: readonly FieldDiff[];
    }
  | { readonly kind: 'unobservable'; readonly orderId: string; readonly ageSecs: number }
  /**
   * We cannot conclude, and the reason is us, not the chain. Distinct from `unobservable`, which says the pool
   * announced nothing where we were watching. Here we were not watching, or the chain has since forgotten:
   *   never-watched — the payout predates the ledger where the tail began; those events were never read.
   *   aged-out      — we hold the announcement, but the transaction is no longer retrievable, so it cannot be
   *                   re-confirmed. Indistinguishable from a testnet reset or a tx that never landed.
   * Neither is an accusation. Drift remains the cover for value that actually went missing.
   */
  | {
      readonly kind: 'blind';
      readonly orderId: string;
      readonly reason: 'never-watched' | 'aged-out';
      readonly ageSecs: number;
    }
  | { readonly kind: 'waiting'; readonly orderId: string }
  | { readonly kind: 'unreachable'; readonly orderId: string; readonly reason: string };

export interface ReconcileReport {
  readonly audited: number;
  readonly reconciled: readonly string[];
  readonly problems: readonly OrderAudit[];
  readonly waiting: number;
  readonly unreachable: number;
  /** Latched: the pool's code was replaced, so no settlement it announces can be verified any more. */
  readonly upgrades: readonly PoolUpgrade[];
}

/** Orders we have already reconciled. Durable, so a restart does not re-audit — nor re-advance — a closed order. */
export interface ReconciledStore {
  has(orderId: string): boolean;
  mark(orderId: string): void;
}

export interface ReconcileDeps {
  /** The durable roll of money-good payouts (the evidence log). */
  readonly evidence: { rows(): readonly EvidenceRow[] };
  readonly observations: ChainObservationStore;
  readonly reconciled: ReconciledStore;
  readonly liveness: { checkTxLiveness(txHash: string): Promise<TxLiveness> };
  readonly resolve: ResolveGroundTruth;
  /** deriveIds(orderId, destination, amountStroops).txIdHex — the identifier the contract indexes. */
  readonly deriveTxIdHex: (row: EvidenceRow) => string;
  readonly operatorPublic: string;
  readonly passphrase: string;
  /** Feed {reconciled} to the state machine. Absent for an order this process never saw — the audit still runs. */
  readonly advance?: (orderId: string) => Promise<void>;
  /** How long a witnessed payout may go unobserved before that silence becomes an alarm. */
  readonly unsettledGraceSecs: number;
  readonly nowUnix: () => number;
}

function snapshotOf(obs: SettlementObservation): ChainSnapshot {
  return {
    function: 'pay',
    contract_id: obs.contractId,
    source_account: obs.sourceAccount,
    tx_id_hex: obs.txIdHex,
    amount_stroops: obs.amountStroops.toString(),
    applied_rate_stroops: obs.appliedRateStroops.toString(),
    merchant: obs.merchant,
    memo_hex: obs.memoHex,
  };
}

function intentOf(row: EvidenceRow): BusinessIntent {
  return {
    order_id: row.orderId,
    destination: row.order.destination,
    amount_stroops: row.order.amountStroops.toString(),
    memo_hex: row.order.memoHex,
  };
}

/**
 * Audit every unreconciled payout against the chain, once per tick.
 *
 * Advancing an order to `Reconciled` requires all of: the pool's code was never replaced; the settlement was found
 * under the order's own on-chain identifier; the amount it announced equals the amount the token contract actually
 * moved; the transaction is still on chain, successful; and the offline reconciler — given our local row, our
 * signed transaction, and that chain snapshot — says MATCHED. Anything less is reported and left alone.
 */
export async function reconcileOrders(deps: ReconcileDeps): Promise<ReconcileReport> {
  const upgrades = deps.observations.upgrades();
  const reconciled: string[] = [];
  const problems: OrderAudit[] = [];
  let audited = 0;
  let waiting = 0;
  let unreachable = 0;

  for (const row of deps.evidence.rows()) {
    if (deps.reconciled.has(row.orderId)) continue;
    audited += 1;

    const obs = deps.observations.settlementByTxId(deps.deriveTxIdHex(row));
    if (obs === undefined) {
      const ageSecs = deps.nowUnix() - row.record.witnessedAtUnix;
      // Absence only means something where we were looking. A payout witnessed before the tail began watching sits
      // in ledgers nobody read; accusing the pool of announcing nothing there would be accusing it of our own gap.
      const coverage = deps.observations.coverageStartUnix();
      if (coverage !== null && row.record.witnessedAtUnix < coverage) {
        problems.push({ kind: 'blind', orderId: row.orderId, reason: 'never-watched', ageSecs });
      } else if (ageSecs >= deps.unsettledGraceSecs) {
        // Inside our coverage, long past the grace, and still no announcement. Somebody has to answer for that.
        problems.push({ kind: 'unobservable', orderId: row.orderId, ageSecs });
      } else {
        waiting += 1;
      }
      continue;
    }

    if (upgrades.length > 0) {
      problems.push({
        kind: 'diverged',
        orderId: row.orderId,
        verdict: 'CHAIN_DIVERGENCE',
        detail: `the pool's code was replaced at ledger ${upgrades[0]?.ledger ?? 0}; its settlement announcements are no longer verifiable`,
        fieldDiff: [],
      });
      continue;
    }

    // The pool ANNOUNCES an amount. The token contract RECORDS what moved. Upgraded or buggy code could transfer
    // one number to one merchant and announce another; only the token's own event settles that argument.
    const moved = deps.observations.outflowStroopsByTx(obs.txHash);
    if (moved !== obs.amountStroops) {
      problems.push({
        kind: 'diverged',
        orderId: row.orderId,
        verdict: 'CHAIN_DIVERGENCE',
        detail: `the pool announced ${obs.amountStroops} stroops but the token contract moved ${moved}`,
        fieldDiff: [],
      });
      continue;
    }

    // A durable local observation outlives the chain it describes. Ask the chain again before believing it.
    const live = await deps.liveness.checkTxLiveness(obs.txHash);
    if (live.kind === 'UNKNOWN') {
      unreachable += 1;
      problems.push({ kind: 'unreachable', orderId: row.orderId, reason: live.reason });
      continue;
    }
    const chain: ChainEvidence | null =
      live.kind === 'SUCCESS'
        ? { tx_hash: obs.txHash, fetched_at_ledger: obs.ledger, horizon_snapshot: snapshotOf(obs) }
        : null; // the chain no longer contains it: a reset, or it never landed. UNSETTLED, never MATCHED.

    const gt = deps.resolve(
      intentOf(row),
      { signed_xdr: row.record.signedXdr, hash: row.record.txHash },
      chain,
      deps.operatorPublic,
      deps.passphrase,
    );

    if (gt.verdict === 'MATCHED') {
      deps.reconciled.mark(row.orderId); // durable, and BEFORE the state machine, so a crash cannot re-advance
      await deps.advance?.(row.orderId);
      reconciled.push(row.orderId);
      continue;
    }
    if (gt.verdict === 'UNSETTLED') {
      // We HOLD the pool's announcement for this order — it is in our observations, which is how we got here. The
      // chain simply will not hand the transaction back any more (retention, or a reset, or it never landed; the
      // RPC's NOT_FOUND cannot tell those apart). So this is a limit of what we can re-confirm, not a claim that
      // the settlement did not happen. Saying "the pool announced nothing" here would contradict our own log.
      problems.push({
        kind: 'blind',
        orderId: row.orderId,
        reason: 'aged-out',
        ageSecs: deps.nowUnix() - row.record.witnessedAtUnix,
      });
      continue;
    }
    problems.push({
      kind: 'diverged',
      orderId: row.orderId,
      verdict: gt.verdict,
      // A divergence in a non-business field (source account, tx_id, applied rate, contract) leaves field_diff
      // empty, so say which class of thing disagreed rather than paging with a blank explanation.
      detail:
        gt.field_diff.length > 0
          ? `the local row disagrees with the chain`
          : `the settlement on chain is not the one we signed (signature_valid=${gt.signature_valid}, hash_consistent=${gt.hash_consistent}, chain_bound=${gt.chain_bound})`,
      fieldDiff: gt.field_diff,
    });
  }

  return { audited, reconciled, problems, waiting, unreachable, upgrades };
}

// An audit re-derives its verdict from scratch on every tick, so a stuck order restates its problem forever. Paging
// forever is the same as paging never: the operator stops reading. Latch each order's problem and page it once —
// but key the latch on WHAT is wrong, not merely on which order, so a problem that changes character (silence that
// becomes a divergence) pages again. `unreachable` is deliberately not an alarm; it holds an existing latch open
// rather than clearing it, so a chain we cannot reach can neither raise a page nor forge an all-clear.

export interface ReconcileAlarmState {
  /** orderId → the identity of the problem last paged for it. */
  readonly alarmed: ReadonlyMap<string, string>;
}

export const INITIAL_RECONCILE_ALARMS: ReconcileAlarmState = { alarmed: new Map() };

/** What makes two problems "the same problem". `null` for anything that must never page. */
export function alarmKey(p: OrderAudit): string | null {
  if (p.kind === 'diverged') return `diverged:${p.verdict}`;
  if (p.kind === 'unobservable') return 'unobservable';
  if (p.kind === 'blind') return `blind:${p.reason}`;
  return null; // reconciled · waiting · unreachable
}

export interface ReconcileObservation {
  readonly state: ReconcileAlarmState;
  /** Page exactly these. Empty on a tick that restates only what was already paged. */
  readonly fresh: readonly OrderAudit[];
  /** Orders whose problem is gone. Worth one line each: an alarm that never clears is not an alarm. */
  readonly resolved: readonly string[];
}

export function observeReconcile(
  prev: ReconcileAlarmState,
  report: ReconcileReport,
): ReconcileObservation {
  const current = new Map<string, string>();
  const fresh: OrderAudit[] = [];
  const unreachable = new Set<string>();

  for (const p of report.problems) {
    if (p.kind === 'unreachable') {
      unreachable.add(p.orderId);
      continue;
    }
    const key = alarmKey(p);
    if (key === null) continue;
    current.set(p.orderId, key);
    if (prev.alarmed.get(p.orderId) !== key) fresh.push(p);
  }

  // Hold the latch open for an order we merely could not look at this tick, so it does not "resolve" and re-page.
  const alarmed = new Map(current);
  for (const [orderId, key] of prev.alarmed) {
    if (!alarmed.has(orderId) && unreachable.has(orderId)) alarmed.set(orderId, key);
  }

  const resolved: string[] = [];
  for (const orderId of prev.alarmed.keys()) if (!alarmed.has(orderId)) resolved.push(orderId);

  return { state: { alarmed }, fresh, resolved };
}
