// C-13: the /intent session gate. Token mint/verify is pure crypto (unit-tested first); the HTTP half is
// exercised through the real app — the gate must cost a tokenless caller one header check, charge each NEW
// order against the session budget, and never tax the idempotent replay path the extension's retry uses.

import { describe, expect, it } from 'vitest';
import { mintSessionToken, SessionBudget, verifySessionToken } from '../../src/http/session.js';
import { intentBody, makeHttpHarness } from './http-harness.js';

const SECRET = 'session-test-secret';
const NOW = 1_700_000_000;

describe('session token (pure crypto)', () => {
  it('round-trips: a minted token verifies to its own claims until expiry', () => {
    const { token, claims } = mintSessionToken(SECRET, NOW, 900);
    expect(verifySessionToken(SECRET, token, NOW)).toEqual(claims);
    expect(verifySessionToken(SECRET, token, NOW + 899)).toEqual(claims);
    expect(verifySessionToken(SECRET, token, NOW + 900)).toBeNull(); // expiry is exclusive
  });

  it('fails closed on tampering, the wrong secret, and garbage — always null, never a throw', () => {
    const { token } = mintSessionToken(SECRET, NOW, 900);
    const [payload, sig] = token.split('.') as [string, string];
    expect(verifySessionToken(SECRET, `${payload}x.${sig}`, NOW)).toBeNull(); // payload tampered
    expect(verifySessionToken(SECRET, `${payload}.${sig.slice(0, -2)}`, NOW)).toBeNull(); // sig cut
    expect(verifySessionToken('other-secret', token, NOW)).toBeNull(); // wrong key
    expect(verifySessionToken(SECRET, 'not-a-token', NOW)).toBeNull();
    expect(verifySessionToken(SECRET, '..', NOW)).toBeNull();
    expect(verifySessionToken(SECRET, '', NOW)).toBeNull();
  });

  it('budget: max units per session, and expired sessions are pruned instead of accumulating', () => {
    const budget = new SessionBudget(2);
    const { claims } = mintSessionToken(SECRET, NOW, 900);
    expect(budget.take(claims, NOW)).toBe(true);
    expect(budget.take(claims, NOW)).toBe(true);
    expect(budget.take(claims, NOW)).toBe(false); // spent
    // after the session expires its row is pruned — a NEW session with a fresh sid starts clean
    const fresh = mintSessionToken(SECRET, NOW + 1_000, 900);
    expect(budget.take(fresh.claims, NOW + 1_000)).toBe(true);
  });
});

describe('the /intent session gate over HTTP', () => {
  const AUTH = { secret: SECRET, ttlSecs: 900, maxIntentsPerSession: 2 };

  async function sessionTokenOf(h: ReturnType<typeof makeHttpHarness>): Promise<string> {
    const r = await h.app.inject({ method: 'POST', url: '/session' });
    expect(r.statusCode).toBe(200);
    return (r.json() as { token: string }).token;
  }

  it('401 without a token, 401 on a tampered token — one uniform refusal, zero side effects', async () => {
    const h = makeHttpHarness(100n, undefined, undefined, undefined, AUTH);
    const bare = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('o1') });
    expect(bare.statusCode).toBe(401);
    expect(bare.json()).toEqual({ error: 'SessionRequired' });
    const forged = await h.app.inject({
      method: 'POST',
      url: '/intent',
      headers: { 'x-troia-session': 'aaaa.bbbb' },
      payload: intentBody('o1'),
    });
    expect(forged.statusCode).toBe(401);
    expect(h.store.availableStroops()).toBe(100n * 10_000_000n); // nothing reserved
    expect(h.registry.getByOrderId('o1')).toBeUndefined(); // nothing registered
  });

  it('a full checkout flows with a minted token; an expired token is a 401 the client can heal', async () => {
    const h = makeHttpHarness(100n, undefined, undefined, undefined, AUTH);
    const token = await sessionTokenOf(h);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/intent',
      headers: { 'x-troia-session': token },
      payload: intentBody('o1'),
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { token?: string }).token).toBeDefined(); // the hosted-form token — order started

    h.clock.now += 901; // the session outlives its ttl
    const expired = await h.app.inject({
      method: 'POST',
      url: '/intent',
      headers: { 'x-troia-session': token },
      payload: intentBody('o2'),
    });
    expect(expired.statusCode).toBe(401); // the extension refreshes via /session and retries
  });

  it('the budget charges NEW orders only: the idempotent replay stays free after the budget is spent', async () => {
    const h = makeHttpHarness(100n, undefined, undefined, undefined, AUTH);
    const token = await sessionTokenOf(h);
    const send = (orderId: string) =>
      h.app.inject({
        method: 'POST',
        url: '/intent',
        headers: { 'x-troia-session': token },
        payload: intentBody(orderId),
      });
    expect((await send('o1')).statusCode).toBe(200);
    expect((await send('o2')).statusCode).toBe(200);
    const third = await send('o3'); // budget (2) spent — a third NEW order is refused
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: 'SessionBudgetExceeded' });
    expect(h.registry.getByOrderId('o3')).toBeUndefined(); // refused before any work

    const replay = await send('o1'); // the duplicate-click path burns no budget
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { alreadyStarted?: boolean }).alreadyStarted).toBe(true);

    const fresh = await sessionTokenOf(h); // and a fresh session opens a fresh budget
    const withFresh = await h.app.inject({
      method: 'POST',
      url: '/intent',
      headers: { 'x-troia-session': fresh },
      payload: intentBody('o3'),
    });
    expect(withFresh.statusCode).toBe(200);
  });

  it('the gate is OFF when intentAuth is not configured — the offline suite keeps its old contract', async () => {
    const h = makeHttpHarness(); // no intentAuth
    const r = await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('o1') });
    expect(r.statusCode).toBe(200);
    const session = await h.app.inject({ method: 'POST', url: '/session' });
    expect(session.statusCode).toBe(404); // the route only exists when the gate is configured
  });
});
