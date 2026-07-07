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
