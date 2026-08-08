// The Fastify HTTP shell + composition. Three routes: POST /intent (money-first: reserve pool -> hosted DIRECT-
// SALE checkout, fail-closed if the pool cannot cover), GET /status/:orderId (coarse public status), POST
// /webhook (iyzico charge result -> submit the USDC leg). The app OWNS the per-order KeyedMutex (single-writer
// per order across intent/webhook/poll) and is handed injected deps (fakes offline; real adapters at 4.4).
//
// WEBHOOK MONEY GATE (SPIKE-4): verifyWebhookSignature is the FIRST thing that runs; a forged/absent signature
// returns 401 with ZERO side effects (no registry/store/psp/engine touch). A valid signature proves only
// AUTHENTICITY — the charge outcome comes from a server-side re-retrieve keyed on the BACKEND-issued token
// (never the webhook-echoed one) plus the state===SolvencyReserved guard, never the webhook's status field.

import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { canonicalizeOrderId, DeriveIdsError, PayoutIntent } from '@troia/core';
import { chargeEvent, projectCheckoutFormResult, verifyWebhookSignature } from '@troia/psp';
import type { WebhookEvent } from '@troia/psp';
import type { OrderCtx } from '../ctx.js';
import { advance, start } from '../engine/driver.js';
import type { EngineDeps } from '../engine/events.js';
import { KeyedMutex } from '../store/mutex.js';
import type { OrderRegistry } from './order-registry.js';
import type { State } from '@troia/core';
import { toPublicStatus } from './public-status.js';
import type { PublicStatus } from './public-status.js';
import {
  DEFAULT_SESSION_MAX_INTENTS,
  DEFAULT_SESSION_TTL_SECS,
  mintSessionToken,
  SessionBudget,
  verifySessionToken,
} from './session.js';

/** The server-side price for one order. Money-first + zero-trust: the BACKEND prices every order (commission +
 *  spot mid), never a client-supplied paidPrice. Shape matches @troia/pricing quoteUsdc; the impl is INJECTED
 *  so the spot-rate source (Yahoo / TCMB / CEX) stays a swappable seam — the backend takes no pricing dep. */
export interface Quote {
  readonly userTryKurus: bigint;
  readonly paidPriceTry: string; // canonical "N.MM" TRY — the hosted-sale price
  readonly appliedRateStroops: bigint; // applied TRY/USDC rate × 1e7 (recorded on-chain in pay())
  readonly oracleMidE7: bigint;
  readonly spreadBps: number; // the commission, in basis points
  /** The FX-risk margin in kuruş. Frozen with the price so the ledger books the margin actually charged. */
  readonly spreadRevenueKurus: bigint;
  /** The PSP cost baked into the price, in kuruş — a separate legible line (ADR-4), booked as an expense. */
  readonly pspCostKurus: bigint;
}
export type QuoteFn = (usdcStroops: bigint) => Promise<Quote>;

export interface AppDeps {
  readonly engine: EngineDeps;
  readonly registry: OrderRegistry;
  /** prices an order server-side (commission model + spot mid). Injected so the rate source stays a seam. */
  readonly quote: QuoteFn;
  /** iyzico account secret (env IYZICO_SECRET_KEY; WEBHOOK_SIGNING_SECRET defaults to it). Non-empty. */
  readonly webhookSigningSecret: string;
  /** the SHARED per-order lock. The composition root (createServer) passes the SAME instance to the poll
   *  worker so intent/webhook/poll serialize per order — without sharing, two overlapping drives of one order
   *  could double-submit a same-seq USDC replacement. Defaults to a private lock when omitted (standalone app). */
  readonly orderLocks?: KeyedMutex;
  /** per-IP cap on POST /intent. Omitted -> DEFAULT_INTENT_RATE_LIMIT. Tests inject a tiny cap. */
  readonly rateLimit?: IntentRateLimit;
  /** per-IP cap on GET /quote. Omitted -> DEFAULT_QUOTE_RATE_LIMIT. Tests inject a tiny cap. */
  readonly quoteRateLimit?: IntentRateLimit;
  /** C-13: when present, POST /session mints short-lived tokens and POST /intent requires one (401 without),
   *  with accepted NEW orders counted against a per-session budget (429 when spent). Omitted -> /intent stays
   *  open exactly as before (the offline suite's default); the durable deployment always wires this. */
  readonly intentAuth?: IntentAuthConfig;
}

/** Configuration for the /intent session gate (C-13). The secret may be per-boot random: verification is
 *  stateless, so a restart only forces clients through one extra /session round-trip. */
export interface IntentAuthConfig {
  readonly secret: string;
  readonly ttlSecs?: number; // default DEFAULT_SESSION_TTL_SECS
  readonly maxIntentsPerSession?: number; // default DEFAULT_SESSION_MAX_INTENTS
  /** per-IP cap on POST /session. Omitted -> DEFAULT_SESSION_RATE_LIMIT. */
  readonly sessionRateLimit?: IntentRateLimit;
}

/** 10 sessions/min per IP: an honest client needs ONE per 15 minutes; a farm burns its IP budget fast. */
export const DEFAULT_SESSION_RATE_LIMIT: IntentRateLimit = { max: 10, timeWindowMs: 60_000 };

/** A per-IP request cap for the one expensive money-path route, POST /intent. */
export interface IntentRateLimit {
  readonly max: number;
  readonly timeWindowMs: number;
}

/** The public-deploy default: 20 intents per minute per IP. An honest checkout (with the extension's own
 *  double-submit guard) stays well under it; a single-source flood is capped. NOT sized to stop a distributed
 *  reservation-exhaustion DoS — rotating IPs each spend a few requests and never trip a per-IP cap; that hazard
 *  is named in KNOWN_ISSUES and closed by a reservation budget, not by this. */
export const DEFAULT_INTENT_RATE_LIMIT: IntentRateLimit = { max: 20, timeWindowMs: 60_000 };

/** GET /quote runs the SAME live-oracle pricing as /intent but reserves nothing, so it is cheaper — yet it still
 *  hits the upstream rate source on EVERY call, so it must stay bounded (an unthrottled public /quote is a free
 *  amplifier to hammer the oracle and fail-close real pricing). 30/min per IP: generous for one preview per checkout. */
export const DEFAULT_QUOTE_RATE_LIMIT: IntentRateLimit = { max: 30, timeWindowMs: 60_000 };

/** i128 upper bound — the amount ceiling PayoutIntent.build enforces. A quote must never price a value the charge
 *  would reject, and this also guards @troia/pricing's RangeError on a non-positive amount. */
const I128_MAX = 2n ** 127n - 1n;

function optStr(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' ? v : undefined;
}

// canonicalizeOrderId THROWS on a malformed order id (a lone UTF-16 surrogate — derive-ids.ts). With no Fastify
// error handler installed, that throw becomes a 500 that leaks the internal exception message, on what is really a
// client input error. Fail closed at the trust boundary instead: return null for a malformed id so the caller
// answers a clean 400 {error:'OrderIdMalformed'} — the SAME code PayoutIntent.build already returns for it, so the
// API is uniform whether the id is rejected here or one step later at build. Any other throw is a real fault and
// still propagates. Money-safe: this only reshapes an error response; it is upstream of any seq/reserve/charge.
function tryCanonicalizeOrderId(rawOrderId: string): string | null {
  try {
    return canonicalizeOrderId(rawOrderId);
  } catch (e) {
    if (e instanceof DeriveIdsError && e.code === 'OrderIdNotWellFormed') return null;
    throw e;
  }
}

function headerStr(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

// The buyer IP is derived server-side (zero-trust — never the client's self-reported value, same principle as
// the server-fixed price/currency). With trustProxy, request.ip is the real customer IP behind the tunnel/proxy
// in production. A local-dev source is loopback/private (which iyzico would reject as a buyer IP), so it falls
// back to a fixed demo public IP purely so the sandbox checkout form still initializes.
const DEV_FALLBACK_BUYER_IP = '85.34.78.112';

function isPrivateOrLoopback(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('::ffff:127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('fc') ||
    ip.startsWith('fd')
  );
}

function buyerIpOf(request: FastifyRequest): string {
  const ip = request.ip;
  if (typeof ip !== 'string' || ip.length === 0 || isPrivateOrLoopback(ip))
    return DEV_FALLBACK_BUYER_IP;
  return ip;
}

export function createApp(deps: AppDeps): FastifyInstance {
  if (typeof deps.webhookSigningSecret !== 'string' || deps.webhookSigningSecret.length === 0) {
    throw new Error('createApp: webhookSigningSecret must be a non-empty string');
  }
  const { engine, registry, webhookSigningSecret } = deps;
  const orderLocks = deps.orderLocks ?? new KeyedMutex(); // load-bearing: the composition shares ONE instance
  // trustProxy: request.ip honors X-Forwarded-For behind the tunnel/proxy, so the server-derived buyer IP is the
  // real customer IP in production (the buyer IP is only iyzico's fraud-score field, so trusting the proxy hop
  // here carries no auth/money authority).
  const app = Fastify({ bodyLimit: 1024 * 1024, trustProxy: true });

  // Rate limiting is opt-in per route (`global: false`), and only POST /intent opts in — it is the one route that
  // reserves the pool and initializes a hosted charge, so it is the one worth defending; GET /status is polled every
  // 3s by the extension and must never be throttled. The counter is in-memory, i.e. PER PROCESS — consistent with
  // the single-backend-process constraint (KNOWN_ISSUES); a second process would keep its own count. The key is
  // request.ip, which under trustProxy honors X-Forwarded-For: behind a proxy that sets and sanitizes XFF this is the
  // real client, but on a direct public exposure a client can spoof XFF and rotate the key. So this bounds a naive
  // single-source flood; it is not a defense against a distributed or XFF-spoofing attacker.
  const intentLimit = deps.rateLimit ?? DEFAULT_INTENT_RATE_LIMIT;
  const quoteLimit = deps.quoteRateLimit ?? DEFAULT_QUOTE_RATE_LIMIT;
  app.register(rateLimit, {
    global: false,
    // keep the { error } shape the other routes return; statusCode is required here or the reply falls back to 500.
    errorResponseBuilder: () => ({ statusCode: 429, error: 'RateLimited' }),
  });

  // iyzico posts the customer's BROWSER to the checkout callbackUrl (the /return landing page below) as
  // application/x-www-form-urlencoded. Fastify has no default parser for that content type, so register a
  // permissive one (keep the raw string, never fail) — otherwise the browser redirect would 415. The landing page
  // ignores the body, and no money route relies on this parser (/intent + /webhook send application/json).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // C-13 session gate state. Verification is stateless (HMAC); only the budget counter lives here.
  const intentAuth = deps.intentAuth;
  const sessionTtlSecs = intentAuth?.ttlSecs ?? DEFAULT_SESSION_TTL_SECS;
  const sessionBudget =
    intentAuth === undefined
      ? null
      : new SessionBudget(intentAuth.maxIntentsPerSession ?? DEFAULT_SESSION_MAX_INTENTS);

  // POST /intent — the fail-closed ① gate. A rejected intent consumes NO sequence and starts NO order.
  const handleIntent = async (request: FastifyRequest, reply: FastifyReply) => {
    // C-13: the session gate runs FIRST — before any parse-derived work — so a tokenless caller costs one
    // header check and nothing else. One uniform 401 for missing/malformed/expired: the caller's remedy is
    // identical (fetch a fresh /session), and an attacker learns nothing about which check tripped.
    let session = null;
    if (intentAuth !== undefined) {
      const header = headerStr(request.headers['x-troia-session']);
      session =
        header === null
          ? null
          : verifySessionToken(intentAuth.secret, header, engine.clock.nowUnix());
      if (session === null) return reply.code(401).send({ error: 'SessionRequired' });
    }
    const raw = request.body;
    if (typeof raw !== 'object' || raw === null)
      return reply.code(400).send({ error: 'BadRequest' });
    const body = raw as Record<string, unknown>;
    const rawOrderId = optStr(body, 'orderId');
    const destination = optStr(body, 'destination');
    const amountStr = optStr(body, 'amountStroops');
    const assetIssuer = optStr(body, 'assetIssuer');
    const memoHex = optStr(body, 'memoHex');
    // The buyer IP is derived server-side from the request (never the client's self-reported value), so a client
    // cannot dictate the fraud-check IP and it works on any machine. Likewise appliedRateStroops / paidPriceTry /
    // currency are NOT read from the body — the backend PRICES the order in its OWN (TRY) currency via deps.quote,
    // so a client can never dictate what it pays NOR the currency it is charged in. Such body fields are ignored.
    const ip = buyerIpOf(request);
    if (
      rawOrderId === undefined ||
      rawOrderId.length === 0 ||
      destination === undefined ||
      amountStr === undefined ||
      assetIssuer === undefined ||
      memoHex === undefined
    ) {
      return reply.code(400).send({ error: 'BadRequest' });
    }
    // Canonicalize the orderId at the trust boundary (derive-ids.ts contract): the SequenceAllocator keys on the
    // canonical (NFC) form, so the lock / registry / store / reservation MUST too — else two NFC-equivalent but
    // byte-different orderIds collapse to one sequence yet split into two locks/orders/reservations/forms
    // (a double pool-reserve + a second charge surface). One identity for every per-order guard.
    const orderId = tryCanonicalizeOrderId(rawOrderId);
    if (orderId === null) return reply.code(400).send({ error: 'OrderIdMalformed' }); // fail-closed ①

    // C-13: one budget unit per NEW order, taken BEFORE the expensive work (snapshot + live-rate quote), so a
    // spent session cannot even farm oracle calls. An idempotent replay of an existing order burns nothing —
    // the extension's retry path stays free. The unit is not refunded on a later 4xx/409: a session throwing
    // rejectable bodies at the gate is exactly what the budget should be counting.
    if (
      sessionBudget !== null &&
      session !== null &&
      registry.getByOrderId(orderId) === undefined
    ) {
      if (!sessionBudget.take(session, engine.clock.nowUnix())) {
        return reply.code(429).send({ error: 'SessionBudgetExceeded' });
      }
    }

    let amount: bigint;
    try {
      amount = BigInt(amountStr);
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

    // money-first circuit-breaker (HARD gate): never allocate a seq / start an order the pool cannot cover, so
    // the customer is never charged for USDC we cannot deliver. Best-effort fast-fail; reserve() inside start()
    // is the authoritative atomic gate (a race that slips past here still fails closed at the reserve).
    if (engine.store.availableStroops() < amount) {
      return reply.code(409).send({ error: 'PoolInsufficient' }); // fail-closed ①: no seq, no order, no charge
    }

    // money-first + zero-trust pricing: the backend prices the order (commission + spot mid), never the client.
    // Fail CLOSED if pricing is unavailable (e.g. a live rate source is down) — before any seq/order, so a
    // priced order is only ever started when we actually know its price.
    let quote: Quote;
    try {
      quote = await deps.quote(amount);
    } catch {
      return reply.code(502).send({ error: 'PriceUnavailable' });
    }

    const ids = built.value.fields.ids;
    // Late allocation (Approach B): NO operator seq is handed out at /intent. A reserved-but-never-charged
    // (abandoned) order must hold no seq, so the sequence is allocated later, on chargeOk (the first step of
    // the USDC leg). This keeps the operator sequence space gap-free regardless of how many orders abandon.
    const ctx: OrderCtx = {
      orderId,
      conversationId: ids.idempotencyKeyHex,
      destination,
      amountStroops: amount,
      appliedRateStroops: quote.appliedRateStroops,
      memoHex: ids.memoHex,
      paymentId: null,
      token: null,
      paymentPageUrl: null,
      paidPriceTry: quote.paidPriceTry,
      // The customer paid (USDC valued at mid) + FX margin + PSP cost. Freeze that split alongside the price,
      // so the ledger books exactly what was charged rather than a later, differently-rounded re-derivation.
      spreadKurus: quote.spreadRevenueKurus + quote.pspCostKurus,
      feeKurus: quote.pspCostKurus,
      currency: engine.config.psp.currency, // server-fixed (TRY), never the client's
      ip,
      activeSeq: null,
      channelPublic: null,
      hashHex: null,
      signedXdr: null,
      payMaxTimeUnix: null,
      deadRetries: 0,
      reversalRetries: 0,
    };
    // pre-lock: register the conversationId -> orderId index so a webhook can find the order. GUARD against
    // clobbering an already-started order — a duplicate/retried /intent must not reset its persisted token
    // (which would later brick the legit webhook via tokenMismatch).
    if (registry.getByOrderId(orderId) === undefined) registry.put(ctx, 'Reserved');

    const outcome = await orderLocks.run(orderId, async () => {
      const result = await start(ctx, engine);
      if (result.quiescence === 'alreadyStarted') {
        // idempotent duplicate: return the ALREADY-persisted token + the ORIGINAL price; never re-price or clobber.
        const existing = registry.getByOrderId(orderId)?.ctx;
        return {
          kind: 'alreadyStarted' as const,
          token: existing?.token ?? null,
          paidPriceTry: existing?.paidPriceTry ?? null,
          paymentPageUrl: existing?.paymentPageUrl ?? null,
        };
      }
      const checkout = result.sideOutputs.find((s) => s.kind === 'checkoutForm');
      const finalCtx: OrderCtx =
        checkout !== undefined
          ? {
              ...result.ctx,
              token: checkout.token,
              paymentPageUrl: checkout.paymentPageUrl ?? null,
            }
          : result.ctx;
      registry.put(finalCtx, result.state); // in-lock single-writer
      return { kind: 'started' as const, quiescence: result.quiescence, checkout };
    });

    if (outcome.kind === 'alreadyStarted') {
      if (outcome.token === null) return reply.code(409).send({ error: 'AlreadyStarted' });
      // Re-present the SAME hosted form on a duplicate click (the extension reopens it when paymentPageUrl is set).
      return reply.send({
        orderId,
        token: outcome.token,
        alreadyStarted: true,
        paidPriceTry: outcome.paidPriceTry,
        paymentPageUrl: outcome.paymentPageUrl ?? undefined,
      });
    }
    if (outcome.checkout === undefined) {
      // no form issued: the atomic reserve lost a race with the gate, the reserve was unknown, or the form init
      // malformed. All are fail-closed (nothing charged) and transient — the storefront may retry.
      return reply.code(503).send({ error: 'CheckoutUnavailable' });
    }
    // low-water WARNING (money-first "uyar"): surface a low pool so the storefront can warn before it empties.
    const poolLow = engine.store.availableStroops() <= engine.config.policy.poolLowWatermarkStroops;
    return reply.send({
      orderId,
      token: outcome.checkout.token,
      checkoutFormContent: outcome.checkout.formContent,
      paymentPageUrl: outcome.checkout.paymentPageUrl, // iyzico's hosted card page — the extension opens it in a new tab
      paidPriceTry: quote.paidPriceTry, // the server-computed price (the user is charged EXACTLY this)
      spreadBps: quote.spreadBps, // the commission bps, for storefront transparency
      poolLow,
    });
  };

  // GET /quote/:amountStroops — a read-only price PREVIEW. It runs the SAME deps.quote the charge uses (so the shown
  // TL equals what /intent will charge, modulo rate drift), but creates NO order, NO reservation, NO hosted form, and
  // NO sequence — it is strictly the pricing subset of /intent. A quote is a preview, never a commitment.
  const handleQuote = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { amountStroops?: string };
    const amountStr = params.amountStroops;
    if (typeof amountStr !== 'string' || amountStr.length === 0)
      return reply.code(400).send({ error: 'BadRequest' });
    let amount: bigint;
    try {
      amount = BigInt(amountStr);
    } catch {
      return reply.code(400).send({ error: 'BadAmount' });
    }
    // Same amount rule as PayoutIntent.build — a preview must never price a value the charge would reject; this also
    // guards @troia/pricing's RangeError on a non-positive amount.
    if (amount <= 0n || amount > I128_MAX) return reply.code(400).send({ error: 'BadAmount' });
    let quote: Quote;
    try {
      quote = await deps.quote(amount);
    } catch {
      // fail-closed: a rate-feed outage shows NO price rather than a fabricated one (the same 502 /intent uses).
      return reply.code(502).send({ error: 'PriceUnavailable' });
    }
    // ONLY the two customer-facing pricing fields — /quote creates no order, so it returns no order fields.
    return reply.send({ paidPriceTry: quote.paidPriceTry, spreadBps: quote.spreadBps });
  };

  // Register /intent inside after(): the rate-limit plugin installs its per-route hook when it LOADS, which — for a
  // synchronous factory that does not await register — happens after this function returns. A route added before then
  // is invisible to that hook and silently unlimited. after() defers this one registration until the plugin is ready;
  // the routes below carry no limit, so they stay synchronous.
  app.after(() => {
    app.post(
      '/intent',
      { config: { rateLimit: { max: intentLimit.max, timeWindow: intentLimit.timeWindowMs } } },
      handleIntent,
    );
    // /quote joins /intent inside after() so its per-route rate-limit hook attaches — a read-only preview, but it
    // hits the live oracle on every call, so it must not be silently unlimited.
    app.get(
      '/quote/:amountStroops',
      { config: { rateLimit: { max: quoteLimit.max, timeWindow: quoteLimit.timeWindowMs } } },
      handleQuote,
    );
    // POST /session (C-13) — mints the short-lived token /intent requires. Cheap (one HMAC, no I/O), but
    // per-IP limited so a session farm burns its IP budget quickly; the real defense is that each session's
    // intent budget is small and the token expires.
    if (intentAuth !== undefined) {
      const sessionLimit = intentAuth.sessionRateLimit ?? DEFAULT_SESSION_RATE_LIMIT;
      app.post(
        '/session',
        {
          config: {
            rateLimit: { max: sessionLimit.max, timeWindow: sessionLimit.timeWindowMs },
          },
        },
        async (_request, reply) => {
          const minted = mintSessionToken(
            intentAuth.secret,
            engine.clock.nowUnix(),
            sessionTtlSecs,
          );
          return reply.send({ token: minted.token, expiresAtUnix: minted.claims.expUnix });
        },
      );
    }
  });

  // GET /status/:orderId — coarse public status; NEVER the internal crypto state.
  /**
   * The coarse status of an order, with the quarantine override.
   *
   * `toPublicStatus` is total over the 12 States and stays that way. But `applyEscalate` records a loss flag and
   * has NO core event to transition on, so a quarantined order keeps an in-flight State — one that maps to
   * `processing`. A charged order whose USDC fate is genuinely unknown must never keep telling the customer
   * "confirming…": it is waiting on a human, and that is exactly what `review` means.
   *
   * The override is safe because a quarantine is one-way. Nothing can advance such an order behind the flag: the
   * poll worker latches it out of its work-list, the webhook's guard only accepts `SolvencyReserved`, and the live
   * reconciler's work-list is the evidence log — which an order that never reached `UsdcConfirmed` never joined.
   * So `review` is not just correct, it is stable.
   */
  const publicStatusOf = (orderId: string, state: State): PublicStatus =>
    engine.store.isLossFlagged(orderId) ? 'review' : toPublicStatus(state);

  app.get('/status/:orderId', async (request, reply) => {
    const params = request.params as { orderId?: string };
    const rawOrderId = params.orderId;
    if (typeof rawOrderId !== 'string' || rawOrderId.length === 0)
      return reply.code(400).send({ error: 'BadRequest' });
    // key on the same canonical identity /intent registered under; a malformed id is a 400, never a 500 leak
    const orderId = tryCanonicalizeOrderId(rawOrderId);
    if (orderId === null) return reply.code(400).send({ error: 'OrderIdMalformed' });
    const rec = registry.getByOrderId(orderId);
    if (rec !== undefined)
      return reply.send({ orderId, status: publicStatusOf(orderId, rec.state) });
    // The registry is memory, and a restart erases it. The evidence log is not. A row exists only for an order
    // whose USDC leg was witnessed on chain (Store.settledEvidence), so answering from it cannot overstate the
    // case. Derive the status from the map rather than writing 'completed' here, so the two never drift apart.
    // An order still in flight has no row and is still an honest 404 — we genuinely no longer know.
    if (engine.store.settledEvidence(orderId) !== undefined)
      return reply.send({ orderId, status: toPublicStatus('UsdcConfirmed') });
    return reply.code(404).send({ error: 'NotFound' });
  });

  // GET /receipt/:orderId — reviewer-facing PROOF: the settlement pay() tx hash + the TRY charged, once known.
  // Kept SEPARATE from /status (which stays coarse, Track E) so the customer status never leaks the crypto leg;
  // this is the "don't trust us, verify the tx yourself" surface. txHash is null until the USDC pay() has landed.
  app.get('/receipt/:orderId', async (request, reply) => {
    const params = request.params as { orderId?: string };
    const rawOrderId = params.orderId;
    if (typeof rawOrderId !== 'string' || rawOrderId.length === 0)
      return reply.code(400).send({ error: 'BadRequest' });
    const orderId = tryCanonicalizeOrderId(rawOrderId);
    if (orderId === null) return reply.code(400).send({ error: 'OrderIdMalformed' });
    const rec = registry.getByOrderId(orderId);
    if (rec !== undefined)
      return reply.send({
        orderId,
        status: publicStatusOf(orderId, rec.state),
        txHash: rec.ctx.hashHex, // the on-chain USDC pay() witness (null until it lands)
        paidPriceTry: rec.ctx.paidPriceTry,
      });
    // Same reasoning as /status. This is the "verify it yourself" surface, so it is the one that must NOT vanish
    // when the process does: the durable row carries the very hash a reviewer takes to the explorer.
    const settled = engine.store.settledEvidence(orderId);
    if (settled === undefined) return reply.code(404).send({ error: 'NotFound' });
    return reply.send({
      orderId,
      status: toPublicStatus('UsdcConfirmed'),
      txHash: settled.record.txHash,
      paidPriceTry: settled.order.paidPriceTry,
    });
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
    if (
      !verifyWebhookSignature({
        signingSecret: webhookSigningSecret,
        event,
        providedSignature: sig,
      })
    ) {
      return reply.code(401).send({ error: 'BadSignature' }); // <-- money gate; zero side effects on false
    }

    // --- authenticated past this line ---
    const rec = conv !== undefined ? registry.getByConversationId(conv) : undefined;
    if (rec === undefined || conv === undefined)
      return reply.code(404).send({ error: 'UnknownOrder' });
    const orderId = rec.ctx.orderId;

    const eventId = `${event.iyziEventType}:${conv}:${iyziPaymentId ?? paymentId ?? token ?? ''}:${status ?? ''}`;
    const seen = await engine.store.markWebhookSeen(
      eventId,
      orderId,
      engine.clock.nowUnix() * 1000,
    );
    if (seen === 'duplicate') return reply.send({ status: 'duplicate' }); // replay guard (after verify)

    const result = await orderLocks.run(orderId, async () => {
      const current = registry.getByConversationId(conv) ?? rec;
      // idempotent: only the charge-pending state (SolvencyReserved: reserved + form shown) consumes a
      // CHECKOUT_FORM_AUTH; anything else is a no-op.
      if (current.state !== 'SolvencyReserved') return { status: 'noop' as const };
      // the webhook-echoed token must match the backend-issued one; re-retrieve by the PERSISTED token.
      if (current.ctx.token === null || event.token !== current.ctx.token) {
        return { status: 'tokenMismatch' as const };
      }
      const retrieved = await engine.psp.retrieveCheckoutFormResult({
        conversationId: conv,
        token: current.ctx.token,
      });
      const proj = projectCheckoutFormResult(retrieved);
      if (proj.kind === 'ok' && proj.conversationId !== conv)
        return { status: 'convMismatch' as const };
      const patchedCtx: OrderCtx =
        proj.kind === 'ok' ? { ...current.ctx, paymentId: proj.paymentId } : current.ctx;
      // Advance to the IRREVERSIBLE USDC leg ONLY when the projector validated the sale AND extracted a durable
      // paymentId into ctx (needed to void the sale later). A malformed retrieve — even one whose raw looks
      // successful — is chargeUnknown (stay), NEVER a chargeOk with a null paymentId that we could not unwind.
      // chargeEvent then decides: chargeOk submits the USDC leg (money LAST); chargeRejected fails clean;
      // chargeUnknown stays (re-driven by the poll worker's re-retrieve worklist).
      const coreEvent =
        proj.kind === 'ok' ? chargeEvent(retrieved) : { type: 'chargeUnknown' as const };
      const r = await advance(patchedCtx, 'SolvencyReserved', coreEvent, engine);
      registry.put(r.ctx, r.state); // in-lock single-writer
      return { status: 'ok' as const, quiescence: r.quiescence };
    });

    return reply.send(result);
  });

  // GET/POST /return — where the customer's browser lands after paying on the hosted form (iyzico's checkout
  // callbackUrl). It is a friendly landing page ONLY: it verifies nothing and moves no money. Settlement is driven
  // by the poll/recovery worker's authenticated server-side re-retrieve (a PULL keyed on the backend-issued
  // token), so a forged or replayed browser redirect here is inert. (The signed server-to-server /webhook is the
  // deferred instant-notify path; the poll worker is the active, safer settlement path.)
  //
  // It therefore ASSERTS NOTHING about the payment. iyzico redirects the browser here on a decline exactly as it
  // does on a charge — the outcome is knowable only from the authenticated re-retrieve — so a page that said
  // "Payment received" told a declined customer something nobody had checked. It now sends them back to the shop,
  // which polls /status and reports the truth.
  const RETURN_PAGE =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Troia</title></head>' +
    '<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center">' +
    '<h1>You can close this window</h1>' +
    '<p>You’ll see the result of your payment on the store page.</p></body></html>';
  app.get('/return', async (_request, reply) => reply.type('text/html').send(RETURN_PAGE));
  app.post('/return', async (_request, reply) => reply.type('text/html').send(RETURN_PAGE));

  return app;
}
