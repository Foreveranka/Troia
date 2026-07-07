import { describe, expect, it } from 'vitest';
import { SequenceAllocator } from '@troia/core';
import { TIMEOUT } from '../fakes/harness.js';
import type { QuoteFn } from '../../src/http/app.js';
import { AMOUNT, intentBody, makeHttpHarness } from './http-harness.js';

describe('POST /intent — money-first ① order start', () => {
  it('reserves the pool, returns the hosted direct-sale checkout, and registers it as pending', async () => {
    const h = makeHttpHarness();
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });

    expect(res.statusCode).toBe(200);
    // money-first response: backend-issued token + hosted form + the SERVER-computed price + low-water flag
    expect(res.json()).toEqual({
      orderId: 'order-1',
      token: 'tok-1',
      checkoutFormContent: '<html/>',
      paidPriceTry: '41.42', // priced server-side: 1 USDC @ 40.50 mid + 229 bps commission (T+15)
      spreadBps: 229,
      poolLow: false,
    });
    // the backend-issued token is persisted for the later webhook re-retrieve
    expect(h.registry.getByOrderId('order-1')?.ctx.token).toBe('tok-1');
    // a successful start reserves the pool then quiesces at SolvencyReserved (charge pending, form shown)
    expect(h.registry.getByOrderId('order-1')?.state).toBe('SolvencyReserved');
    // late allocation (Approach B): /intent does NOT hand out an operator seq — a reserved-but-uncharged order
    // holds none, so an abandoned checkout leaves the operator sequence space untouched (no gap for later orders)
    expect(h.registry.getByOrderId('order-1')?.ctx.activeSeq).toBeNull();
    expect((h.store.sequences as SequenceAllocator).activeSeqFor('order-1')).toBeUndefined();

    const status = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'pending' });
  });

  it('prices the order SERVER-SIDE and IGNORES a client-supplied price AND currency (zero-trust)', async () => {
    const h = makeHttpHarness();
    // a client tries to dictate a cheap price AND a foreign currency — the backend must ignore both
    const tampered = { ...intentBody('order-1'), paidPriceTry: '0.01', appliedRateStroops: '1', currency: 'USD' };
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: tampered });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paidPriceTry: '41.42', spreadBps: 229 }); // server-computed, NOT the client's 0.01
    const ctx = h.registry.getByOrderId('order-1')?.ctx;
    expect(ctx?.paidPriceTry).toBe('41.42'); // the charge + settlement use the SERVER price
    expect(ctx?.appliedRateStroops).toBe(414_274_500n); // 40.50 × 1.0229, NOT the client's 1
    expect(ctx?.currency).toBe('TRY'); // server-fixed currency, NOT the client's 'USD' (would charge TRY as USD)
  });

  it('rejects a malformed body (400) without starting an order or consuming a sequence', async () => {
    const h = makeHttpHarness();
    const { orderId: _o, ...missingOrderId } = intentBody('order-1');
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: missingOrderId });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'BadRequest' });
  });

  it('is idempotent: a duplicate /intent preserves the persisted token (never resets it to null)', async () => {
    const h = makeHttpHarness();
    const first = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
    expect(first.json()).toMatchObject({ orderId: 'order-1', token: 'tok-1' });

    const second = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ orderId: 'order-1', token: 'tok-1', alreadyStarted: true });
    // the registry record still carries the backend-issued token -> the webhook can still settle
    expect(h.registry.getByOrderId('order-1')?.ctx.token).toBe('tok-1');
    // the hosted checkout form was initialized exactly once across both calls (idempotent createIfAbsent)
    expect(h.trace.filter((t) => t === 'psp.initializeCheckoutForm')).toHaveLength(1);
  });

  it('canonicalizes the orderId: NFC-equivalent orderIds are ONE order (no double reserve, no second form)', async () => {
    const h = makeHttpHarness();
    const nfd = 'order-caf' + 'e\u0301'; // 'e' + U+0301 combining acute (NFD)
    const nfc = 'order-caf' + '\u00e9'; // precomposed acute e (NFC) - SAME canonical identity as nfd
    const before = h.store.availableStroops();

    const first = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody(nfd) });
    expect(first.statusCode).toBe(200);
    const afterFirst = h.store.availableStroops();
    expect(before - afterFirst).toBe(AMOUNT); // exactly ONE reservation held

    const second = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody(nfc) });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ alreadyStarted: true }); // the SAME logical order, not a second one
    expect(h.store.availableStroops()).toBe(afterFirst); // NO second pool reservation (double-reserve prevented)
    expect(h.trace.filter((t) => t === 'psp.initializeCheckoutForm')).toHaveLength(1); // one checkout form only
  });

  it('circuit-breaker: 409 PoolInsufficient when the pool cannot cover the amount (no seq, no order, no charge)', async () => {
    const h = makeHttpHarness(0n); // empty pool: availableStroops() (0) < amount
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'PoolInsufficient' });
    // fail-closed ①: the HARD gate fires BEFORE createIfAbsent/reserve/allocate — nothing leaked, nothing charged
    expect(h.registry.getByOrderId('order-1')).toBeUndefined();
    expect(h.trace).not.toContain('store.createIfAbsent');
    expect(h.trace).not.toContain('store.reserve');
    expect(h.trace).not.toContain('psp.initializeCheckoutForm');
    expect(h.trace).not.toContain('stellar.submitPay');
  });

  it('returns 503 CheckoutUnavailable when the hosted form init malforms (fail-closed: reserved but never charged)', async () => {
    const h = makeHttpHarness();
    h.psp.init = TIMEOUT; // init malforms -> checkoutInitFailed -> FailedClean, no checkout form issued
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'CheckoutUnavailable' });
    // the form init WAS attempted, but the irreversible USDC leg was NEVER submitted (money-first: charge is last)
    expect(h.trace).toContain('psp.initializeCheckoutForm');
    expect(h.trace).not.toContain('stellar.submitPay');
  });

  it('rejects a non-numeric amount (400 BadAmount)', async () => {
    const h = makeHttpHarness();
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: { ...intentBody('order-1'), amountStroops: 'abc' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'BadAmount' });
  });

  it('fail-closed ①: a tampered memo is rejected with the deterministic BuildError and starts NO order', async () => {
    const h = makeHttpHarness();
    const tampered = { ...intentBody('order-1'), memoHex: 'ab'.repeat(32) }; // valid length, wrong value
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: tampered });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'MemoMismatch' });
    expect(h.registry.getByOrderId('order-1')).toBeUndefined(); // no order, no seq leaked
    expect(h.trace).not.toContain('psp.initializeCheckoutForm');
  });

  it('rejects an unallowlisted issuer (400 IssuerNotAllowlisted)', async () => {
    const h = makeHttpHarness();
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: { ...intentBody('order-1'), assetIssuer: 'GNOTALLOWED' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'IssuerNotAllowlisted' });
  });

  it('fails closed 502 PriceUnavailable when pricing is down — no seq, no order, no form', async () => {
    const failing: QuoteFn = async () => {
      throw new Error('rate source down');
    };
    const h = makeHttpHarness(100n, failing);
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'PriceUnavailable' });
    expect(h.registry.getByOrderId('order-1')).toBeUndefined(); // priced BEFORE any seq/order -> nothing leaked
    expect(h.trace).not.toContain('psp.initializeCheckoutForm'); // never opened a checkout form
  });

  it('returns 502 SnapshotUnavailable when the destination read fails (fail-closed, testable)', async () => {
    const h = makeHttpHarness();
    h.stellar.loadDestinationSnapshot = async () => {
      throw new Error('network down');
    };
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'SnapshotUnavailable' });
  });
});
