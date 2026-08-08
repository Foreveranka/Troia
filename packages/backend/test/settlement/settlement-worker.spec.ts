import { describe, expect, it } from 'vitest';
import { settleAndRebalance } from '../../src/settlement/settlement-worker.js';
import type { SettlementDeps } from '../../src/settlement/settlement-worker.js';
import { InMemoryPendingSettlementStore } from '../../src/settlement/pending-settlement-store.js';
import { TryDrivenRebalancePolicy } from '../../src/settlement/rebalance-policy.js';
import type { TopUpRequest } from '../../src/settlement/rebalance-policy.js';
import { KeyedMutex } from '../../src/store/mutex.js';
import type { State } from '@troia/core';
import type { OrderFacts } from '../../src/ports.js';
import { FakeClock, ORDER_FACTS } from '../fakes/harness.js';

const DEMO_VALOR = 45;
const RATE = 340_000_000n; // 34.0 TRY/USDC
// default ctx: paidPriceTry '3400.00' (=340_000 kuruş), amountStroops 1e9 (100 USDC).
// At rate 34.0 the Model-B mint = 340_000 * 1e12 / 340_000_000 = 1_000_000_000 stroops (100 USDC).
const EXPECTED_MINT = 1_000_000_000n;

class FakeRebalance {
  readonly calls: TopUpRequest[] = [];
  private readonly minted = new Map<string, bigint>();
  throwOnce = false;
  async topUp(
    req: TopUpRequest,
  ): Promise<{ usdcStroops: bigint; txHash: string; poolStroops: bigint }> {
    this.calls.push(req);
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error('mint failed');
    }
    // idempotent per ref: a repeat returns the cached mint, never a second one
    const cached = this.minted.get(req.ref);
    const usdcStroops = cached ?? req.usdcStroops;
    if (cached === undefined) this.minted.set(req.ref, usdcStroops);
    return { usdcStroops, txHash: `tx_${req.ref}`, poolStroops: 0n };
  }
  get mintCount(): number {
    return this.minted.size;
  }
}

class FakeRate {
  rate = RATE;
  fail = false;
  async liveRateStroops(): Promise<bigint> {
    if (this.fail) throw new Error('oracle down');
    return this.rate;
  }
}

class FakeCreditStore {
  readonly credits: bigint[] = [];
  async creditPool(stroops: bigint): Promise<void> {
    this.credits.push(stroops);
  }
}

function duplicateRef(): Error & { code: string } {
  const e = new Error('dup') as Error & { code: string };
  e.code = 'DuplicateRef';
  return e;
}

/** The durable roll of money-good payouts, as the evidence log would hand it over after a restart. */
class FakeConfirmed {
  private readonly rows = new Map<string, { orderId: string; order: OrderFacts }>();
  add(orderId: string, over: Partial<OrderFacts> = {}): void {
    this.rows.set(orderId, { orderId, order: { ...ORDER_FACTS, ...over } });
  }
  drop(orderId: string): void {
    this.rows.delete(orderId);
  }
  all(): readonly { orderId: string; order: OrderFacts }[] {
    return [...this.rows.values()];
  }
  get(orderId: string): { orderId: string; order: OrderFacts } | undefined {
    return this.rows.get(orderId);
  }
}

class FakeBook {
  readonly booked: { ref: string; usdcStroops: bigint; valueKurus: bigint }[] = [];
  readonly settlements: { orderId: string; usdcStroops: bigint; userTryKurus: bigint }[] = [];
  hasRef(ref: string): boolean {
    return (
      this.booked.some((b) => b.ref === ref) || this.settlements.some((s) => s.orderId === ref)
    );
  }
  recordTopUp(input: { ref: string; usdcStroops: bigint; valueKurus: bigint }): void {
    if (this.booked.some((b) => b.ref === input.ref)) throw duplicateRef();
    this.booked.push(input);
  }
  recordSettlement(input: {
    orderId: string;
    usdcStroops: bigint;
    userTryKurus: bigint;
    spreadKurus: bigint;
    feeKurus?: bigint;
  }): void {
    if (this.settlements.some((s) => s.orderId === input.orderId)) throw duplicateRef();
    this.settlements.push(input);
  }
  /** expected pool = Σ top-ups − Σ settlements, exactly as the real ledger's nativeBalance('USDC_POOL'). */
  detectDrift(observedPoolStroops: bigint): {
    expectedPoolStroops: bigint;
    observedPoolStroops: bigint;
    driftStroops: bigint;
    inSync: boolean;
  } {
    const expected =
      this.booked.reduce((s, b) => s + b.usdcStroops, 0n) -
      this.settlements.reduce((s, x) => s + x.usdcStroops, 0n);
    return {
      expectedPoolStroops: expected,
      observedPoolStroops,
      driftStroops: observedPoolStroops - expected,
      inSync: observedPoolStroops === expected,
    };
  }
}

interface Rig extends SettlementDeps {
  confirmed: FakeConfirmed;
  clock: FakeClock;
  pending: InMemoryPendingSettlementStore;
  rebalance: FakeRebalance;
  rate: FakeRate;
  store: FakeCreditStore;
  ledger: FakeBook;
}

function rig(): Rig {
  const confirmed = new FakeConfirmed();
  const clock = new FakeClock(1_000);
  const pending = new InMemoryPendingSettlementStore();
  const rebalance = new FakeRebalance();
  const rate = new FakeRate();
  const store = new FakeCreditStore();
  const ledger = new FakeBook();
  return {
    confirmed,
    orderLocks: new KeyedMutex(),
    clock,
    pending,
    policy: new TryDrivenRebalancePolicy(),
    rebalance,
    rate,
    store,
    ledger,
    demoValorSecs: DEMO_VALOR,
  };
}

/** A money-good payout has a durable evidence row; a money-bad one never gets one, so it is simply absent. */
function putOrder(r: Rig, orderId: string, state: State): void {
  if (state === 'UsdcConfirmed' || state === 'Reconciled') r.confirmed.add(orderId);
}

describe('settleAndRebalance — the TRY-driven settlement-sim worker', () => {
  it('(a) arms a UsdcConfirmed order at now+valör, mints NOTHING yet; ignores a money-bad order', async () => {
    const r = rig();
    putOrder(r, 'good', 'UsdcConfirmed');
    putOrder(r, 'reverted', 'ChargeReversed');

    const rep = await settleAndRebalance(r);

    expect(r.pending.get('good')?.status).toBe('pending');
    expect(r.pending.get('good')?.settlesAtUnix).toBe(1_045); // 1000 + 45
    expect(r.pending.get('good')?.tryKurus).toBe(340_000n); // parsed from '3400.00'
    expect(r.pending.get('reverted')).toBeUndefined(); // a money-bad order is never armed
    expect(r.rebalance.calls).toHaveLength(0); // arming alone mints nothing
    expect(r.store.credits).toEqual([]);
    expect(rep.armed).toBe(1);
  });

  it('(b) does not settle before the valör mark passes', async () => {
    const r = rig();
    putOrder(r, 'good', 'UsdcConfirmed');
    await settleAndRebalance(r); // arm at 1000 -> settlesAt 1045
    r.clock.now = 1_044; // one second early
    await settleAndRebalance(r);
    expect(r.rebalance.calls).toHaveLength(0);
    expect(r.store.credits).toEqual([]);
    expect(r.pending.get('good')?.status).toBe('pending');
  });

  it('(c) settles exactly once after the mark: one mint at the policy amount, booked, credited, marked settled', async () => {
    const r = rig();
    putOrder(r, 'good', 'UsdcConfirmed');
    await settleAndRebalance(r); // arm
    r.clock.now = 1_045; // valör reached
    const rep = await settleAndRebalance(r);

    expect(r.rebalance.calls).toHaveLength(1);
    expect(r.rebalance.calls[0]!.ref).toBe('topup:good');
    expect(r.rebalance.calls[0]!.usdcStroops).toBe(EXPECTED_MINT);
    expect(r.store.credits).toEqual([EXPECTED_MINT]); // the /intent gate is raised by the minted amount
    expect(r.ledger.booked).toHaveLength(1);
    expect(r.ledger.booked[0]).toMatchObject({
      ref: 'topup:good',
      usdcStroops: EXPECTED_MINT,
      valueKurus: 340_000n,
    });
    expect(r.pending.get('good')?.status).toBe('settled');
    expect(rep.settled).toBe(1);
  });

  it('(d) a re-tick after settlement mints nothing and credits nothing (exactly-once)', async () => {
    const r = rig();
    putOrder(r, 'good', 'UsdcConfirmed');
    await settleAndRebalance(r);
    r.clock.now = 1_045;
    await settleAndRebalance(r); // settles
    await settleAndRebalance(r); // re-tick — must be a no-op

    expect(r.rebalance.mintCount).toBe(1);
    expect(r.store.credits).toEqual([EXPECTED_MINT]);
    expect(r.ledger.booked).toHaveLength(1);
  });

  it('(e) two concurrent ticks on one due record settle it exactly once (claim CAS + per-order lock)', async () => {
    const r = rig();
    putOrder(r, 'good', 'UsdcConfirmed');
    await settleAndRebalance(r); // arm
    r.clock.now = 1_045;
    await Promise.all([settleAndRebalance(r), settleAndRebalance(r)]);

    expect(r.rebalance.mintCount).toBe(1);
    expect(r.store.credits).toEqual([EXPECTED_MINT]);
    expect(r.pending.get('good')?.status).toBe('settled');
  });

  it('(f) an order proven money-bad after arming is VOIDED at settle — never minted', async () => {
    const r = rig();
    putOrder(r, 'good', 'UsdcConfirmed');
    await settleAndRebalance(r); // arm while money-good
    // its durable evidence vanishes (a defensive fence; an evidence row is append-only and never removed)
    r.confirmed.drop('good');
    r.clock.now = 1_045;
    const rep = await settleAndRebalance(r);

    expect(r.rebalance.calls).toHaveLength(0);
    expect(r.store.credits).toEqual([]);
    expect(r.pending.get('good')?.status).toBe('voided');
    expect(rep.voided).toBe(1);
  });

  it('(g) fail-closed when the live rate is unavailable: no mint, record stays pending, then settles on recovery', async () => {
    const r = rig();
    putOrder(r, 'good', 'UsdcConfirmed');
    await settleAndRebalance(r);
    r.clock.now = 1_045;
    r.rate.fail = true;
    await settleAndRebalance(r); // oracle down -> skip, nothing minted
    expect(r.rebalance.calls).toHaveLength(0);
    expect(r.store.credits).toEqual([]);
    expect(r.pending.get('good')?.status).toBe('pending'); // retryable

    r.rate.fail = false;
    await settleAndRebalance(r); // oracle back -> settles once
    expect(r.rebalance.mintCount).toBe(1);
    expect(r.store.credits).toEqual([EXPECTED_MINT]);
  });

  it('(h) mint-and-book-or-neither: a thrown mint credits nothing and books nothing; the next tick mints once', async () => {
    const r = rig();
    putOrder(r, 'good', 'UsdcConfirmed');
    await settleAndRebalance(r);
    r.clock.now = 1_045;
    r.rebalance.throwOnce = true;
    await settleAndRebalance(r); // mint throws -> no credit, no book, record back to pending
    expect(r.store.credits).toEqual([]);
    expect(r.ledger.booked).toEqual([]);
    expect(r.pending.get('good')?.status).toBe('pending');

    await settleAndRebalance(r); // retry -> mints exactly once
    expect(r.rebalance.mintCount).toBe(1);
    expect(r.store.credits).toEqual([EXPECTED_MINT]);
    expect(r.ledger.booked).toHaveLength(1);
  });
});

// --- A-2: the mint write-ahead journal (KNOWN_ISSUES §2) ---
//
// The double-spend window is the gap between the mint landing and its booking. These tests pin the WAL
// discipline that closes it: intent BEFORE the mint, resolution AFTER the booking, and a hard refusal to
// mint any ref a previous life left unresolved.

class FakeMintIntents {
  readonly openRefs = new Set<string>();
  /** refs "left open by a previous life" — what a restart would find on disk. */
  readonly blocked = new Set<string>();
  constructor(private readonly events: string[]) {}
  isBlocked(ref: string): boolean {
    return this.blocked.has(ref);
  }
  open(ref: string): void {
    this.events.push(`open:${ref}`);
    this.openRefs.add(ref);
  }
  close(ref: string): void {
    this.events.push(`close:${ref}`);
    this.openRefs.delete(ref);
    this.blocked.delete(ref); // resolution: the durable ledger answered the question
  }
}

/** rig() + a journal + event-ordered spies on the mint and the booking. */
function walRig(): { r: Rig; deps: SettlementDeps; journal: FakeMintIntents; events: string[] } {
  const r = rig();
  const events: string[] = [];
  const journal = new FakeMintIntents(events);
  const deps: SettlementDeps = {
    ...r,
    mintIntents: journal,
    rebalance: {
      topUp: async (req: TopUpRequest) => {
        events.push(`mint:${req.ref}`);
        return r.rebalance.topUp(req);
      },
    },
    ledger: {
      hasRef: (ref: string) => r.ledger.hasRef(ref),
      recordSettlement: (input) => r.ledger.recordSettlement(input),
      recordTopUp: (input) => {
        events.push(`book:${input.ref}`);
        return r.ledger.recordTopUp(input);
      },
    },
  };
  return { r, deps, journal, events };
}

describe('settleAndRebalance — mint write-ahead journal (A-2)', () => {
  it('(wal-a) write-ahead ordering: intent on disk BEFORE the mint, resolved only AFTER the booking', async () => {
    const { r, deps, journal, events } = walRig();
    putOrder(r, 'good', 'UsdcConfirmed');
    await settleAndRebalance(deps); // arm
    r.clock.now = 1_045;
    const rep = await settleAndRebalance(deps);
    expect(events).toEqual([
      'open:topup:good',
      'mint:topup:good',
      'book:topup:good',
      'close:topup:good',
    ]);
    expect(journal.openRefs.size).toBe(0); // nothing left open after a clean settle
    expect(rep.settled).toBe(1);
    expect(rep.mintBlocked).toBe(0);
  });

  it("(wal-b) a previous life's unresolved intent BLOCKS the ref: no mint, surfaced, retriable", async () => {
    const { r, deps, journal } = walRig();
    putOrder(r, 'good', 'UsdcConfirmed');
    journal.blocked.add('topup:good'); // what a restart finds after a crash inside the mint window
    await settleAndRebalance(deps); // arm
    r.clock.now = 1_045;
    const rep = await settleAndRebalance(deps);
    expect(r.rebalance.calls).toHaveLength(0); // NOTHING minted — that is the whole point
    expect(r.store.credits).toEqual([]);
    expect(rep.mintBlocked).toBe(1);

    // a human resolves it ("the mint never landed — clear the intent"); the next tick mints normally
    journal.blocked.delete('topup:good');
    await settleAndRebalance(deps);
    expect(r.rebalance.mintCount).toBe(1);
    expect(r.store.credits).toEqual([EXPECTED_MINT]);
    expect(r.pending.get('good')?.status).toBe('settled');
  });

  it('(wal-c) a stale intent whose booking DID land is resolved, not blocked (crash after recordTopUp)', async () => {
    const { r, deps, journal, events } = walRig();
    putOrder(r, 'good', 'UsdcConfirmed');
    // the previous life booked the top-up, then died before closing the intent:
    r.ledger.recordTopUp({ ref: 'topup:good', usdcStroops: EXPECTED_MINT, valueKurus: 340_000n });
    journal.blocked.add('topup:good');
    await settleAndRebalance(deps); // arm
    r.clock.now = 1_045;
    const rep = await settleAndRebalance(deps);
    expect(events).toContain('close:topup:good'); // the answered question is tidied away
    expect(events.filter((e) => e.startsWith('mint:'))).toEqual([]); // and nothing minted twice
    expect(journal.blocked.size).toBe(0);
    expect(r.pending.get('good')?.status).toBe('settled');
    expect(rep.mintBlocked).toBe(0);
  });

  it('(wal-d) a clean SAME-life mint failure retries without tripping the block (idempotent re-open)', async () => {
    const { r, deps, journal, events } = walRig();
    putOrder(r, 'good', 'UsdcConfirmed');
    await settleAndRebalance(deps); // arm
    r.clock.now = 1_045;
    r.rebalance.throwOnce = true;
    let rep = await settleAndRebalance(deps); // mint throws; intent stays open in THIS life
    expect(rep.failed).toBe(1);
    expect(journal.openRefs.has('topup:good')).toBe(true);
    expect(journal.isBlocked('topup:good')).toBe(false); // same life -> not a block

    rep = await settleAndRebalance(deps); // retry succeeds
    expect(rep.settled).toBe(1);
    expect(r.rebalance.mintCount).toBe(1);
    expect(events.filter((e) => e.startsWith('open:'))).toHaveLength(2); // re-opened, harmlessly
    expect(journal.openRefs.size).toBe(0);
  });
});
