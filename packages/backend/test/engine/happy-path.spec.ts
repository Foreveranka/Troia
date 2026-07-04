import { describe, expect, it } from 'vitest';
import { advance, start } from '../../src/engine/driver.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// The end-to-end money-law path: start (hosted-form) -> preauthOk -> solvency -> USDC submit+observe SUCCESS
// -> capture -> evidence. Proves ORDER (block TRY -> pay USDC -> capture TRY LAST) and that wave-2 does NOT
// auto-close to Reconciled (that is the reconciler's job in 4.3d).
describe('engine happy path — full settlement drive', () => {
  it('start() fires the hosted checkout form once and quiesces in Reserved (idempotent)', async () => {
    const h = makeHarness();
    const ctx = makeCtx(h.store);

    const r0 = await start(ctx, h.deps);
    expect(r0.state).toBe('Reserved');
    expect(r0.quiescence).toBe('waiting');
    expect(r0.sideOutputs).toEqual([{ kind: 'checkoutForm', token: 'tok-1', formContent: '<html/>' }]);
    expect(h.trace.filter((t) => t === 'psp.initializeCheckoutForm')).toHaveLength(1);

    // A redelivered start() must NOT re-fire firePreauth (a MUTATION_EFFECT).
    const again = await start(ctx, h.deps);
    expect(again.quiescence).toBe('alreadyStarted');
    expect(h.trace.filter((t) => t === 'psp.initializeCheckoutForm')).toHaveLength(1);
  });

  it('preauthOk drives reserve -> submit+observe -> capture -> evidence, ending in TryCaptured (not Reconciled)', async () => {
    const h = makeHarness();
    const ctx = makeCtx(h.store);
    await start(ctx, h.deps);

    const r = await advance(ctx, 'Reserved', { type: 'preauthOk' }, h.deps);

    expect(r.state).toBe('TryCaptured'); // NOT Reconciled — no synchronous auto-reconcile in wave-2
    expect(r.quiescence).toBe('waiting');
    expect(r.escalate).toBeNull();

    // the pay() witness was threaded into ctx and used for the evidence record
    expect(r.ctx.hashHex).toBe('hash_order-001');
    expect(r.ctx.signedXdr).toBe('xdr_order-001');
    expect(h.store.evidence).toHaveLength(1);
    expect(h.store.evidence[0]?.record).toEqual({ txHash: 'hash_order-001', signedXdr: 'xdr_order-001', seq: ctx.activeSeq });
    expect(h.store.losses).toHaveLength(0);

    // money-law ordering: reserve BEFORE submit; submit+observe BEFORE capture; evidence LAST
    const i = (s: string) => h.trace.indexOf(s);
    expect(i('store.reserve')).toBeLessThan(i('stellar.submitPay'));
    expect(i('stellar.observe')).toBeLessThan(i('psp.createPostAuth'));
    expect(i('psp.createPostAuth')).toBeLessThan(i('store.appendEvidence'));
    // write-ahead: the UsdcSubmitted state is persisted BEFORE the pay() is sent
    expect(i('store.persistState:UsdcSubmitted')).toBeLessThan(i('stellar.submitPay'));
    expect(i('store.persistState:UsdcSubmitted')).toBeGreaterThanOrEqual(0);
  });
});
