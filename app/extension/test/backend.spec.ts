// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getReceipt, getStatus, postIntent } from '../src/lib/backend';
import type { IntentBody } from '../src/lib/intent';

const BODY: IntentBody = {
  orderId: 'ST-AB12CD',
  destination: 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX',
  amountStroops: '620000000',
  assetIssuer: 'GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W',
  memoHex: 'e01397d329505f05c70b253c3f2e925f488cd5b07a9d9336e36c463f96020db0',
};

function fakeFetch(status: number, jsonBody: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
  })) as unknown as typeof fetch;
}

describe('postIntent', () => {
  it('returns ok with the response on 200', async () => {
    const r = await postIntent(BODY, {
      fetchImpl: fakeFetch(200, {
        orderId: 'ST-AB12CD',
        token: 'tok_1',
        paidPriceTry: '42.50',
        checkoutFormContent: '<script>/* iyzico */</script>',
        spreadBps: 250,
        poolLow: false,
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.response.token).toBe('tok_1');
    expect(r.response.paidPriceTry).toBe('42.50');
    expect(r.response.checkoutFormContent).toContain('iyzico');
  });

  it('sends exactly the intent body as JSON to /intent (no client IP — the backend derives it)', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const spy = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({ orderId: 'ST-AB12CD', token: 't', paidPriceTry: '1.00' }) };
    }) as unknown as typeof fetch;

    await postIntent(BODY, { fetchImpl: spy, baseUrl: 'http://localhost:3000' });

    expect(captured).not.toBeNull();
    const cap = captured as unknown as { url: string; init: RequestInit };
    expect(cap.url).toBe('http://localhost:3000/intent');
    expect(cap.init.method).toBe('POST');
    const sent = JSON.parse(String(cap.init.body));
    expect(sent).toEqual(BODY);
    expect(sent.ip).toBeUndefined();
  });

  it('maps a 409 PoolInsufficient to a fail outcome carrying the reason', async () => {
    const r = await postIntent(BODY, { fetchImpl: fakeFetch(409, { error: 'PoolInsufficient' }) });
    expect(r).toEqual({ ok: false, status: 409, error: 'PoolInsufficient' });
  });

  it('maps a 400 to the backend fail-closed reason string', async () => {
    const r = await postIntent(BODY, { fetchImpl: fakeFetch(400, { error: 'MemoMismatch' }) });
    expect(r).toEqual({ ok: false, status: 400, error: 'MemoMismatch' });
  });

  it('reports a network failure when fetch throws', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const r = await postIntent(BODY, { fetchImpl: throwing });
    expect(r).toEqual({ ok: false, status: null, error: 'network' });
  });

  it('rejects a malformed 200 that lacks a token', async () => {
    const r = await postIntent(BODY, { fetchImpl: fakeFetch(200, { orderId: 'ST-AB12CD' }) });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('malformed_response');
  });

  it('carries the iyzico paymentPageUrl through on success', async () => {
    const r = await postIntent(BODY, {
      fetchImpl: fakeFetch(200, {
        orderId: 'ST-AB12CD',
        token: 't',
        paidPriceTry: '1.00',
        paymentPageUrl: 'https://sandbox-cpp.iyzipay.com/?token=t',
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.response.paymentPageUrl).toBe('https://sandbox-cpp.iyzipay.com/?token=t');
  });
});

describe('getStatus', () => {
  it('returns the coarse public status on 200', async () => {
    const r = await getStatus('ST-AB12CD', { fetchImpl: fakeFetch(200, { orderId: 'ST-AB12CD', status: 'processing' }) });
    expect(r).toEqual({ ok: true, status: 'processing' });
  });

  it('requests the URL-encoded order id at /status/:orderId', async () => {
    let url = '';
    const spy = (async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ status: 'pending' }) };
    }) as unknown as typeof fetch;
    await getStatus('order 1/x', { fetchImpl: spy, baseUrl: 'http://localhost:3000' });
    expect(url).toBe('http://localhost:3000/status/order%201%2Fx');
  });

  it('maps a 404 NotFound to a fail outcome', async () => {
    const r = await getStatus('nope', { fetchImpl: fakeFetch(404, { error: 'NotFound' }) });
    expect(r).toEqual({ ok: false, error: 'NotFound' });
  });

  it('reports a network failure when fetch throws', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await getStatus('x', { fetchImpl: throwing })).toEqual({ ok: false, error: 'network' });
  });
});

describe('getReceipt', () => {
  it('returns txHash + paidPriceTry on a settled receipt', async () => {
    const r = await getReceipt('ST-AB12CD', {
      fetchImpl: fakeFetch(200, { orderId: 'ST-AB12CD', status: 'completed', txHash: 'abc123', paidPriceTry: '2650.00' }),
    });
    expect(r).toEqual({ ok: true, txHash: 'abc123', paidPriceTry: '2650.00' });
  });

  it('normalizes a not-yet-settled receipt to a null txHash', async () => {
    const r = await getReceipt('x', {
      fetchImpl: fakeFetch(200, { orderId: 'x', status: 'pending', txHash: null, paidPriceTry: '1.00' }),
    });
    expect(r).toEqual({ ok: true, txHash: null, paidPriceTry: '1.00' });
  });

  it('maps a 404 to a fail outcome', async () => {
    expect(await getReceipt('nope', { fetchImpl: fakeFetch(404, { error: 'NotFound' }) })).toEqual({ ok: false, error: 'NotFound' });
  });
});

describe('request timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A socket accepted then never answered: the fetch never settles and ignores the abort signal, so the
  // abort-on-timeout race is what must resolve the call (otherwise the caller hangs forever).
  const hangingFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

  it('postIntent resolves to a timeout outcome when the fetch never settles', async () => {
    vi.useFakeTimers();
    const p = postIntent(BODY, { fetchImpl: hangingFetch, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual({ ok: false, status: null, error: 'timeout' });
  });

  it('getStatus resolves to a timeout outcome when the fetch never settles', async () => {
    vi.useFakeTimers();
    const p = getStatus('ST-AB12CD', { fetchImpl: hangingFetch, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('getReceipt resolves to a timeout outcome when the fetch never settles', async () => {
    vi.useFakeTimers();
    const p = getReceipt('ST-AB12CD', { fetchImpl: hangingFetch, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual({ ok: false, error: 'timeout' });
  });
});
