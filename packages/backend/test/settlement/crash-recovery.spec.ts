import { describe, expect, it } from 'vitest';
import { Ledger } from '@troia/ledger';
import { KeyedMutex } from '../../src/store/mutex.js';
import { InMemoryPendingSettlementStore } from '../../src/settlement/pending-settlement-store.js';
import { TryDrivenRebalancePolicy } from '../../src/settlement/rebalance-policy.js';
import { settleAndRebalance } from '../../src/settlement/settlement-worker.js';
import type { SettlementDeps, TopUpExecution } from '../../src/settlement/settlement-worker.js';
import type { TopUpRequest } from '../../src/settlement/rebalance-policy.js';
import { checkDrift } from '../../src/settlement/drift-worker.js';
import { FakeClock, ORDER_FACTS } from '../fakes/harness.js';
import type { OrderFacts } from '../../src/ports.js';

// The defect this closes, in one sentence: the settlement worker used to find its work in memory, so a crash
// between a payout confirming and the worker's next tick lost that order forever.
//
// Two things were silently lost with it. The order's outflow was never booked, so the double-entry ledger stayed
// permanently above the chain — and the solvency alarm, which weighs the two, rang about a discrepancy nobody
// could ever close. An alarm that cannot be cleared is an alarm people learn to ignore. And the order's pool
// refill never happened either, which nobody noticed at all.
//
// The evidence log already knew about the payout: it is written the instant the pay() is witnessed. Making it
// carry the order's frozen facts turns it into the work-list, and a restart rediscovers everything.
//
// The new hazard that opens: a rediscovered order would be re-armed and re-minted, and the mint's idempotency
// cache lives in memory. So before minting, the worker asks the DURABLE journal whether a previous life already
// refilled this order.

const STROOP = 10_000_000n;
const DEMO_VALOR = 30;
const RATE = 340_000_000n;
const POOL_SEED = 1000n * STROOP;
const PAID_OUT = ORDER_FACTS.amountStroops; // 100 USDC

/** The durable roll of money-good payouts. It survives a restart, because the evidence log does. */
class DurableConfirmed {
  private readonly rows = new Map<string, { orderId: string; order: OrderFacts }>();
  add(orderId: string): void {
    this.rows.set(orderId, { orderId, order: ORDER_FACTS });
  }
  all(): readonly { orderId: string; order: OrderFacts }[] {
    return [...this.rows.values()];
  }
  get(orderId: string): { orderId: string; order: OrderFacts } | undefined {
    return this.rows.get(orderId);
  }
}

class Mint {
  readonly refs: string[] = [];
  async topUp(req: TopUpRequest): Promise<TopUpExecution> {
    this.refs.push(req.ref); // a REAL on-chain mint; no cross-process memory of it
    return { usdcStroops: req.usdcStroops, txHash: `tx_${req.ref}` };
  }
}

class CreditSpy {
  readonly credits: bigint[] = [];
  async creditPool(stroops: bigint): Promise<void> {
    this.credits.push(stroops);
  }
}

/** One process lifetime. The ledger and the confirmed roll are durable and outlive it; everything else does not. */
function life(
  ledger: Ledger,
  confirmed: DurableConfirmed,
  mint: Mint,
  clockNow: number,
): SettlementDeps & { store: CreditSpy; clock: FakeClock } {
  return {
    confirmed,
    orderLocks: new KeyedMutex(),
    clock: new FakeClock(clockNow),
    pending: new InMemoryPendingSettlementStore(), // in-memory: dies with the process
    policy: new TryDrivenRebalancePolicy(),
    rebalance: mint,
    store: new CreditSpy(),
    ledger,
    rate: {
      async liveRateStroops(): Promise<bigint> {
        return RATE;
      },
    },
    demoValorSecs: DEMO_VALOR,
  };
}

function seeded(): Ledger {
  const l = new Ledger();
  l.recordTopUp({ ref: 'genesis', usdcStroops: POOL_SEED, valueKurus: 3_400_000n });
  return l;
}

describe('a crash between confirmation and the next tick no longer strands an order', () => {
  it('a restart books the outflow that was never booked, and the drift alarm falls silent', async () => {
    const ledger = seeded();
    const confirmed = new DurableConfirmed();
    const mint = new Mint();

    // --- life 1: the payout confirms, its evidence row lands... and the process dies before the tick runs ---
    confirmed.add('o1');

    // the chain already holds less: the USDC left when pay() closed its ledger
    const onChain = POOL_SEED - PAID_OUT;
    expect(ledger.detectDrift(onChain).inSync).toBe(false); // the books have not caught up yet
    expect(ledger.detectDrift(onChain).driftStroops).toBe(-PAID_OUT);

    // --- life 2: a restart. Nothing is in memory. The evidence log remembers. ---
    const r = life(ledger, confirmed, mint, 1_000);
    const report = await settleAndRebalance(r);

    expect(report.booked).toBe(1); // rediscovered from disk and booked
    expect(report.armed).toBe(1); // and armed, so its refill is not lost either
    const drift = await checkDrift({
      stellar: {
        async readPoolBalanceStroops(): Promise<bigint> {
          return onChain;
        },
      },
      ledger,
    });
    expect(drift.inSync).toBe(true); // the alarm falls silent, because the books caught up
  });

  it('the pool refill that a crash used to lose now happens', async () => {
    const ledger = seeded();
    const confirmed = new DurableConfirmed();
    const mint = new Mint();
    confirmed.add('o1');

    const r = life(ledger, confirmed, mint, 1_000);
    await settleAndRebalance(r); // arm
    r.clock.now += DEMO_VALOR + 1;
    const settled = await settleAndRebalance(r);

    expect(settled.settled).toBe(1);
    expect(mint.refs).toEqual(['topup:o1']);
    expect(r.store.credits).toHaveLength(1);
  });

  it('a restart after the refill does NOT mint a second time — the durable journal remembers', async () => {
    const ledger = seeded();
    const confirmed = new DurableConfirmed();
    const mint = new Mint();
    confirmed.add('o1');

    // life 1: arm, wait out the valör, refill
    const one = life(ledger, confirmed, mint, 1_000);
    await settleAndRebalance(one);
    one.clock.now += DEMO_VALOR + 1;
    await settleAndRebalance(one);
    expect(mint.refs).toEqual(['topup:o1']);

    // --- crash. `pending` is gone; the order is rediscovered from the evidence log and re-armed. ---
    const two = life(ledger, confirmed, mint, one.clock.now + 10_000);
    await settleAndRebalance(two); // re-armed from disk; a fresh valör starts
    two.clock.now += DEMO_VALOR + 1;
    const second = await settleAndRebalance(two);

    expect(mint.refs).toEqual(['topup:o1']); // NOT minted twice on chain
    expect(two.store.credits).toEqual([]); // and not credited twice: the boot read the chain, which has it
    expect(second.skipped).toBeGreaterThan(0);
    expect(two.pending.get('o1')?.status).toBe('settled');
  });

  it('the pre-mint guard is what stops the double mint — without it the chain is minted twice', async () => {
    const ledger = seeded();
    const confirmed = new DurableConfirmed();
    const mint = new Mint();
    confirmed.add('o1');

    const one = life(ledger, confirmed, mint, 1_000);
    await settleAndRebalance(one);
    one.clock.now += DEMO_VALOR + 1;
    await settleAndRebalance(one);

    // a ledger that has forgotten (i.e. a NON-durable journal) is exactly the disaster case
    const forgetful = seeded();
    const two = life(forgetful, confirmed, mint, one.clock.now + 10_000);
    await settleAndRebalance(two);
    two.clock.now += DEMO_VALOR + 1;
    await settleAndRebalance(two);
    expect(mint.refs).toEqual(['topup:o1', 'topup:o1']); // minted again — real USDC, twice
  });
});
