import { describe, expect, it } from 'vitest';
import { body } from '../fakes/harness.js';
import { intentBody, makeHttpHarness } from './http-harness.js';
import { DEFAULT_INTENT_RATE_LIMIT } from '../../src/http/app.js';

// POST /intent is the one route that reserves the pool and opens a hosted charge, so it is the one worth a per-IP
// cap; GET /status is polled every 3s by the extension and must never be throttled. These tests pin both halves.
// The cap is injected tiny here; production uses DEFAULT_INTENT_RATE_LIMIT (pinned below).

async function postIntent(app: ReturnType<typeof makeHttpHarness>['app'], orderId: string) {
  return app.inject({ method: 'POST', url: '/intent', ...body(intentBody(orderId)) });
}

describe('POST /intent is rate-limited per IP; GET /status is not', () => {
  it('allows requests up to the cap, then answers 429 with the { error } shape the other routes use', async () => {
    const h = makeHttpHarness(100n, undefined, { max: 2, timeWindowMs: 60_000 });

    expect((await postIntent(h.app, 'order-a')).statusCode).toBe(200);
    expect((await postIntent(h.app, 'order-b')).statusCode).toBe(200);

    const limited = await postIntent(h.app, 'order-c');
    expect(limited.statusCode).toBe(429);
    // The plugin uses the errorResponseBuilder's return as the body verbatim; statusCode must be in it to set 429,
    // so the body carries both. The extension reads only `.error` ('RateLimited').
    expect(limited.json()).toEqual({ statusCode: 429, error: 'RateLimited' });
  });

  it('rejects the over-cap request BEFORE it can reserve the pool (the whole point of the cap)', async () => {
    const h = makeHttpHarness(100n, undefined, { max: 1, timeWindowMs: 60_000 });

    expect((await postIntent(h.app, 'order-a')).statusCode).toBe(200);
    expect((await postIntent(h.app, 'order-b')).statusCode).toBe(429);

    // order-b never started: no registry entry, no pool reservation consumed.
    expect((await h.app.inject({ method: 'GET', url: '/status/order-b' })).statusCode).toBe(404);
  });

  it('never throttles GET /status — the extension polls it every 3s for up to 20 minutes', async () => {
    const h = makeHttpHarness(100n, undefined, { max: 1, timeWindowMs: 60_000 });
    expect((await postIntent(h.app, 'order-a')).statusCode).toBe(200); // spends the single /intent token

    for (let i = 0; i < 25; i++) {
      const res = await h.app.inject({ method: 'GET', url: '/status/order-a' });
      expect(res.statusCode).not.toBe(429);
      expect(res.statusCode).toBe(200); // 'pending' — the started order, well past the /intent cap
    }
  });

  it('pins the public-deploy default so a change is a deliberate edit', () => {
    expect(DEFAULT_INTENT_RATE_LIMIT).toEqual({ max: 20, timeWindowMs: 60_000 });
  });
});
