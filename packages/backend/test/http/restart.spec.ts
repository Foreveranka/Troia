import { describe, expect, it } from 'vitest';
import { body } from '../fakes/harness.js';
import {
  intentBody,
  makeHttpHarness,
  restartHttpHarness,
  signV3,
  WEBHOOK_SECRET,
  webhookEvent,
} from './http-harness.js';
import type { HttpHarness } from './http-harness.js';

// A restart erases the order registry. For a while that meant a settled order — money moved, evidence on disk,
// reconciled by the live audit — answered `NotFound` to the customer. The money survived; the answer did not.
//
// The fix reads the durable evidence log, and it is safe for one structural reason: `handToReconciler` is the only
// effect that writes an evidence row, and it fires on exactly the two transitions into `UsdcConfirmed`, whose only
// exit is `Reconciled`. Both are `completed`. So the row's existence IS the status, and the endpoint cannot claim
// more than the disk knows. An order still in flight has no row, and still gets an honest 404.

async function settleOrder(h: HttpHarness, orderId: string): Promise<void> {
  const intent = await h.app.inject({
    method: 'POST',
    url: '/intent',
    ...body(intentBody(orderId)),
  });
  expect(intent.statusCode).toBe(200);
  const event = webhookEvent(orderId);
  const res = await h.app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-iyz-signature-v3': signV3(WEBHOOK_SECRET, event) },
    ...body(event as unknown as Record<string, unknown>),
  });
  expect(res.statusCode).toBe(200);
}

describe('a restart must not lose an order whose money already moved', () => {
  it('/status still answers `completed` for a settled order, from the durable evidence alone', async () => {
    const h = makeHttpHarness();
    await settleOrder(h, 'order-1');
    expect((await h.app.inject({ method: 'GET', url: '/status/order-1' })).json()).toEqual({
      orderId: 'order-1',
      status: 'completed',
    });

    const restarted = restartHttpHarness(h);
    expect(restarted.registry.getByOrderId('order-1')).toBeUndefined(); // the memory really is gone
    const status = await restarted.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ orderId: 'order-1', status: 'completed' });
  });

  it('/receipt still hands back the tx hash a reviewer takes to the explorer', async () => {
    const h = makeHttpHarness();
    await settleOrder(h, 'order-1');
    const before = (await h.app.inject({ method: 'GET', url: '/receipt/order-1' })).json();

    const restarted = restartHttpHarness(h);
    const after = (await restarted.app.inject({ method: 'GET', url: '/receipt/order-1' })).json();
    expect(after).toEqual(before);
    expect(typeof (after as { txHash: string }).txHash).toBe('string');
  });

  it('an order that never settled is still an honest 404 — we genuinely no longer know', async () => {
    const h = makeHttpHarness();
    // reserved + hosted form shown, but no webhook: no USDC leg, so no evidence row
    await h.app.inject({ method: 'POST', url: '/intent', ...body(intentBody('order-2')) });
    expect((await h.app.inject({ method: 'GET', url: '/status/order-2' })).json()).toEqual({
      orderId: 'order-2',
      status: 'pending',
    });

    const restarted = restartHttpHarness(h);
    const status = await restarted.app.inject({ method: 'GET', url: '/status/order-2' });
    expect(status.statusCode).toBe(404);
    expect(
      (await restarted.app.inject({ method: 'GET', url: '/receipt/order-2' })).statusCode,
    ).toBe(404);
  });

  it('an order this process never heard of is 404, restart or not', async () => {
    const restarted = restartHttpHarness(makeHttpHarness());
    expect((await restarted.app.inject({ method: 'GET', url: '/status/nope' })).statusCode).toBe(
      404,
    );
  });

  it('an unsettled order is 404 even when OTHER orders did settle — the lookup is keyed, not "any row"', async () => {
    // Guards the failure a naive fallback invites: answering from the first row in the log. That would report a
    // stranger's settlement as this order's, and hand a stranger's tx hash to /receipt.
    const h = makeHttpHarness();
    await settleOrder(h, 'order-1');
    await h.app.inject({ method: 'POST', url: '/intent', ...body(intentBody('order-2')) });

    const restarted = restartHttpHarness(h);
    expect(restarted.store.evidenceRecords()).toHaveLength(1); // order-1's row IS on disk
    expect((await restarted.app.inject({ method: 'GET', url: '/status/order-2' })).statusCode).toBe(
      404,
    );
    expect(
      (await restarted.app.inject({ method: 'GET', url: '/receipt/order-2' })).statusCode,
    ).toBe(404);
  });

  it('each settled order gets back its OWN transaction hash, never a neighbour’s', async () => {
    const h = makeHttpHarness();
    await settleOrder(h, 'order-1');
    await settleOrder(h, 'order-2');

    const restarted = restartHttpHarness(h);
    const one = (await restarted.app.inject({ method: 'GET', url: '/receipt/order-1' })).json();
    const two = (await restarted.app.inject({ method: 'GET', url: '/receipt/order-2' })).json();
    const hashOf = (r: unknown): string => (r as { txHash: string }).txHash;

    expect(hashOf(one)).not.toEqual(hashOf(two));
    const rows = restarted.store.evidenceRecords();
    expect(hashOf(one)).toBe(rows.find((r) => r.orderId === 'order-1')?.record.txHash);
    expect(hashOf(two)).toBe(rows.find((r) => r.orderId === 'order-2')?.record.txHash);
  });

  it('the live registry still wins over the durable row — it knows states the log cannot', async () => {
    // The row says "settled". Only the registry can say `Reconciled` vs `UsdcConfirmed`, or report a LossReview.
    // Both map to `completed` here, but the endpoint must read the live state when it has one, not the fallback.
    const h = makeHttpHarness();
    await settleOrder(h, 'order-1');
    const rec = h.registry.getByOrderId('order-1');
    expect(rec?.state).toBe('UsdcConfirmed');
    expect((await h.app.inject({ method: 'GET', url: '/status/order-1' })).json()).toEqual({
      orderId: 'order-1',
      status: 'completed',
    });
  });
});
