import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/http/app.js';
import { InMemoryOrderRegistry } from '../../src/http/order-registry.js';
import { InMemoryStore } from '../../src/store/in-memory-store.js';
import { KeyedMutex } from '../../src/store/mutex.js';
import { pollInFlight } from '../../src/worker/poll-worker.js';
import { advance } from '../../src/engine/driver.js';
import type {
  BankTransferInstructions,
  BankTransferObservation,
  BankTransferProvider,
  BankTransferRequest,
} from '../../src/bank-transfer.js';
import {
  FakeClock,
  FakePspPort,
  FakeStellarPort,
  makeConfig,
  makeCtx,
  makeHarness,
} from '../fakes/harness.js';
import { intentBody, quote, signV3, webhookEvent, WEBHOOK_SECRET } from './http-harness.js';
import { bankTransferReference } from '../../src/bank-transfer.js';

// Test fixture only. Never wired into the server or the downloadable extension.
class FakeBank implements BankTransferProvider {
  creates: BankTransferRequest[] = [];
  transfers = new Map<string, BankTransferInstructions>();
  observation: Partial<BankTransferObservation> = {};
  createTimeout = false;
  retrieveTimeout = false;
  refunds = 0;
  refundResult: 'refunded' | 'pending' = 'refunded';
  async create(req: BankTransferRequest): Promise<BankTransferInstructions> {
    this.creates.push(req);
    const details = this.transfers.get(req.orderId) ?? {
      providerId: 'test-only',
      transferId: `transfer-${req.orderId}`,
      orderId: req.orderId,
      reference: req.reference,
      iban: 'TR330006100519786457841326',
      beneficiary: 'Test Provider',
      amountTry: req.amountTry,
      currency: 'TRY',
      expiresAtUnix: req.expiresAtUnix,
    };
    this.transfers.set(req.orderId, details);
    if (this.createTimeout) throw new Error('timeout after provider accepted request');
    return details;
  }
  async retrieve(i: BankTransferInstructions): Promise<BankTransferObservation> {
    if (this.retrieveTimeout) throw new Error('timeout');
    return { ...i, status: 'pending', amountTry: '0.00', ...this.observation };
  }
  async refund(): Promise<'refunded' | 'pending'> {
    this.refunds++;
    return this.refundResult;
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function harness(enabled = true, session = false) {
  const trace: string[] = [];
  const stellar = new FakeStellarPort(trace);
  const psp = new FakePspPort(trace);
  const store = new InMemoryStore({ balanceStroops: 1_000_000_000n, baseSeq: 1000n });
  const registry = new InMemoryOrderRegistry();
  const clock = new FakeClock();
  const bank = new FakeBank();
  const engine = {
    stellar,
    psp,
    store,
    clock,
    config: makeConfig(),
    ...(enabled ? { bankTransfer: bank } : {}),
  };
  const locks = new KeyedMutex();
  const app = createApp({
    engine,
    registry,
    quote,
    ...(enabled ? { bankQuote: quote } : {}),
    orderLocks: locks,
    webhookSigningSecret: WEBHOOK_SECRET,
    ...(session ? { intentAuth: { secret: 'session-test' } } : {}),
  });
  apps.push(app);
  const intent = (orderId = 'bank-1') =>
    app.inject({
      method: 'POST',
      url: '/intent',
      payload: { ...intentBody(orderId), paymentMethod: 'bank_transfer' },
    });
  const tick = () => pollInFlight(registry, locks, engine);
  return { app, bank, store, registry, clock, stellar, trace, intent, tick };
}

describe('IBAN merchant checkout', () => {
  it('creates a server-side explanation code, retains it on retries and changes it per purchase', async () => {
    const h = harness();
    const a = (await h.intent('customer-order-a')).json().bankTransfer;
    const b = (await h.intent('customer-order-b')).json().bankTransfer;
    const retry = (await h.intent('customer-order-a')).json().bankTransfer;
    expect(a.reference).toMatch(/^TROIA-[A-F0-9]{32}$/);
    expect(a.reference).toBe(bankTransferReference(h.bank.creates[0].idempotencyKey));
    expect(retry.reference).toBe(a.reference);
    expect(a.reference).not.toBe(b.reference);
  });
  it('fails closed with no provider; no pool reservation, bank details or card checkout', async () => {
    const h = harness(false);
    const res = await h.intent();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'BankTransferUnavailable' });
    expect(h.registry.getByOrderId('bank-1')).toBeUndefined();
    expect(h.store.availableStroops()).toBe(1_000_000_000n);
    expect(h.trace).toEqual([]);
    expect((await h.app.inject('/quote/10000000?paymentMethod=bank_transfer')).statusCode).toBe(
      503,
    );
  });

  it('keeps the session gate for bank intents', async () => {
    const h = harness(true, true);
    expect((await h.intent()).statusCode).toBe(401);
    expect(h.bank.creates).toHaveLength(0);
  });

  it('prices on the server, reserves before issuing details, waits, then sends exactly once after bank verification', async () => {
    const h = harness();
    const res = await h.intent();
    expect(res.statusCode).toBe(200);
    expect(res.json().bankTransfer.amountTry).toBe('41.42');
    expect(res.json().paymentMethod).toBe('bank_transfer');
    expect(res.json().paymentPageUrl).toBeUndefined();
    expect(h.store.availableStroops()).toBe(990_000_000n);
    await h.tick();
    expect(h.stellar.submitReqs).toHaveLength(0);
    expect((await h.app.inject('/receipt/bank-1')).json().txHash).toBeNull();
    h.bank.observation = { status: 'received', amountTry: '41.42', receivedAtUnix: h.clock.now };
    await h.tick();
    await h.tick();
    expect(h.stellar.submitReqs).toHaveLength(1);
    expect((await h.app.inject('/status/bank-1')).json().status).toBe('completed');
    expect((await h.app.inject('/receipt/bank-1')).json().txHash).toBe('hash_bank-1');
    expect(h.trace.some((t) => t.startsWith('psp.'))).toBe(false);
  });

  it('returns frozen instructions on retry, even when no unreserved pool remains', async () => {
    const h = harness();
    const first = (await h.intent()).json();
    await h.store.reserve('other', h.store.availableStroops(), 1000, 0);
    const again = await h.intent();
    expect(again.statusCode).toBe(200);
    expect(again.json().bankTransfer).toEqual(first.bankTransfer);
    expect(h.bank.creates).toHaveLength(1);
    expect(h.bank.transfers.size).toBe(1);
  });

  it('serializes concurrent creation and rejects card/method/recipient changes for an existing order', async () => {
    const h = harness();
    await Promise.all([h.intent(), h.intent()]);
    expect(h.bank.creates).toHaveLength(1);
    const res = await h.app.inject({
      method: 'POST',
      url: '/intent',
      payload: intentBody('bank-1'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('OrderConflict');
    const changed = await h.app.inject({
      method: 'POST',
      url: '/intent',
      payload: {
        ...intentBody('bank-1'),
        paymentMethod: 'bank_transfer',
        amountStroops: '20000000',
      },
    });
    expect(changed.json().error).toBe('OrderConflict');
  });

  it('ignores a valid iyzico webhook for a bank order', async () => {
    const h = harness();
    await h.intent();
    const event = webhookEvent('bank-1', { token: 'transfer-bank-1' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: event,
      headers: { 'x-iyz-signature-v3': signV3(WEBHOOK_SECRET, event) },
    });
    expect(res.statusCode).toBe(409);
    expect(h.stellar.submitReqs).toHaveLength(0);
    expect(h.trace).not.toContain('psp.retrieveCheckoutFormResult');
  });

  it.each([
    { amountTry: '41.41' },
    { amountTry: '41.43' },
    { currency: 'USD' },
    { orderId: 'other-order' },
    { reference: 'OTHER' },
    { transferId: 'other-transfer' },
    { providerId: 'other-provider' },
    { receivedAtUnix: 1_700_001_000 },
    { receivedAtUnix: undefined },
  ])('holds mismatched or late payment for review: %j', async (invalid) => {
    const h = harness();
    await h.intent();
    h.bank.observation = {
      status: 'received',
      amountTry: '41.42',
      receivedAtUnix: h.clock.now,
      ...invalid,
    };
    await h.tick();
    expect(h.stellar.submitReqs).toHaveLength(0);
    expect((await h.app.inject('/status/bank-1')).json().status).toBe('review');
  });

  it('provider outages and local expiry alone never free a possibly paid reservation', async () => {
    const h = harness();
    await h.intent();
    h.clock.now += 100_000;
    h.bank.retrieveTimeout = true;
    await h.tick();
    expect(h.store.availableStroops()).toBe(990_000_000n);
    expect(h.stellar.submitReqs).toHaveLength(0);
  });

  it('closes only when the provider proves final zero funds and returns no payable instructions thereafter', async () => {
    const h = harness();
    await h.intent();
    h.bank.observation = { status: 'expired_unpaid', amountTry: '0.00' };
    await h.tick();
    expect(h.store.availableStroops()).toBe(1_000_000_000n);
    expect((await h.intent()).json().error).toBe('OrderClosed');
    expect(h.stellar.submitReqs).toHaveLength(0);
  });

  it('recovers unknown creation using the same frozen price, expiry and idempotency key', async () => {
    const h = harness();
    h.bank.createTimeout = true;
    expect((await h.intent()).json().error).toBe('BankTransferPreparing');
    h.clock.now += 30;
    h.bank.createTimeout = false;
    await h.tick();
    expect(h.bank.creates[1]).toEqual(h.bank.creates[0]);
    expect(h.bank.transfers.size).toBe(1);
    expect((await h.intent()).json().bankTransfer.reference).toBeTruthy();
  });
});

describe('bank refund never uses card cancellation', () => {
  it.each(['refunded', 'pending'] as const)(
    'confirms only a final bank refund (%s)',
    async (refundResult) => {
      const h = makeHarness();
      const bank = new FakeBank();
      bank.refundResult = refundResult;
      const details = await bank.create({
        orderId: 'refund',
        idempotencyKey: 'refund',
        reference: 'refund-test',
        amountTry: '3400.00',
        currency: 'TRY',
        expiresAtUnix: h.clock.now + 900,
      });
      const ctx = makeCtx(h.store, {
        orderId: 'refund',
        paymentMethod: 'bank_transfer',
        bankTransfer: details,
      });
      const result = await advance(
        ctx,
        'UsdcDead',
        { type: 'deadRetry', retriesRemaining: false },
        { ...h.deps, bankTransfer: bank },
      );
      expect(result.state).toBe(refundResult === 'refunded' ? 'ChargeReversed' : 'LossReview');
      expect(h.trace).not.toContain('psp.cancel');
      expect(bank.refunds).toBe(
        refundResult === 'refunded' ? 1 : h.config.policy.maxReversalRetries + 1,
      );
    },
  );
});

describe('sandbox bank simulation gate', () => {
  it('is unavailable without a sandbox adapter and rejects another order capability', async () => {
    const h = harness();
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/sandbox/bank-transfer/bank-1/simulate',
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
  it('requires a session and the exact durable capability; simulation never itself marks the order paid', async () => {
    const h = harness(true, true);
    let calls = 0;
    Object.assign(h.bank, {
      simulate: async () => {
        calls++;
      },
    });
    const session = (await h.app.inject({ method: 'POST', url: '/session' })).json();
    const headers = { 'x-troia-session': session.token };
    const original = h.bank.create.bind(h.bank);
    h.bank.create = async (req) => ({
      ...(await original(req)),
      providerId: 'tr-mock-anchor',
      sandboxToken: 'a'.repeat(64),
    });
    const response = await h.app.inject({
      method: 'POST',
      url: '/intent',
      headers,
      payload: { ...intentBody('sandbox-1'), paymentMethod: 'bank_transfer' },
    });
    expect(response.statusCode).toBe(200);
    const url = '/sandbox/bank-transfer/sandbox-1/simulate';
    expect(
      (await h.app.inject({ method: 'POST', url, payload: { sandboxToken: 'a'.repeat(64) } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          headers,
          payload: { sandboxToken: 'b'.repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
    expect(calls).toBe(0);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          headers,
          payload: { sandboxToken: 'a'.repeat(64) },
        })
      ).statusCode,
    ).toBe(202);
    expect(calls).toBe(1);
    expect(h.stellar.submitReqs).toHaveLength(0);
    expect((await h.app.inject('/status/sandbox-1')).json().status).toBe('pending');
  });
});
