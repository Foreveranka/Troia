import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/store/in-memory-store.js';
import type { Lock } from '../../src/store/mutex.js';
import type { ReserveOutcome } from '../../src/ports.js';

// SPIKE-3 GO criterion: 0 over-commit, 0 orphan; the pool NEVER goes negative under concurrent demand.
// Over-commit = insolvency (irreversible on mainnet). The proof drives the REAL store.reserve() with an
// injected interleaving seam (a microtask yield between CHECK and COMMIT — the durable-write window a DB
// Store will have). The ONLY variable between the two runs is the pool lock, so the test genuinely
// regression-guards it: with the lock -> exactly-affordable succeed; with a NoOpMutex -> it over-commits.

const UNIT = 10_000_000n; // 1 USDC @ 7 decimals
const N = 100; // exactly-affordable payouts
const K = 50; // over-demand

/** A lock that does nothing — models "the pool mutex was removed". TEST-ONLY. */
class NoOpMutex implements Lock {
  run<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

const yieldMicrotask = (): Promise<void> => new Promise((r) => queueMicrotask(r));

function fireConcurrentReserves(store: InMemoryStore, count: number): Promise<ReserveOutcome[]> {
  const calls: Promise<ReserveOutcome>[] = [];
  for (let i = 0; i < count; i++) calls.push(store.reserve(`order-${i}`, UNIT, 600_000, 0));
  return Promise.all(calls);
}

describe('SPIKE-3 — solvency reservation under concurrency', () => {
  it('WITH the pool lock: exactly the affordable count reserve; the rest fail closed; pool never negative', async () => {
    const store = new InMemoryStore({
      balanceStroops: BigInt(N) * UNIT, // room for exactly N
      baseSeq: 1000n,
      beforeReserveCommit: yieldMicrotask, // force an interleaving window between CHECK and COMMIT
    });

    const outcomes = await fireConcurrentReserves(store, N + K);
    const reserved = outcomes.filter((o) => o.kind === 'reserved').length;
    const insufficient = outcomes.filter((o) => o.kind === 'insufficient').length;

    expect(reserved).toBe(N); // exactly affordable — 0 over-commit
    expect(insufficient).toBe(K); // the rest fail closed
    expect(store.availableStroops()).toBe(0n); // pool exactly drained, never negative
    expect(store.poolBalanceStroops() - BigInt(reserved) * UNIT).toBeGreaterThanOrEqual(0n);
  });

  it('WITHOUT the lock (NoOpMutex): the SAME workload OVER-COMMITS — proving the lock is load-bearing', async () => {
    const store = new InMemoryStore({
      balanceStroops: BigInt(N) * UNIT,
      baseSeq: 1000n,
      beforeReserveCommit: yieldMicrotask,
      poolMutex: new NoOpMutex(), // the regression under test
    });

    const outcomes = await fireConcurrentReserves(store, N + K);
    const reserved = outcomes.filter((o) => o.kind === 'reserved').length;

    // all CHECKs see the stale (full) balance before any COMMIT, so far more than affordable get through
    expect(reserved).toBeGreaterThan(N);
    expect(store.availableStroops()).toBeLessThan(0n); // pool driven NEGATIVE — the insolvency the lock prevents
  });

  it('idempotent under concurrency: the SAME order reserving many times consumes ONE unit', async () => {
    let seamCrossings = 0;
    const store = new InMemoryStore({
      balanceStroops: 5n * UNIT,
      baseSeq: 1000n,
      beforeReserveCommit: async () => {
        seamCrossings += 1;
        await yieldMicrotask();
      },
    });
    const calls: Promise<ReserveOutcome>[] = [];
    for (let i = 0; i < 20; i++) calls.push(store.reserve('same-order', UNIT, 600_000, 0));
    const outcomes = await Promise.all(calls);
    expect(outcomes.every((o) => o.kind === 'reserved')).toBe(true);
    expect(store.availableStroops()).toBe(4n * UNIT); // charged exactly once
    // the idempotency guard short-circuits the other 19 BEFORE the CHECK/COMMIT seam — proof the guard is live
    // (removing it would send all 20 through the seam; the Map-overwrite would otherwise mask that)
    expect(seamCrossings).toBe(1);
  });

  it('per-order counter RMW does not race: concurrent same-order bumps return distinct sequential values', async () => {
    // Guards specifically against a regression that inserts an await between the counter read and write
    // (which a durable/DB impl would have) — the in-memory RMW is synchronous, so it is atomic by construction.
    const store = new InMemoryStore({ balanceStroops: UNIT, baseSeq: 1000n });
    const results = await Promise.all([
      store.bumpDeadRetries('o'),
      store.bumpDeadRetries('o'),
      store.bumpDeadRetries('o'),
    ]);
    expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
