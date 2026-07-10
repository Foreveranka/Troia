import { describe, expect, it } from 'vitest';
import { makeHttpHarness } from './http-harness.js';

// After paying on the hosted form, iyzico posts the customer's BROWSER to the checkout callbackUrl (the /return
// landing page) as application/x-www-form-urlencoded. Before the fix this 415'd — Fastify had no parser for that
// content type, so the customer saw a raw error. /return is a body-agnostic landing page: it verifies nothing and
// touches no money path (settlement is the poll/recovery worker's authenticated pull, not this browser redirect).
describe('GET/POST /return — the post-payment browser landing page (no 415)', () => {
  it('accepts the iyzico form-urlencoded browser POST and returns an HTML page (not 415)', async () => {
    const h = makeHttpHarness();
    const r = await h.app.inject({
      method: 'POST',
      url: '/return',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=abc123&status=success',
    });
    expect(r.statusCode).toBe(200); // NOT 415 — the form-urlencoded parser accepts the browser redirect
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<html');
  });

  it('serves the same page on a GET', async () => {
    const h = makeHttpHarness();
    const r = await h.app.inject({ method: 'GET', url: '/return' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
  });

  // The page cannot know the outcome. iyzico redirects the browser here whether the card was charged or declined
  // — the result is only knowable from the authenticated server-side re-retrieve — so anything this page asserts
  // about the payment is a guess. It asserted "Payment received" to declined customers until this test existed.
  const OUTCOME_WORDS = [
    'received',
    'success',
    'successful',
    'completed',
    'confirmed',
    'approved',
    'failed',
    'declined',
    'başarılı',
    'onaylandı',
    'alındı',
    'tamamlandı',
    'reddedildi',
  ];

  it('never claims an outcome — it cannot know one', async () => {
    const h = makeHttpHarness();
    const r = await h.app.inject({ method: 'GET', url: '/return' });
    const body = r.body.toLowerCase();
    for (const word of OUTCOME_WORDS) {
      expect(body, `the landing page must not say "${word}"`).not.toContain(word);
    }
  });

  it('says the same thing whether iyzico reports success or failure', async () => {
    const h = makeHttpHarness();
    const post = (payload: string) =>
      h.app.inject({
        method: 'POST',
        url: '/return',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload,
      });
    const ok = await post('token=abc&status=success');
    const bad = await post('token=abc&status=failure');
    expect(ok.body).toBe(bad.body); // byte-identical: the body is not an input to what the customer is told
  });

  it('points the customer back at the shop', async () => {
    const h = makeHttpHarness();
    const r = await h.app.inject({ method: 'GET', url: '/return' });
    expect(r.body).toContain('lang="en"');
    expect(r.body).toContain('You can close this window');
    expect(r.body).toContain('You’ll see the result of your payment on the store page');
  });

  it('touches NO money path — a /return hit calls no psp / stellar port (settlement is the worker pull)', async () => {
    const h = makeHttpHarness();
    await h.app.inject({
      method: 'POST',
      url: '/return',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=x',
    });
    expect(h.trace.filter((t) => t.startsWith('psp.') || t.startsWith('stellar.'))).toHaveLength(0);
  });
});
