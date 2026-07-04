import { describe, expect, it } from 'vitest';
import { intentBody, makeHttpHarness, signV3, WEBHOOK_SECRET, webhookEvent } from './http-harness.js';

async function startOrder(h: ReturnType<typeof makeHttpHarness>, orderId: string): Promise<void> {
  const r = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody(orderId) });
  expect(r.statusCode).toBe(200);
}

function post(h: ReturnType<typeof makeHttpHarness>, event: ReturnType<typeof webhookEvent>, sig: string) {
  return h.app.inject({ method: 'POST', url: '/webhook', headers: { 'x-iyz-signature-v3': sig }, payload: event });
}

describe('POST /webhook — SPIKE-4 money gate', () => {
  it('a valid signature drives the order to settlement', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    const event = webhookEvent('order-1');
    const res = await post(h, event, signV3(WEBHOOK_SECRET, event));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    // the server-side re-retrieve + full settlement ran
    expect(h.trace).toContain('psp.retrieveCheckoutFormResult');
    expect(h.trace).toContain('stellar.submitPay');
    expect(h.trace).toContain('psp.createPostAuth');
    const status = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'completed' });
  });

  it('a FORGED signature is rejected 401 with ZERO side effects (no retrieve, no submit, order untouched)', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    const event = webhookEvent('order-1');
    const res = await post(h, event, 'deadbeef'.repeat(8)); // wrong signature

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'BadSignature' });
    expect(h.trace).not.toContain('psp.retrieveCheckoutFormResult');
    expect(h.trace).not.toContain('stellar.submitPay');
    const status = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'pending' }); // still Reserved
  });

  it('an absent signature is rejected 401 (fail-closed)', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    const event = webhookEvent('order-1');
    const res = await h.app.inject({ method: 'POST', url: '/webhook', payload: event }); // no header
    expect(res.statusCode).toBe(401);
  });

  it('a replayed (duplicate) webhook is deduped 200 without a second settlement', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    const event = webhookEvent('order-1');
    const sig = signV3(WEBHOOK_SECRET, event);

    const first = await post(h, event, sig);
    expect(first.json()).toMatchObject({ status: 'ok' });
    const submits = h.stellar.submitReqs.length;

    const replay = await post(h, event, sig);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: 'duplicate' });
    expect(h.stellar.submitReqs.length).toBe(submits); // NO second USDC submit
  });

  it('still settles after a benign DUPLICATE /intent (the duplicate must not brick the token)', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    await startOrder(h, 'order-1'); // duplicate /intent — pre-fix this reset ctx.token to null
    const event = webhookEvent('order-1');
    const res = await post(h, event, signV3(WEBHOOK_SECRET, event));
    expect(res.json()).toMatchObject({ status: 'ok' }); // NOT tokenMismatch
    const status = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'completed' });
  });

  it('an unknown conversationId (valid signature) returns 404 UnknownOrder', async () => {
    const h = makeHttpHarness();
    const event = webhookEvent('never-created'); // no /intent for this order
    const res = await post(h, event, signV3(WEBHOOK_SECRET, event));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'UnknownOrder' });
  });

  it('a token mismatch (valid signature over a different token) no-ops without advancing', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    const event = webhookEvent('order-1', { token: 'attacker-token' }); // != the backend-issued tok-1
    const res = await post(h, event, signV3(WEBHOOK_SECRET, event)); // sig valid FOR this event

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'tokenMismatch' });
    expect(h.trace).not.toContain('psp.retrieveCheckoutFormResult');
    expect(h.trace).not.toContain('stellar.submitPay');
    const status = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'pending' });
  });
});
