import { describe, expect, it } from 'vitest';
import type { OrderCtx } from '../../src/ctx.js';
import { InMemoryOrderRegistry } from '../../src/http/order-registry.js';
import { KeyedMutex } from '../../src/store/mutex.js';
import { pollInFlight } from '../../src/worker/poll-worker.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// Making appendEvidence durable gave the poll pass a NEW way to throw — and it throws AFTER the USDC has landed,
// inside handToReconciler. Two behaviours have to be separated:
//
//   an ordinary failure     -> isolate that order, keep polling the rest, retry it next tick
//   a durable-log failure   -> nothing can be recorded any more; escape, so the process dies instead of
//                              re-running the effects that precede the write while recording none of them

class PoisonedLogError extends Error {
  readonly code = 'DurableLogFailure';
}

function seedTwo(h: ReturnType<typeof makeHarness>): {
  registry: InMemoryOrderRegistry;
  locks: KeyedMutex;
  ctxA: OrderCtx;
} {
  const registry = new InMemoryOrderRegistry();
  const mk = (orderId: string): OrderCtx =>
    makeCtx(h.store, {
      orderId,
      hashHex: `hash_${orderId}`,
      signedXdr: `xdr_${orderId}`,
      payMaxTimeUnix: 2_000_000_000,
    });
  const ctxA = mk('order-A');
  registry.put(ctxA, 'UsdcSubmitted');
  registry.put(mk('order-B'), 'UsdcSubmitted');
  return { registry, locks: new KeyedMutex(), ctxA };
}

describe('pollInFlight — one order cannot wedge the pass', () => {
  it('an ordinary throw isolates that order: it keeps its state, and the rest are still polled', async () => {
    const h = makeHarness();
    h.stellar.script = ['LANDED_SUCCESS', 'LANDED_SUCCESS'];
    const { registry, locks } = seedTwo(h);
    // order-A's witness append fails once; order-B's succeeds
    let first = true;
    h.store.appendEvidence = async (): Promise<void> => {
      if (first) {
        first = false;
        throw new Error('transient EIO');
      }
    };

    const report = await pollInFlight(registry, locks, h.deps);
    expect(report.failed).toBe(1);
    expect(report.polled).toBe(1); // order-B still got its turn
    expect(registry.getByOrderId('order-A')?.state).toBe('UsdcSubmitted'); // untouched, retried next tick
    expect(registry.getByOrderId('order-B')?.state).toBe('UsdcConfirmed');
  });

  it('a durable-log failure escapes the pass — the process must not keep running unrecorded', async () => {
    const h = makeHarness();
    h.stellar.script = ['LANDED_SUCCESS', 'LANDED_SUCCESS'];
    const { registry, locks } = seedTwo(h);
    h.store.appendEvidence = async (): Promise<void> => {
      throw new PoisonedLogError('the log is poisoned');
    };

    await expect(pollInFlight(registry, locks, h.deps)).rejects.toThrow(PoisonedLogError);
    // and it did NOT quietly advance the order it could not witness
    expect(registry.getByOrderId('order-A')?.state).toBe('UsdcSubmitted');
  });
});
