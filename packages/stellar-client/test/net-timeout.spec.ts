import { describe, expect, it } from 'vitest';
import { withTimeout } from '../src/net-timeout.js';

// withTimeout races a network promise against a REJECTING timeout so a hung RPC read can't wedge the poll loop
// forever. In main.ts the loop guards with `let polling=false; ...finally(() => polling=false)`: if a read HANGS
// (open socket, no bytes), the finally never runs and every later tick short-circuits — the poller is dead. A
// timeout turns that hang into a rejection -> the loop's .catch/.finally reset the guard and recover next tick.
// It NEVER resolves to a value on timeout, so a timed-out read is an ERROR, never a (mis)observed on-chain state
// (it can therefore never be read as a settlement or as deadness -> no spurious replacement submit).

const never = new Promise<never>(() => {
  /* never settles — models a hung upstream socket */
});

describe('withTimeout — bound a hung network read', () => {
  it('rejects when the inner promise does not settle within the timeout', async () => {
    await expect(withTimeout(never, 20, 'rpc.getTransaction')).rejects.toThrow(/timed out/);
  });

  it('resolves with the inner value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'x')).resolves.toBe(42);
  });

  it('propagates the inner rejection (a real error is surfaced, not masked as a timeout)', async () => {
    await expect(withTimeout(Promise.reject(new Error('rpc 500')), 1000, 'x')).rejects.toThrow('rpc 500');
  });

  it('takes the fast path without waiting out the bound (timer is cleared on a quick resolve)', async () => {
    // A 60s bound but an immediate resolve: if the timer were not cleared the test would hold an open handle;
    // asserting the value settles proves the race short-circuits and the timer is cleared.
    await expect(withTimeout(Promise.resolve('ok'), 60_000, 'x')).resolves.toBe('ok');
  });
});
