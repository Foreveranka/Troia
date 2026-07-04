import { describe, expect, it } from 'vitest';
import { intentBody, makeHttpHarness } from './http-harness.js';

describe('POST /intent — fail-closed ① order start', () => {
  it('starts the order, returns the hosted checkout, and registers it as pending', async () => {
    const h = makeHttpHarness();
    const res = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orderId: 'order-1', token: 'tok-1', checkoutFormContent: '<html/>' });
    // the backend-issued token is persisted for the later webhook re-retrieve
    expect(h.registry.getByOrderId('order-1')?.ctx.token).toBe('tok-1');
    expect(h.registry.getByOrderId('order-1')?.state).toBe('Reserved');

    const status = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'pending' });
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
    // firePreauth fired exactly once across both calls (idempotent createIfAbsent)
    expect(h.trace.filter((t) => t === 'psp.initializeCheckoutForm')).toHaveLength(1);
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
