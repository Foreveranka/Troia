// HTTP integration harness: the real InMemoryStore + engine fakes + the Fastify app, plus helpers to build a
// valid /intent body and a correctly V3-signed webhook. Uses the REAL store (solvency reserve, markWebhookSeen,
// sequences) so the inject tests exercise the whole composition, not stubs.

import { createHmac } from 'node:crypto';
import { deriveIds, deriveMemo } from '@troia/core';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/http/app.js';
import { InMemoryOrderRegistry } from '../../src/http/order-registry.js';
import { InMemoryStore } from '../../src/store/in-memory-store.js';
import { FakeClock, FakePspPort, FakeStellarPort, makeConfig } from '../fakes/harness.js';
import type { Trace } from '../fakes/harness.js';

export const WEBHOOK_SECRET = 'iyz-test-secret';
const UNIT = 10_000_000n; // 1 USDC @ 7 decimals
export const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'; // valid ed25519 strkey
export const AMOUNT = UNIT; // 1 USDC per order
export const CHECKOUT_TOKEN = 'tok-1'; // the fake initializeCheckoutForm issues this token

export interface HttpHarness {
  readonly app: FastifyInstance;
  readonly store: InMemoryStore;
  readonly stellar: FakeStellarPort;
  readonly psp: FakePspPort;
  readonly clock: FakeClock;
  readonly registry: InMemoryOrderRegistry;
  readonly trace: Trace;
}

export function makeHttpHarness(balanceUnits = 100n): HttpHarness {
  const trace: Trace = [];
  const stellar = new FakeStellarPort(trace);
  const psp = new FakePspPort(trace);
  const clock = new FakeClock();
  const config = makeConfig();
  const store = new InMemoryStore({ balanceStroops: balanceUnits * UNIT, baseSeq: 1000n });
  const registry = new InMemoryOrderRegistry();
  const app = createApp({ engine: { stellar, psp, store, clock, config }, registry, webhookSigningSecret: WEBHOOK_SECRET });
  return { app, store, stellar, psp, clock, registry, trace };
}

export function intentBody(orderId: string): Record<string, string> {
  return {
    orderId,
    destination: DEST,
    amountStroops: AMOUNT.toString(),
    assetIssuer: 'GISSUER',
    memoHex: Buffer.from(deriveMemo(orderId)).toString('hex'),
    appliedRateStroops: '340000000',
    paidPriceTry: '3400.00',
    currency: 'TRY',
    ip: '1.2.3.4',
  };
}

export function convOf(orderId: string): string {
  return deriveIds(orderId, DEST, AMOUNT).idempotencyKeyHex;
}

export interface HppEvent {
  iyziEventType: string;
  iyziPaymentId: string;
  token: string;
  paymentConversationId: string;
  status: string;
}

export function webhookEvent(orderId: string, overrides: Partial<HppEvent> = {}): HppEvent {
  return {
    iyziEventType: 'CHECKOUT_FORM_AUTH',
    iyziPaymentId: 'iyzi-pay-1',
    token: CHECKOUT_TOKEN,
    paymentConversationId: convOf(orderId),
    status: 'SUCCESS',
    ...overrides,
  };
}

/** The HPP V3 preimage: secret + iyziEventType + iyziPaymentId + token + paymentConversationId + status. */
export function signV3(secret: string, e: HppEvent): string {
  const pre = secret + e.iyziEventType + e.iyziPaymentId + e.token + e.paymentConversationId + e.status;
  return createHmac('sha256', secret).update(pre).digest('hex');
}
