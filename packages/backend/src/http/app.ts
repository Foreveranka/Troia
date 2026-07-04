// The Fastify HTTP shell + composition. Three routes: POST /intent (fail-closed ① order start -> hosted
// checkout), GET /status/:orderId (coarse public status), POST /webhook (iyzico preauth result -> drive
// settlement). The app OWNS the per-order KeyedMutex (single-writer per order across intent/webhook/poll) and
// is handed injected deps (fakes offline; real adapters + durable registry at 4.3d).
//
// WEBHOOK MONEY GATE (SPIKE-4): verifyWebhookSignature is the FIRST thing that runs; a forged/absent signature
// returns 401 with ZERO side effects (no registry/store/psp/engine touch). A valid signature proves only
// AUTHENTICITY — the USDC decision comes from a server-side re-retrieve keyed on the BACKEND-issued token
// (never the webhook-echoed one) plus the state===Reserved guard, never the webhook's status field.

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { PayoutIntent } from '@troia/core';
import { preauthEvent, projectCheckoutFormResult, verifyWebhookSignature } from '@troia/psp';
import type { WebhookEvent } from '@troia/psp';
import type { OrderCtx } from '../ctx.js';
import { advance, start } from '../engine/driver.js';
import type { EngineDeps } from '../engine/events.js';
import { KeyedMutex } from '../store/mutex.js';
import type { OrderRegistry } from './order-registry.js';
import { toPublicStatus } from './public-status.js';

export interface AppDeps {
  readonly engine: EngineDeps;
  readonly registry: OrderRegistry;
  /** iyzico account secret (env IYZICO_SECRET_KEY; WEBHOOK_SIGNING_SECRET defaults to it). Non-empty. */
  readonly webhookSigningSecret: string;
}

function optStr(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' ? v : undefined;
}

function headerStr(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

export function createApp(deps: AppDeps): FastifyInstance {
  if (typeof deps.webhookSigningSecret !== 'string' || deps.webhookSigningSecret.length === 0) {
    throw new Error('createApp: webhookSigningSecret must be a non-empty string');
  }
  const { engine, registry, webhookSigningSecret } = deps;
  const orderLocks = new KeyedMutex();
  const app = Fastify({ bodyLimit: 1024 * 1024 });

  // POST /intent — the fail-closed ① gate. A rejected intent consumes NO sequence and starts NO order.
  app.post('/intent', async (request, reply) => {
    const raw = request.body;
    if (typeof raw !== 'object' || raw === null) return reply.code(400).send({ error: 'BadRequest' });
    const body = raw as Record<string, unknown>;
    const orderId = optStr(body, 'orderId');
    const destination = optStr(body, 'destination');
    const amountStr = optStr(body, 'amountStroops');
    const assetIssuer = optStr(body, 'assetIssuer');
    const memoHex = optStr(body, 'memoHex');
    const rateStr = optStr(body, 'appliedRateStroops');
    const paidPriceTry = optStr(body, 'paidPriceTry');
    const currency = optStr(body, 'currency');
    const ip = optStr(body, 'ip');
    if (
      orderId === undefined || orderId.length === 0 || destination === undefined || amountStr === undefined ||
      assetIssuer === undefined || memoHex === undefined || rateStr === undefined || paidPriceTry === undefined ||
      currency === undefined || ip === undefined
    ) {
      return reply.code(400).send({ error: 'BadRequest' });
    }

    let amount: bigint;
    let appliedRate: bigint;
    try {
      amount = BigInt(amountStr);
      appliedRate = BigInt(rateStr);
    } catch {
      return reply.code(400).send({ error: 'BadAmount' });
    }

    let snapshot;
    try {
      snapshot = await engine.stellar.loadDestinationSnapshot(destination);
    } catch {
      return reply.code(502).send({ error: 'SnapshotUnavailable' });
    }

    const built = PayoutIntent.build(
      { orderId, destination, amount, assetIssuer, memo: memoHex },
      { snapshot, allowedIssuers: [engine.config.stellar.usdcIssuer] },
    );
    if (!built.ok) return reply.code(400).send({ error: built.error }); // fail-closed ①: no seq, no order

    const ids = built.value.fields.ids;
    const seq = engine.store.sequences.allocate(orderId);
    const ctx: OrderCtx = {
      orderId,
      conversationId: ids.idempotencyKeyHex,
      destination,
      amountStroops: amount,
      appliedRateStroops: appliedRate,
      memoHex: ids.memoHex,
      paymentId: null,
      token: null,
      paidPriceTry,
      currency,
      ip,
      activeSeq: seq.toString(),
      hashHex: null,
      signedXdr: null,
      deadRetries: 0,
      captureRetries: 0,
    };
    // pre-lock: register the conversationId -> orderId index so a webhook can find the order. GUARD against
    // clobbering an already-started order — a duplicate/retried /intent must not reset its persisted token
    // (which would later brick the legit webhook via tokenMismatch).
    if (registry.getByOrderId(orderId) === undefined) registry.put(ctx, 'Reserved');

    const outcome = await orderLocks.run(orderId, async () => {
      const result = await start(ctx, engine);
      if (result.quiescence === 'alreadyStarted') {
        // idempotent duplicate: return the ALREADY-persisted checkout token; never overwrite the live record.
        return { kind: 'alreadyStarted' as const, token: registry.getByOrderId(orderId)?.ctx.token ?? null };
      }
      const checkout = result.sideOutputs.find((s) => s.kind === 'checkoutForm');
      const finalCtx: OrderCtx = checkout !== undefined ? { ...result.ctx, token: checkout.token } : result.ctx;
      registry.put(finalCtx, result.state); // in-lock single-writer
      return { kind: 'started' as const, quiescence: result.quiescence, checkout };
    });

    if (outcome.kind === 'alreadyStarted') {
      if (outcome.token === null) return reply.code(409).send({ error: 'AlreadyStarted' });
      return reply.send({ orderId, token: outcome.token, alreadyStarted: true });
    }
    if (outcome.quiescence === 'escalated') return reply.code(502).send({ error: 'CheckoutInitFailed' });
    if (outcome.checkout === undefined) return reply.code(502).send({ error: 'NoCheckout' });
    return reply.send({
      orderId,
      token: outcome.checkout.token,
      checkoutFormContent: outcome.checkout.formContent,
    });
  });

  // GET /status/:orderId — coarse public status; NEVER the internal crypto state.
  app.get('/status/:orderId', async (request, reply) => {
    const params = request.params as { orderId?: string };
    const orderId = params.orderId;
    if (typeof orderId !== 'string' || orderId.length === 0) return reply.code(400).send({ error: 'BadRequest' });
    const rec = registry.getByOrderId(orderId);
    if (rec === undefined) return reply.code(404).send({ error: 'NotFound' });
    return reply.send({ orderId, status: toPublicStatus(rec.state) });
  });

  // POST /webhook — SPIKE-4 money gate. verify FIRST; bounded body so a forged request only pays a small parse.
  app.post('/webhook', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const raw = request.body;
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const iyziPaymentId = optStr(body, 'iyziPaymentId');
    const paymentId = optStr(body, 'paymentId');
    const token = optStr(body, 'token');
    const conv = optStr(body, 'paymentConversationId');
    const status = optStr(body, 'status');
    const event: WebhookEvent = {
      iyziEventType: optStr(body, 'iyziEventType') ?? '',
      ...(iyziPaymentId !== undefined ? { iyziPaymentId } : {}),
      ...(paymentId !== undefined ? { paymentId } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(conv !== undefined ? { paymentConversationId: conv } : {}),
      ...(status !== undefined ? { status } : {}),
    };

    const sig = headerStr(request.headers['x-iyz-signature-v3']);
    if (!verifyWebhookSignature({ signingSecret: webhookSigningSecret, event, providedSignature: sig })) {
      return reply.code(401).send({ error: 'BadSignature' }); // <-- money gate; zero side effects on false
    }

    // --- authenticated past this line ---
    const rec = conv !== undefined ? registry.getByConversationId(conv) : undefined;
    if (rec === undefined || conv === undefined) return reply.code(404).send({ error: 'UnknownOrder' });
    const orderId = rec.ctx.orderId;

    const eventId = `${event.iyziEventType}:${conv}:${iyziPaymentId ?? paymentId ?? token ?? ''}:${status ?? ''}`;
    const seen = await engine.store.markWebhookSeen(eventId, orderId, engine.clock.nowUnix() * 1000);
    if (seen === 'duplicate') return reply.send({ status: 'duplicate' }); // replay guard (after verify)

    const result = await orderLocks.run(orderId, async () => {
      const current = registry.getByConversationId(conv) ?? rec;
      // idempotent: only the preauth-pending state consumes a CHECKOUT_FORM_AUTH; anything else is a no-op.
      if (current.state !== 'Reserved') return { status: 'noop' as const };
      // the webhook-echoed token must match the backend-issued one; re-retrieve by the PERSISTED token.
      if (current.ctx.token === null || event.token !== current.ctx.token) {
        return { status: 'tokenMismatch' as const };
      }
      const retrieved = await engine.psp.retrieveCheckoutFormResult({ conversationId: conv, token: current.ctx.token });
      const proj = projectCheckoutFormResult(retrieved);
      if (proj.kind === 'ok' && proj.conversationId !== conv) return { status: 'convMismatch' as const };
      const patchedCtx: OrderCtx = proj.kind === 'ok' ? { ...current.ctx, paymentId: proj.paymentId } : current.ctx;
      const r = await advance(patchedCtx, 'Reserved', preauthEvent(retrieved), engine);
      registry.put(r.ctx, r.state); // in-lock single-writer
      return { status: 'ok' as const, quiescence: r.quiescence };
    });

    return reply.send(result);
  });

  return app;
}
