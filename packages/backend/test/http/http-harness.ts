// HTTP integration harness: the real InMemoryStore + engine fakes + the Fastify app, plus helpers to build a
// valid /intent body and a correctly V3-signed webhook. Uses the REAL store (solvency reserve, markWebhookSeen,
// sequences) so the inject tests exercise the whole composition, not stubs.

import { createHmac } from 'node:crypto';
import { deriveIds, deriveMemo } from '@troia/core';
import type { FastifyInstance } from 'fastify';
import { quoteUsdc } from '../../../pricing/src/index.js';
import { createApp } from '../../src/http/app.js';
import type { QuoteFn } from '../../src/http/app.js';
import { InMemoryOrderRegistry } from '../../src/http/order-registry.js';
import { InMemoryStore } from '../../src/store/in-memory-store.js';
import { FakeClock, FakePspPort, FakeStellarPort, makeConfig } from '../fakes/harness.js';
import type { Trace } from '../fakes/harness.js';

export const WEBHOOK_SECRET = 'iyz-test-secret';
const UNIT = 10_000_000n; // 1 USDC @ 7 decimals
export const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'; // valid ed25519 strkey
export const AMOUNT = UNIT; // 1 USDC per order
export const CHECKOUT_TOKEN = 'tok-1'; // the fake initializeCheckoutForm issues this token

// Server-side pricing seam: a fixed spot mid + the doc's calm-regime stats + a T+15 commission (-> 229 bps).
// In production the mid comes from a live rate source and the stats from computeReturnStats(6-month closes);
// here they are fixed so the priced order is deterministic. quoteUsdc(1 USDC) -> paidPriceTry "41.42".
export const MID_E7 = 405_000_000n; // 40.50 TRY/USDC
const STATS = { muDaily: 0.00055, sigmaDaily: 0.003 };
const COMMISSION = { valorDays: 15, z: 1, marginBps: 30 };
/** The backend's Quote seam also carries the accounting split the ledger books. These fixtures price without a
 *  PSP pass-through (pspCostKurus 0), so the whole margin is FX-risk revenue and the charged price is unchanged. */
export const quote: QuoteFn = async (usdcStroops) => ({
  ...quoteUsdc(usdcStroops, MID_E7, STATS, COMMISSION),
  pspCostKurus: 0n,
});

export interface HttpHarness {
  readonly app: FastifyInstance;
  readonly store: InMemoryStore;
  readonly stellar: FakeStellarPort;
  readonly psp: FakePspPort;
  readonly clock: FakeClock;
  readonly registry: InMemoryOrderRegistry;
  readonly trace: Trace;
}

export function makeHttpHarness(balanceUnits = 100n, quoteFn: QuoteFn = quote): HttpHarness {
  const trace: Trace = [];
  const stellar = new FakeStellarPort(trace);
  const psp = new FakePspPort(trace);
  const clock = new FakeClock();
  const config = makeConfig();
  const store = new InMemoryStore({ balanceStroops: balanceUnits * UNIT, baseSeq: 1000n });
  const registry = new InMemoryOrderRegistry();
  const app = createApp({
    engine: { stellar, psp, store, clock, config },
    registry,
    quote: quoteFn,
    webhookSigningSecret: WEBHOOK_SECRET,
  });
  return { app, store, stellar, psp, clock, registry, trace };
}

/**
 * A brand-new process against the same durable evidence. The order registry is memory and does not come back; the
 * evidence log replays exactly as `buildDurableBundle` replays it at boot. Everything else is fresh.
 */
export function restartHttpHarness(prev: HttpHarness, balanceUnits = 100n): HttpHarness {
  const trace: Trace = [];
  const stellar = new FakeStellarPort(trace);
  const psp = new FakePspPort(trace);
  const clock = new FakeClock();
  const config = makeConfig();
  const store = new InMemoryStore({
    balanceStroops: balanceUnits * UNIT,
    baseSeq: 1000n,
    seedEvidence: prev.store.evidenceRecords(),
  });
  const registry = new InMemoryOrderRegistry(); // the restart's whole point: this is empty
  const app = createApp({
    engine: { stellar, psp, store, clock, config },
    registry,
    quote,
    webhookSigningSecret: WEBHOOK_SECRET,
  });
  return { app, store, stellar, psp, clock, registry, trace };
}

export function intentBody(orderId: string): Record<string, string> {
  // NOTE: no appliedRateStroops / paidPriceTry — the backend prices the order server-side (deps.quote).
  return {
    orderId,
    destination: DEST,
    amountStroops: AMOUNT.toString(),
    assetIssuer: 'GISSUER',
    memoHex: Buffer.from(deriveMemo(orderId)).toString('hex'),
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
  const pre =
    secret + e.iyziEventType + e.iyziPaymentId + e.token + e.paymentConversationId + e.status;
  return createHmac('sha256', secret).update(pre).digest('hex');
}
