import { describe, expect, it } from 'vitest';
import { Ledger } from '@troia/ledger';
import type { State } from '@troia/core';
import { KeyedMutex } from '../../src/store/mutex.js';
import { InMemoryPendingSettlementStore } from '../../src/settlement/pending-settlement-store.js';
import { TryDrivenRebalancePolicy } from '../../src/settlement/rebalance-policy.js';
import { settleAndRebalance } from '../../src/settlement/settlement-worker.js';
import type { SettlementDeps, TopUpExecution } from '../../src/settlement/settlement-worker.js';
import type { TopUpRequest } from '../../src/settlement/rebalance-policy.js';
import { checkDrift } from '../../src/settlement/drift-worker.js';
import { FakeClock, ORDER_FACTS } from '../fakes/harness.js';
import type { OrderFacts } from '../../src/ports.js';

// The missing half of the double entry. Until now the live ledger only ever recorded money going IN (mints), so
// `nativeBalance('USDC_POOL')` climbed forever while the chain balance fell with every payout. Wiring the drift
// alarm against that ledger would have produced a permanent, meaningless alarm equal to the sum of all payouts.
//
// These tests use the REAL Ledger, so they pin the arithmetic, not a fake's idea of it.

const STROOP = 10_000_000n;
const DEMO_VALOR = 30;
const RATE = 340_000_000n; // 34.0 TRY/USDC

// harness ctx: paidPriceTry '3400.00' (340_000 kuruş), amount 100 USDC, spread 5_000, fee 2_000
const CHARGED_KURUS = 340_000n;
const PAID_OUT = 100n * STROOP;

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

class Mint {
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

function rig(ledger: Ledger): SettlementDeps & {
  confirmed: FakeConfirmed;
  clock: FakeClock;
  rebalance: Mint;
  store: CreditSpy;
} {
  return {
    confirmed: new FakeConfirmed(),
    orderLocks: new KeyedMutex(),
    clock: new FakeClock(1_000),
    pending: new InMemoryPendingSettlementStore(),
    policy: new TryDrivenRebalancePolicy(),
    rebalance: new Mint(),
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

/** A money-good payout has a durable evidence row; a money-bad one never gets one. */
function put(r: ReturnType<typeof rig>, orderId: string, state: State = 'UsdcConfirmed'): void {
  if (state === 'UsdcConfirmed' || state === 'Reconciled') r.confirmed.add(orderId);
}

describe('settleAndRebalance — the outflow is booked when the order is armed', () => {
  it('books what LEFT the pool, balanced against the cash, the PSP fee and the margin', async () => {
    const ledger = new Ledger();
    ledger.recordTopUp({ ref: 'genesis', usdcStroops: 1000n * STROOP, valueKurus: 3_400_000n });
    const r = rig(ledger);
    put(r, 'o1');

    const report = await settleAndRebalance(r);
    expect(report.booked).toBe(1);
    expect(report.armed).toBe(1);
    expect(r.rebalance.calls).toBe(0); // arming mints nothing

    // the pool fell by exactly the USDC paid out
    expect(ledger.nativeBalance('USDC_POOL')).toBe(1000n * STROOP - PAID_OUT);
    // and the cash side balances: 3400.00 charged, 20.00 of it the PSP cost
    expect(ledger.balanceKurus('FIAT_CASH')).toBe(CHARGED_KURUS - 2_000n);
    expect(ledger.balanceKurus('PSP_FEE')).toBe(2_000n);
    expect(ledger.totalSpreadRevenueKurus()).toBe(5_000n);
    expect(ledger.trialBalanceKurus()).toBe(0n); // every entry balances
  });

  it('books each order exactly once, however many ticks discover it', async () => {
    const ledger = new Ledger();
    ledger.recordTopUp({ ref: 'genesis', usdcStroops: 1000n * STROOP, valueKurus: 3_400_000n });
    const r = rig(ledger);
    put(r, 'o1');

    const first = await settleAndRebalance(r);
    const second = await settleAndRebalance(r);
    expect(first.booked).toBe(1);
    expect(second.booked).toBe(0); // DuplicateRef, tolerated
    expect(ledger.nativeBalance('USDC_POOL')).toBe(1000n * STROOP - PAID_OUT);
  });

  it('re-books an order whose journal survived but whose in-memory arming did not (a restart)', async () => {
    const ledger = new Ledger();
    ledger.recordTopUp({ ref: 'genesis', usdcStroops: 1000n * STROOP, valueKurus: 3_400_000n });
    const before = rig(ledger);
    put(before, 'o1');
    await settleAndRebalance(before);

    // the process died: the pending store and the registry are gone, the ledger is not
    const after = rig(ledger);
    put(after, 'o1');
    const report = await settleAndRebalance(after);
    expect(report.booked).toBe(0); // the journal already knew
    expect(report.armed).toBe(1); // but it must arm again, or the pool is never refilled
    expect(ledger.nativeBalance('USDC_POOL')).toBe(1000n * STROOP - PAID_OUT); // booked once, still
  });

  it('a money-bad order is never booked', async () => {
    const ledger = new Ledger();
    const r = rig(ledger);
    put(r, 'reverted', 'ChargeReversed');
    const report = await settleAndRebalance(r);
    expect(report.booked).toBe(0);
    expect(ledger.all()).toEqual([]);
  });
});

describe('the drift alarm now measures something true', () => {
  it('a payout and its refill leave the books agreeing with the chain', async () => {
    const ledger = new Ledger();
    ledger.recordTopUp({ ref: 'genesis', usdcStroops: 1000n * STROOP, valueKurus: 3_400_000n });
    const r = rig(ledger);
    put(r, 'o1');

    await settleAndRebalance(r); // arm + book the outflow
    r.clock.now += DEMO_VALOR + 1;
    await settleAndRebalance(r); // valör elapsed: mint + book the top-up

    const chain = ledger.nativeBalance('USDC_POOL'); // what an honest chain would hold
    const drift = await checkDrift({
      stellar: {
        async readPoolBalanceStroops(): Promise<bigint> {
          return chain;
        },
      },
      ledger,
    });
    expect(drift.inSync).toBe(true);
    expect(r.store.credits).toHaveLength(1);
  });

  it('WITHOUT the outflow booking the alarm would fire on every settled order — the bug this closes', async () => {
    const ledger = new Ledger();
    ledger.recordTopUp({ ref: 'genesis', usdcStroops: 1000n * STROOP, valueKurus: 3_400_000n });
    // model the old behaviour: only the top-up was ever booked
    ledger.recordTopUp({ ref: 'topup:o1', usdcStroops: 10n * STROOP, valueKurus: 34_000n });

    const chain = 1000n * STROOP - PAID_OUT + 10n * STROOP; // the chain saw the payout leave
    const drift = ledger.detectDrift(chain);
    expect(drift.inSync).toBe(false);
    expect(drift.driftStroops).toBe(-PAID_OUT); // a permanent false alarm the size of every payout
  });

  it('a real shortfall — USDC leaving with nothing recorded — is seen', async () => {
    const ledger = new Ledger();
    ledger.recordTopUp({ ref: 'genesis', usdcStroops: 1000n * STROOP, valueKurus: 3_400_000n });
    const r = rig(ledger);
    put(r, 'o1');
    await settleAndRebalance(r);

    const stolen = 50n * STROOP;
    const drift = await checkDrift({
      stellar: {
        async readPoolBalanceStroops(): Promise<bigint> {
          return ledger.nativeBalance('USDC_POOL') - stolen;
        },
      },
      ledger,
    });
    expect(drift.inSync).toBe(false);
    expect(drift.driftStroops).toBe(-stolen);
  });
});
