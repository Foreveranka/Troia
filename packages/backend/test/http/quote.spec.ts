import { describe, expect, it } from 'vitest';
import type { QuoteFn } from '../../src/http/app.js';
import { DEFAULT_QUOTE_RATE_LIMIT } from '../../src/http/app.js';
import { AMOUNT, intentBody, makeHttpHarness, quoteUrl } from './http-harness.js';

// GET /quote is a read-only price PREVIEW: it runs the SAME deps.quote the charge uses (so the shown TL equals the
// eventual charge, modulo rate drift), but creates NO order, NO reservation, NO hosted form, and NO sequence. These
// pin the happy price, the shown==charged guarantee, the crux (zero side effects), validation, fail-closed pricing,
// and the rate limit — it hits the live oracle on every call, so unlike /status it must be bounded.

describe('GET /quote — read-only price preview', () => {
  it('prices 1 USDC via the same deps.quote /intent uses, returning ONLY paidPriceTry + spreadBps', async () => {
    const h = makeHttpHarness();
    const res = await h.app.inject({ method: 'GET', url: quoteUrl(AMOUNT) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ paidPriceTry: '41.42', spreadBps: 229 });
    expect(Object.keys(res.json())).toEqual(['paidPriceTry', 'spreadBps']); // no order fields leak
  });

  it('the previewed price EQUALS what POST /intent charges for the same amount', async () => {
    const h = makeHttpHarness();
    const quoted = (await h.app.inject({ method: 'GET', url: quoteUrl(AMOUNT) })).json();
    const charged = (
      await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') })
    ).json();

    // same injected deps.quote reference -> same TL, by construction
    expect(quoted.paidPriceTry).toBe(charged.paidPriceTry);
    expect(quoted.spreadBps).toBe(charged.spreadBps);
    // and it equals the frozen ctx price the customer is actually charged
    expect(quoted.paidPriceTry).toBe(h.registry.getByOrderId('order-1')?.ctx.paidPriceTry);
  });

  it('creates NO order and NO reservation — the crux of read-only', async () => {
    const h = makeHttpHarness();
    const before = h.store.availableStroops();

    await h.app.inject({ method: 'GET', url: quoteUrl(AMOUNT) });

    expect(h.store.availableStroops()).toBe(before); // no solvency hold taken
    expect(h.registry.getByOrderId('order-1')).toBeUndefined(); // no registry write
    expect(h.trace).toEqual([]); // no stellar/psp port was touched at all (snapshot, form, submit — none)
    // a status query is still an honest 404 — no order exists
    expect((await h.app.inject({ method: 'GET', url: '/status/order-1' })).statusCode).toBe(404);
  });

  it('many quotes never consume pool/registry — a later /intent still reserves exactly once', async () => {
    const h = makeHttpHarness();
    const before = h.store.availableStroops();

    for (let i = 0; i < 10; i++) await h.app.inject({ method: 'GET', url: quoteUrl(AMOUNT) });
    expect(h.store.availableStroops()).toBe(before);

    const intent = await h.app.inject({
      method: 'POST',
      url: '/intent',
      payload: intentBody('order-1'),
    });
    expect(intent.statusCode).toBe(200);
    expect(h.store.availableStroops()).toBe(before - AMOUNT); // reserved exactly once, by /intent
  });

  it('validates the amount and never mistakes a bad param for a price outage', async () => {
    const h = makeHttpHarness();
    const bad = async (amt: string) =>
      (await h.app.inject({ method: 'GET', url: `/quote/${amt}` })).json();

    expect(await bad('abc')).toEqual({ error: 'BadAmount' }); // not a number
    expect(await bad('0')).toEqual({ error: 'BadAmount' }); // non-positive
    expect(await bad('-5')).toEqual({ error: 'BadAmount' });
    expect(await bad((2n ** 127n).toString())).toEqual({ error: 'BadAmount' }); // > I128_MAX
    expect(h.trace).toEqual([]); // a rejected param never touches a port
  });

  it('fail-closed pricing: a throwing oracle yields 502 PriceUnavailable and still creates nothing', async () => {
    const failing: QuoteFn = async () => {
      throw new Error('rate feed down');
    };
    const h = makeHttpHarness(100n, failing);

    const res = await h.app.inject({ method: 'GET', url: quoteUrl(AMOUNT) });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'PriceUnavailable' });
    expect(h.registry.getByOrderId('order-1')).toBeUndefined();
    expect(h.trace).toEqual([]);
  });

  it('is rate-limited per IP (it hits the live oracle), on a bucket independent of /intent and /status', async () => {
    // intent cap 1, quote cap 2 — small on both, so exhausting one and finding the other intact proves the buckets
    // do not share a counter (@fastify/rate-limit builds a per-route child store when config.rateLimit is an object).
    const h = makeHttpHarness(
      100n,
      undefined,
      { max: 1, timeWindowMs: 60_000 },
      { max: 2, timeWindowMs: 60_000 },
    );

    expect((await h.app.inject({ method: 'GET', url: quoteUrl(AMOUNT) })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: quoteUrl(AMOUNT) })).statusCode).toBe(200);
    const limited = await h.app.inject({ method: 'GET', url: quoteUrl(AMOUNT) });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ statusCode: 429, error: 'RateLimited' });

    // independent bucket: exhausting /quote left /intent's own single token intact...
    expect(
      (await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') }))
        .statusCode,
    ).toBe(200);
    // ...and /status is never throttled regardless of the quote cap
    for (let i = 0; i < 5; i++)
      expect((await h.app.inject({ method: 'GET', url: '/status/x' })).statusCode).not.toBe(429);
  });

  it('pins the public-deploy default quote cap so a change is a deliberate edit', () => {
    expect(DEFAULT_QUOTE_RATE_LIMIT).toEqual({ max: 30, timeWindowMs: 60_000 });
  });
});
