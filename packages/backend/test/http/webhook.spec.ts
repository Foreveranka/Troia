import { describe, expect, it } from 'vitest';
import { body } from '../fakes/harness.js';
import { intentBody, makeHttpHarness, signV3, WEBHOOK_SECRET, webhookEvent } from './http-harness.js';

// Money-first (Phase 4.6): /intent quiesces the order in SolvencyReserved (pool reserved + hosted DIRECT-SALE
// form shown, NO preauth). A verified CHECKOUT_FORM_AUTH webhook re-retrieves the sale by the BACKEND-issued
// token and drives SolvencyReserved -> chargeOk -> UsdcSubmitted, then submits + observes the IRREVERSIBLE USDC
// leg and appends evidence LAST (UsdcConfirmed). There is no capture/postauth leg anymore.
async function startOrder(h: ReturnType<typeof makeHttpHarness>, orderId: string): Promise<void> {
  const r = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody(orderId) });
  expect(r.statusCode).toBe(200); // lands in SolvencyReserved (public status 'pending')
}

function post(h: ReturnType<typeof makeHttpHarness>, event: ReturnType<typeof webhookEvent>, sig: string) {
  return h.app.inject({ method: 'POST', url: '/webhook', headers: { 'x-iyz-signature-v3': sig }, payload: event });
}

describe('POST /webhook — SPIKE-4 money gate', () => {
  it('a valid signature drives the order through the USDC leg to settlement', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    const event = webhookEvent('order-1');
    const res = await post(h, event, signV3(WEBHOOK_SECRET, event));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    // the server-side re-retrieve of the SALE ran, chargeOk drove SolvencyReserved -> UsdcSubmitted, then the
    // IRREVERSIBLE USDC leg submitted + observed (evidence is appended LAST, past UsdcConfirmed). The HTTP harness
    // wires the port trace to the psp/stellar fakes only, so we assert the observable port-level ordering here.
    expect(h.trace).toContain('psp.retrieveCheckoutFormResult');
    expect(h.trace).toContain('stellar.submitPay');
    expect(h.trace).toContain('stellar.observe'); // the USDC leg is submitted + observed, never captured/postauthed
    expect(h.stellar.submitReqs.length).toBe(1); // exactly one USDC leg submitted
    const status = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'completed' }); // UsdcConfirmed
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
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'pending' }); // still SolvencyReserved
  });

  it('an absent signature is rejected 401 (fail-closed)', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    const event = webhookEvent('order-1');
    const res = await h.app.inject({ method: 'POST', url: '/webhook', payload: event }); // no header
    expect(res.statusCode).toBe(401);
  });

  it('a replayed (duplicate) webhook is deduped 200 without a second USDC submit', async () => {
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

  it('a webhook for an order already past SolvencyReserved is a no-op (no second USDC submit)', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    // first, valid webhook settles the order to UsdcConfirmed (past the charge-pending SolvencyReserved state).
    const first = webhookEvent('order-1');
    expect((await post(h, first, signV3(WEBHOOK_SECRET, first))).json()).toMatchObject({ status: 'ok' });
    const submits = h.stellar.submitReqs.length;

    // a fresh CHECKOUT_FORM_AUTH (distinct iyziPaymentId dodges the dedup) now hits the state guard: the order is
    // no longer SolvencyReserved, so it is a no-op that submits no further money.
    const again = webhookEvent('order-1', { iyziPaymentId: 'iyzi-pay-2' });
    const res = await post(h, again, signV3(WEBHOOK_SECRET, again));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'noop' });
    expect(h.stellar.submitReqs.length).toBe(submits);
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

  it('a malformed retrieve (success shape but NO paymentId) is chargeUnknown — stays SolvencyReserved, NO USDC', async () => {
    const h = makeHttpHarness();
    await startOrder(h, 'order-1');
    // the server-side re-retrieve looks successful but carries NO paymentId — a charge we could NOT later void.
    // It must read chargeUnknown (stay), never a chargeOk that submits the irreversible USDC leg.
    let retrieved = false;
    h.psp.retrieveCheckoutFormResult = async (p) => {
      retrieved = true;
      return body({ status: 'success', token: p.token, paymentStatus: 'SUCCESS', fraudStatus: 1, conversationId: p.conversationId });
    };
    const event = webhookEvent('order-1');
    const res = await post(h, event, signV3(WEBHOOK_SECRET, event));

    expect(res.statusCode).toBe(200);
    expect(retrieved).toBe(true); // the webhook DID re-retrieve (it passed the sig/state/token guards)...
    expect(h.stellar.submitReqs).toHaveLength(0); // ...but NEVER submits USDC on an unvoidable (paymentId-less) charge
    const status = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'pending' }); // still SolvencyReserved
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
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'pending' }); // still SolvencyReserved
  });
});
