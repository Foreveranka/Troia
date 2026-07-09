import { describe, expect, it, vi } from 'vitest';
import { reconcileOrders } from '../../src/settlement/reconcile-worker.js';
import type {
  ChainEvidence,
  GroundTruth,
  ReconcileDeps,
  ReconciledStore,
  Verdict,
} from '../../src/settlement/reconcile-worker.js';
import type { ChainObservationStore } from '../../src/settlement/outflow-worker.js';
import type { EvidenceRow } from '../../src/ports.js';
import type { PoolUpgrade, SettlementObservation, TxLiveness } from '@troia/stellar-client';

// `Reconciled` is terminal, and it means "the chain agrees". These tests are about the ways it must NOT be reached.
//
// The audit's independence rests on one thing: an order finds its settlement by `tx_id`, the identifier the
// CONTRACT indexes, not by the transaction hash we recorded. Asking our own records to confirm our own records is
// what made the old offline demo's divergence branch a tautology. Here, whatever transaction announced the
// settlement under our order's identifier is the transaction that settled it — and if that is not the one we
// signed, the system finally has a way to notice.

const TX_ID = '1f'.repeat(32);
const OUR_HASH = 'aa'.repeat(32);
const THEIR_HASH = 'bb'.repeat(32);
const POOL = 'CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ';
const OPERATOR = 'GDMAG4EMNWL6T4IJ6PXGBTBJEWAKFJ2YRKRFRIF7ZM7MG6YFZZU35E4S';
const MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
const AMOUNT = 740_000_000n;
const NOW = 1_800_000_000;

function row(over: Partial<EvidenceRow['record']> = {}): EvidenceRow {
  return {
    orderId: 'ord-1',
    record: {
      txHash: OUR_HASH,
      signedXdr: 'AAAAAg==',
      seq: '1001',
      witnessedAtUnix: NOW - 10,
      ...over,
    },
    order: {
      destination: MERCHANT,
      amountStroops: AMOUNT,
      memoHex: 'cd'.repeat(32),
      appliedRateStroops: 480_693_264n,
      paidPriceTry: '3400.00',
      spreadKurus: 5_000n,
      feeKurus: 2_000n,
    },
  };
}

function observation(over: Partial<SettlementObservation> = {}): SettlementObservation {
  return {
    txIdHex: TX_ID,
    txHash: OUR_HASH,
    ledger: 3_489_950,
    ledgerCloseUnix: NOW - 5,
    contractId: POOL,
    sourceAccount: OPERATOR,
    merchant: MERCHANT,
    amountStroops: AMOUNT,
    appliedRateStroops: 480_693_264n,
    memoHex: 'cd'.repeat(32),
    ...over,
  };
}

function observations(over: Partial<ChainObservationStore> = {}): ChainObservationStore {
  return {
    recordOutflow: () => {},
    recordSettlement: () => {},
    recordUpgrade: () => {},
    settlementByTxId: () => observation(),
    outflowStroopsByTx: () => AMOUNT, // the token contract moved exactly what the pool announced
    upgrades: (): readonly PoolUpgrade[] => [],
    ...over,
  };
}

class FakeReconciled implements ReconciledStore {
  private readonly closed = new Set<string>();
  has(id: string): boolean {
    return this.closed.has(id);
  }
  mark(id: string): void {
    this.closed.add(id);
  }
}

/** A stand-in for @troia/reconciler's resolveGroundTruth, honest about the one thing that matters here: it
 *  compares OUR recorded hash to the hash the chain says settled the order. */
function realisticResolve(verdict?: Verdict) {
  return (_intent: unknown, ledger: { hash: string }, chain: ChainEvidence | null): GroundTruth => {
    if (chain === null) {
      return {
        verdict: 'UNSETTLED',
        signature_valid: true,
        hash_consistent: true,
        chain_bound: false,
        field_diff: [],
      };
    }
    const bound = ledger.hash === chain.tx_hash;
    return {
      verdict: verdict ?? (bound ? 'MATCHED' : 'CHAIN_DIVERGENCE'),
      signature_valid: true,
      hash_consistent: true,
      chain_bound: bound,
      field_diff: [],
    };
  };
}

function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    evidence: { rows: () => [row()] },
    observations: observations(),
    reconciled: new FakeReconciled(),
    liveness: {
      checkTxLiveness: async (): Promise<TxLiveness> => ({ kind: 'SUCCESS', ledger: 3_489_950 }),
    },
    resolve: realisticResolve(),
    deriveTxIdHex: () => TX_ID,
    operatorPublic: OPERATOR,
    passphrase: 'Test SDF Network ; September 2015',
    unsettledGraceSecs: 600,
    nowUnix: () => NOW,
    ...over,
  };
}

describe('reconcileOrders — the chain agrees, or the order does not move', () => {
  it('reconciles an order the chain confirms, and advances it exactly once', async () => {
    const advance = vi.fn(async () => {});
    const reconciled = new FakeReconciled();
    const r = await reconcileOrders(deps({ advance, reconciled }));

    expect(r.reconciled).toEqual(['ord-1']);
    expect(r.problems).toEqual([]);
    expect(advance).toHaveBeenCalledTimes(1);

    // a second tick sees it closed on disk and does nothing
    const again = await reconcileOrders(deps({ advance, reconciled }));
    expect(again.audited).toBe(0);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('CHAIN_DIVERGENCE is genuinely reachable: a DIFFERENT transaction settled our order', async () => {
    const advance = vi.fn(async () => {});
    // the pool announced our tx_id — but from a transaction we never signed
    const r = await reconcileOrders(
      deps({
        advance,
        observations: observations({
          settlementByTxId: () => observation({ txHash: THEIR_HASH }),
        }),
      }),
    );
    expect(r.reconciled).toEqual([]);
    expect(r.problems[0]).toMatchObject({ kind: 'diverged', verdict: 'CHAIN_DIVERGENCE' });
    expect(advance).not.toHaveBeenCalled();
  });

  it('never reconciles once the pool code was replaced — its announcements stop being proofs', async () => {
    const advance = vi.fn(async () => {});
    const r = await reconcileOrders(
      deps({
        advance,
        observations: observations({
          upgrades: () => [{ txHash: 'up', ledger: 4_000_000, ledgerCloseUnix: NOW }],
        }),
      }),
    );
    expect(r.reconciled).toEqual([]);
    expect(r.upgrades).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ kind: 'diverged' });
    expect(advance).not.toHaveBeenCalled();
  });

  it('never reconciles when the pool announced one amount and the token moved another', async () => {
    const r = await reconcileOrders(
      deps({ observations: observations({ outflowStroopsByTx: () => AMOUNT - 1n }) }),
    );
    expect(r.reconciled).toEqual([]);
    expect(r.problems[0]).toMatchObject({ kind: 'diverged', verdict: 'CHAIN_DIVERGENCE' });
    expect((r.problems[0] as { detail: string }).detail).toContain('the token contract moved');
  });

  it('never reconciles a settlement the chain no longer has — a stale local cache is not the chain', async () => {
    const advance = vi.fn(async () => {});
    const r = await reconcileOrders(
      deps({
        advance,
        liveness: { checkTxLiveness: async (): Promise<TxLiveness> => ({ kind: 'ABSENT' }) },
      }),
    );
    expect(r.reconciled).toEqual([]);
    expect(r.problems[0]).toMatchObject({ kind: 'unobservable' });
    expect(advance).not.toHaveBeenCalled();
  });

  it('an RPC it cannot reach is not a chain that says no — it retries, it never concludes', async () => {
    const advance = vi.fn(async () => {});
    const r = await reconcileOrders(
      deps({
        advance,
        liveness: {
          checkTxLiveness: async (): Promise<TxLiveness> => ({
            kind: 'UNKNOWN',
            reason: 'ETIMEDOUT',
          }),
        },
      }),
    );
    expect(r.reconciled).toEqual([]);
    expect(r.unreachable).toBe(1);
    expect(r.problems[0]).toMatchObject({ kind: 'unreachable', reason: 'ETIMEDOUT' });
    expect(advance).not.toHaveBeenCalled();
  });

  it('waits quietly while the settlement has simply not been announced yet', async () => {
    const r = await reconcileOrders(
      deps({ observations: observations({ settlementByTxId: () => undefined }) }),
    );
    expect(r.waiting).toBe(1);
    expect(r.problems).toEqual([]);
  });

  it('alarms once a witnessed payout has gone unobserved for too long', async () => {
    const r = await reconcileOrders(
      deps({
        evidence: { rows: () => [row({ witnessedAtUnix: NOW - 3600 })] },
        observations: observations({ settlementByTxId: () => undefined }),
      }),
    );
    expect(r.waiting).toBe(0);
    expect(r.problems[0]).toMatchObject({ kind: 'unobservable', ageSecs: 3600 });
  });

  it('audits a pre-crash order it can no longer advance — the audit is the point, not the transition', async () => {
    const reconciled = new FakeReconciled();
    const r = await reconcileOrders(deps({ reconciled })); // no `advance` at all
    expect(r.reconciled).toEqual(['ord-1']);
    expect(reconciled.has('ord-1')).toBe(true);
  });

  it('marks the order closed on disk BEFORE advancing it, so a crash cannot advance it twice', async () => {
    const reconciled = new FakeReconciled();
    const seen: boolean[] = [];
    await reconcileOrders(
      deps({
        reconciled,
        advance: async (id) => void seen.push(reconciled.has(id)),
      }),
    );
    expect(seen).toEqual([true]); // already durable when the state machine was touched
  });

  it('a divergence in a non-business field explains itself instead of paging with a blank diff', async () => {
    const r = await reconcileOrders(deps({ resolve: realisticResolve('CORRUPT_LOCAL') }));
    expect(r.problems[0]).toMatchObject({ kind: 'diverged', verdict: 'CORRUPT_LOCAL' });
    expect((r.problems[0] as { detail: string }).detail).toContain('signature_valid');
  });
});
