import { describe, expect, it } from 'vitest';
import { advance, start } from '../../src/engine/driver.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// The end-to-end money-law path: start (reserve pool -> hosted sale form) -> chargeOk (the TRY sale completed)
// -> USDC submit+observe SUCCESS -> evidence appended at confirm. Proves ORDER (reserve pool -> charge TRY ->
// pay the IRREVERSIBLE USDC LAST) and that the confirm does NOT auto-close to Reconciled (that is the offline
// reconciler's job — driven here as a separate reconciled step).
describe('engine happy path — full settlement drive', () => {
  it('start() reserves then fires the hosted checkout form once and quiesces in SolvencyReserved (idempotent)', async () => {
    const h = makeHarness();
    const ctx = makeCtx(h.store);

    const r0 = await start(ctx, h.deps);
    expect(r0.state).toBe('SolvencyReserved');
    expect(r0.quiescence).toBe('waiting');
    expect(r0.sideOutputs).toEqual([{ kind: 'checkoutForm', token: 'tok-1', formContent: '<html/>' }]);
    expect(h.trace.filter((t) => t === 'psp.initializeCheckoutForm')).toHaveLength(1);

    // A redelivered start() must NOT re-fire fireCheckoutForm (a MUTATION_EFFECT) or re-reserve the pool.
    const again = await start(ctx, h.deps);
    expect(again.quiescence).toBe('alreadyStarted');
    expect(h.trace.filter((t) => t === 'psp.initializeCheckoutForm')).toHaveLength(1);
    expect(h.trace.filter((t) => t === 'store.reserve')).toHaveLength(1);
  });

  it('chargeOk drives reserve -> submit+observe -> evidence, ending in UsdcConfirmed (not Reconciled); reconciled closes it', async () => {
    const h = makeHarness();
    const ctx = makeCtx(h.store);
    await start(ctx, h.deps);

    const r = await advance(ctx, 'SolvencyReserved', { type: 'chargeOk' }, h.deps);

    expect(r.state).toBe('UsdcConfirmed'); // NOT Reconciled — no synchronous auto-reconcile; the reconciler closes it
    expect(r.quiescence).toBe('waiting');
    expect(r.escalate).toBeNull();

    // the pay() witness was threaded into ctx and used for the evidence record
    expect(r.ctx.hashHex).toBe('hash_order-001');
    expect(r.ctx.signedXdr).toBe('xdr_order-001');
    expect(h.store.evidence).toHaveLength(1);
    expect(h.store.evidence[0]?.record).toEqual({ txHash: 'hash_order-001', signedXdr: 'xdr_order-001', seq: ctx.activeSeq });
    expect(h.store.losses).toHaveLength(0);

    // money-law ordering: reserve BEFORE the checkout/charge form; the charge (sale form) BEFORE the IRREVERSIBLE
    // USDC submit; evidence appended LAST at confirm.
    const i = (s: string) => h.trace.indexOf(s);
    expect(i('store.reserve')).toBeLessThan(i('psp.initializeCheckoutForm'));
    expect(i('psp.initializeCheckoutForm')).toBeLessThan(i('stellar.submitPay'));
    expect(i('store.reserve')).toBeLessThan(i('stellar.submitPay'));
    expect(i('stellar.observe')).toBeLessThan(i('store.appendEvidence'));
    // write-ahead: the UsdcSubmitted state is persisted BEFORE the pay() is sent
    expect(i('store.persistState:UsdcSubmitted')).toBeLessThan(i('stellar.submitPay'));
    expect(i('store.persistState:UsdcSubmitted')).toBeGreaterThanOrEqual(0);

    // the offline reconciler — NOT the engine — closes the order once verifyReport matches.
    const rc = await advance(r.ctx, 'UsdcConfirmed', { type: 'reconciled' }, h.deps);
    expect(rc.state).toBe('Reconciled');
    expect(rc.quiescence).toBe('terminal');
  });
});
