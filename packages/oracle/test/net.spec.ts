import { describe, expect, it } from 'vitest';
import { DEFAULT_NET_POLICY, fetchJsonWithRetry } from '../src/index.js';
import type { FetchLike, NetPolicy } from '../src/index.js';

// fetchJsonWithRetry: the network-robustness seam for the live oracle inputs (CEX tickers + Yahoo closes). It
// bounds each HTTP attempt with an AbortSignal timeout and retries a FAILED attempt (a transient blip) a bounded
// number of times — so a hung CEX source becomes a DROPPED source (fail-closed via the quorum) instead of hanging
// /intent forever, and a single transient failure on the demo path doesn't tank an otherwise-healthy quote. Only
// idempotent GETs use this (never an iyzico POST); a successful-but-wrong body is returned for the caller's parser
// to reject fail-closed, NOT retried.

const FAST: NetPolicy = { timeoutMs: 25, retries: 1 };

/** A fetch that never resolves but HONORS the abort signal (as the real fetch does) — models a hung upstream. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
  });

describe('fetchJsonWithRetry — bounded timeout + retry for live oracle reads', () => {
  it('times out a hung upstream (does not hang forever) and throws after exhausting retries', async () => {
    let attempts = 0;
    const fetch: FetchLike = (url, init) => {
      attempts++;
      return hangingFetch(url, init);
    };
    await expect(fetchJsonWithRetry('https://x', fetch, FAST)).rejects.toThrow();
    expect(attempts).toBe(2); // first + one retry, each aborted by its own timeout — never an unbounded hang
  });

  it('recovers from a transient failure on retry (returns the body from the second attempt)', async () => {
    let attempts = 0;
    const fetch: FetchLike = async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient reset');
      return { json: async () => ({ ok: true }) };
    };
    const body = await fetchJsonWithRetry('https://x', fetch, FAST);
    expect(body).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('returns the body on the FIRST try without burning a retry when the upstream is healthy', async () => {
    let attempts = 0;
    const fetch: FetchLike = async () => {
      attempts++;
      return { json: async () => ({ v: 1 }) };
    };
    const body = await fetchJsonWithRetry('https://x', fetch, { timeoutMs: 1000, retries: 3 });
    expect(body).toEqual({ v: 1 });
    expect(attempts).toBe(1);
  });

  it('returns a RESOLVED wrong-shape body as-is (the caller parser fails closed; this is not a retryable failure)', async () => {
    let attempts = 0;
    const fetch: FetchLike = async () => {
      attempts++;
      return { json: async () => 'not-an-object' };
    };
    const body = await fetchJsonWithRetry('https://x', fetch, FAST);
    expect(body).toBe('not-an-object'); // returned; the CALLER's parse guard rejects it, not a retry here
    expect(attempts).toBe(1);
  });

  it('exhausts retries and throws the LAST error (never resolves to a fabricated value)', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('always down');
    };
    await expect(
      fetchJsonWithRetry('https://x', fetch, { timeoutMs: 1000, retries: 2 }),
    ).rejects.toThrow('always down');
  });

  it('DEFAULT_NET_POLICY is a sane bounded default (a positive timeout and at least one retry)', () => {
    expect(DEFAULT_NET_POLICY.timeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_NET_POLICY.retries).toBeGreaterThanOrEqual(1);
  });
});
