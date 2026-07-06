import { describe, expect, it } from 'vitest';
import {
  SimulatedRebalance,
  RebalanceError,
  type MintPort,
} from '../src/index.js';
import { Ledger, STROOP } from '../../ledger/src/index.js';

// SimulatedRebalance mints self-issued test USDC to top up the pool. The on-chain mint is an INJECTED port, so
// these tests substitute a controlled fake and run offline/deterministic. The fake accumulates a running pool
// balance and records every minted amount, so we can assert "minted exactly once" (never double-mint).
function fakeMint(startPool = 0n): { port: MintPort; calls: bigint[] } {
  let pool = startPool;
  const calls: bigint[] = [];
  const port: MintPort = {
    async mintToPool(amount) {
      calls.push(amount);
      pool += amount;
      return { txHash: `mint-${calls.length}`, poolStroops: pool };
    },
  };
  return { port, calls };
}

describe('rebalance — SimulatedRebalance mints to top up the pool', () => {
  it('mints the requested amount and returns the tx hash + observed pool balance', async () => {
    const { port, calls } = fakeMint(0n);
    const r = new SimulatedRebalance(port);
    const res = await r.topUp({ ref: 'cycle-1', usdcStroops: 5n * STROOP, valueKurus: 20_000n });
    expect(res.usdcStroops).toBe(5n * STROOP);
    expect(res.valueKurus).toBe(20_000n); // carried through for the caller's ledger booking
    expect(res.txHash).toBe('mint-1');
    expect(res.poolStroops).toBe(5n * STROOP); // observed balance after the mint (source of truth)
    expect(calls).toEqual([5n * STROOP]);
  });

  it('fails closed on an invalid request without minting', async () => {
    const { port, calls } = fakeMint();
    const r = new SimulatedRebalance(port);
    await expect(r.topUp({ ref: '', usdcStroops: STROOP, valueKurus: 100n })).rejects.toBeInstanceOf(RebalanceError);
    await expect(r.topUp({ ref: 'x', usdcStroops: 0n, valueKurus: 100n })).rejects.toBeInstanceOf(RebalanceError);
    await expect(r.topUp({ ref: 'x', usdcStroops: -1n, valueKurus: 100n })).rejects.toBeInstanceOf(RebalanceError);
    await expect(r.topUp({ ref: 'x', usdcStroops: STROOP, valueKurus: 0n })).rejects.toBeInstanceOf(RebalanceError);
    expect(calls).toEqual([]); // never reached the mint
  });

  it('is idempotent per ref: a repeat mints ONCE and returns the same result', async () => {
    const { port, calls } = fakeMint();
    const r = new SimulatedRebalance(port);
    const a = await r.topUp({ ref: 'cycle-1', usdcStroops: 3n * STROOP, valueKurus: 12_000n });
    const b = await r.topUp({ ref: 'cycle-1', usdcStroops: 3n * STROOP, valueKurus: 12_000n });
    expect(b).toEqual(a);
    expect(calls).toEqual([3n * STROOP]); // minted only once — never double-mint on a retry
  });

  it('concurrent calls with the same ref share one mint (never double-mint)', async () => {
    const { port, calls } = fakeMint();
    const r = new SimulatedRebalance(port);
    const [a, b] = await Promise.all([
      r.topUp({ ref: 'cycle-1', usdcStroops: STROOP, valueKurus: 4_000n }),
      r.topUp({ ref: 'cycle-1', usdcStroops: STROOP, valueKurus: 4_000n }),
    ]);
    expect(a).toEqual(b);
    expect(calls).toEqual([STROOP]); // exactly one mint despite two concurrent calls
  });

  it('a failed mint rejects and is NOT cached — a retry with the same ref mints again', async () => {
    let attempts = 0;
    const port: MintPort = {
      async mintToPool(amount) {
        attempts += 1;
        if (attempts === 1) throw new Error('mint network error');
        return { txHash: 'mint-ok', poolStroops: amount };
      },
    };
    const r = new SimulatedRebalance(port);
    await expect(r.topUp({ ref: 'cycle-1', usdcStroops: STROOP, valueKurus: 4_000n })).rejects.toThrow();
    const res = await r.topUp({ ref: 'cycle-1', usdcStroops: STROOP, valueKurus: 4_000n }); // retry
    expect(res.txHash).toBe('mint-ok');
    expect(attempts).toBe(2); // the clean failure did not land, so the retry is allowed to mint
  });

  it('distinct refs mint independently', async () => {
    const { port, calls } = fakeMint();
    const r = new SimulatedRebalance(port);
    await r.topUp({ ref: 'a', usdcStroops: STROOP, valueKurus: 4_000n });
    await r.topUp({ ref: 'b', usdcStroops: 2n * STROOP, valueKurus: 8_000n });
    expect(calls).toEqual([STROOP, 2n * STROOP]);
  });
});

describe('rebalance — a top-up result books cleanly into the ledger (drift stays in sync)', () => {
  it('feeds recordTopUp so the pool USDC rises and drift against the chain is zero', async () => {
    const { port } = fakeMint(0n);
    const r = new SimulatedRebalance(port);
    const ledger = new Ledger();
    const res = await r.topUp({ ref: 'cycle-1', usdcStroops: 10n * STROOP, valueKurus: 40_000n });
    ledger.recordTopUp({ ref: res.ref, usdcStroops: res.usdcStroops, valueKurus: res.valueKurus });
    expect(ledger.nativeBalance('USDC_POOL')).toBe(10n * STROOP);
    // the chain (source of truth) reports the same balance the mint landed → zero drift
    expect(ledger.detectDrift(res.poolStroops).inSync).toBe(true);
  });
});
