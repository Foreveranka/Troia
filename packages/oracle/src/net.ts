// Network-robustness for the live oracle inputs (CEX spot tickers + Yahoo daily closes). These are the reads on
// the /intent hot path: a hung upstream socket would hang getRate() -> hang the checkout forever, and with the
// settlement policy (minQuorum 3 of 3 sources) a single transient blip fails a quote CLOSED. fetchJsonWithRetry
// bounds EACH attempt with an AbortSignal timeout (a hung source becomes a DROPPED source -> the quorum decides,
// fail-closed) and retries a FAILED attempt a bounded number of times (a transient blip is absorbed, so a healthy
// 3-source demo isn't tanked by one flaky response). This is ONLY for idempotent GETs — an iyzico POST is never
// retried (double-charge risk); it gets a timeout only, in its own adapter.

import type { FetchLike } from './rate-history.js';

export interface NetPolicy {
  /** Per-attempt hard deadline (ms). On expiry the attempt's AbortSignal fires and the fetch rejects. */
  readonly timeoutMs: number;
  /** Additional attempts after the first (retries=1 => up to 2 total attempts). Only FAILED attempts retry. */
  readonly retries: number;
}

/** A bounded, tunable default: fast enough that a dead source can't stall a checkout for long, with one retry so a
 *  single transient blip doesn't fail an otherwise-healthy quote. Overridable per provider via its options. */
export const DEFAULT_NET_POLICY: NetPolicy = { timeoutMs: 4000, retries: 1 };

/**
 * Fetch a URL and parse it as JSON, bounding each attempt with an AbortSignal timeout and retrying a FAILED
 * attempt up to `policy.retries` times. Retries re-attempt only a THROWN failure (network error / timeout /
 * unparseable json()); a RESOLVED body — even a wrong-shaped one — is returned as-is for the caller's parser to
 * reject fail-closed (retrying it would never change the shape). Throws the last error if every attempt fails, so
 * the caller (fetchCexQuote's try/catch, dailyCloses) sees a clean failure and drops the source — never a
 * fabricated success. Idempotent GETs only.
 */
export async function fetchJsonWithRetry(url: string, fetch: FetchLike, policy: NetPolicy): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(policy.timeoutMs) });
      return await res.json();
    } catch (e) {
      lastErr = e; // network error / abort-timeout / unparseable body -> try again (bounded)
    }
  }
  throw lastErr;
}
