import { describe, expect, it } from 'vitest';
import { intentBody, makeHttpHarness } from './http-harness.js';

describe('GET /status/:orderId — coarse public status (no crypto-state leak)', () => {
  it('404 for an unknown order', async () => {
    const h = makeHttpHarness();
    const res = await h.app.inject({ method: 'GET', url: '/status/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NotFound' });
  });

  it('pending right after /intent', async () => {
    const h = makeHttpHarness();
    await h.app.inject({ method: 'POST', url: '/intent', payload: intentBody('order-1') });
    const res = await h.app.inject({ method: 'GET', url: '/status/order-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orderId: 'order-1', status: 'pending' });
    // never leaks the internal State
    expect(JSON.stringify(res.json())).not.toContain('Reserved');
  });
});
