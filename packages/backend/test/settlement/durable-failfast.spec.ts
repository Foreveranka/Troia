import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../../src/store/mutex.js';
import { InMemoryPendingSettlementStore } from '../../src/settlement/pending-settlement-store.js';
import { TryDrivenRebalancePolicy } from '../../src/settlement/rebalance-policy.js';
import { settleAndRebalance } from '../../src/settlement/settlement-worker.js';
import type { SettlementDeps, TopUpExecution } from '../../src/settlement/settlement-worker.js';
import type { TopUpRequest } from '../../src/settlement/rebalance-policy.js';
import { FakeClock, ORDER_FACTS } from '../fakes/harness.js';
import type { OrderFacts } from '../../src/ports.js';

// The settle phase mints BEFORE it books. If the booking's durable journal is poisoned, swallowing the failure
// into markFailed would re-run the mint on every tick and never credit the pool — an unbounded loop of on-chain
// money movement recorded nowhere. A durable-log failure must escape the worker instead.

const DEMO_VALOR = 30;
const RATE = 340_000_000n;

/** The durable roll of money-good payouts, as the evidence log hands it over. */
class FakeConfirmed {
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

class PoisonedJournalError extends Error {
  readonly code = 'DurableLogFailure';
}

class CountingRebalance {
  calls = 0;
  async topUp(req: TopUpRequest): Promise<TopUpExecution> {
    this.calls += 1;
    return { usdcStroops: req.usdcStroops, txHash: `tx_${req.ref}` };
  }
}

class CreditSpy {
  readonly credits: bigint[] = [];
  async creditPool(stroops: bigint): Promise<void> {
    this.credits.push(stroops);
  }
}

function rig(book: SettlementDeps['ledger']): SettlementDeps & {
  confirmed: FakeConfirmed;
  clock: FakeClock;
  pending: InMemoryPendingSettlementStore;
  rebalance: CountingRebalance;
  store: CreditSpy;
} {
  const confirmed = new FakeConfirmed();
  const clock = new FakeClock(1_000);
  const pending = new InMemoryPendingSettlementStore();
  const rebalance = new CountingRebalance();
  const store = new CreditSpy();
  return {
    confirmed,
    orderLocks: new KeyedMutex(),
    clock,
    pending,
    policy: new TryDrivenRebalancePolicy(),
    rebalance,
    store,
    ledger: book,
    rate: {
      async liveRateStroops(): Promise<bigint> {
        return RATE;
      },
    },
    demoValorSecs: DEMO_VALOR,
  };
}

describe('settleAndRebalance — a poisoned journal is fail-stop, not retry', () => {
  it('escapes instead of minting again every tick while the pool is never credited', async () => {
    // The journal dies on the FIRST booking the worker attempts, which at arm time is the settlement outflow.
    const poisoned = {
      hasRef: () => false,
      recordSettlement(): never {
        throw new PoisonedJournalError('journal is poisoned');
      },
      recordTopUp(): never {
        throw new PoisonedJournalError('journal is poisoned');
      },
      detectDrift: () => ({
        expectedPoolStroops: 0n,
        observedPoolStroops: 0n,
        driftStroops: 0n,
        inSync: true,
      }),
    };
    const r = rig(poisoned);
    r.confirmed.add('o1');

    await expect(settleAndRebalance(r)).rejects.toThrow(PoisonedJournalError);
    expect(r.rebalance.calls).toBe(0); // it never got as far as minting
    expect(r.store.credits).toEqual([]);
  });

  it('an ordinary booking failure still degrades to markFailed and retries', async () => {
    let failOnce = true;
    const flaky = {
      hasRef: () => false,
      recordSettlement(): void {},
      recordTopUp(): void {
        if (failOnce) {
          failOnce = false;
          throw new Error('transient');
        }
      },
      detectDrift: () => ({
        expectedPoolStroops: 0n,
        observedPoolStroops: 0n,
        driftStroops: 0n,
        inSync: true,
      }),
    };
    const r = rig(flaky);
    r.confirmed.add('o1');

    await settleAndRebalance(r);
    r.clock.now += DEMO_VALOR + 1;

    const first = await settleAndRebalance(r);
    expect(first.failed).toBe(1);
    expect(r.store.credits).toEqual([]);

    const second = await settleAndRebalance(r); // the record went back to pending, so it retries
    expect(second.settled).toBe(1);
    expect(r.store.credits).toHaveLength(1);
  });
});
