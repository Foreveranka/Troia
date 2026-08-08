// The single place the extension talks to the Troia backend. Called only from the background service worker
// (which alone holds the backend host permission — a content-script fetch would be cross-origin). It POSTs the
// intent body plus the demo buyer IP and normalizes every result into a typed IntentOutcome; it never throws.
// The backend re-validates every field fail-closed (PayoutIntent.build), so this is a request, not a trust.

import { BACKEND_BASE_URL } from './config';
import type { IntentBody, IntentResponse, PublicStatus } from './intent';

export type IntentOutcome =
  | { readonly ok: true; readonly response: IntentResponse }
  | { readonly ok: false; readonly status: number | null; readonly error: string };

export type StatusOutcome =
  | { readonly ok: true; readonly status: PublicStatus }
  | { readonly ok: false; readonly error: string };

export type ReceiptOutcome =
  | { readonly ok: true; readonly txHash: string | null; readonly paidPriceTry: string | null }
  | { readonly ok: false; readonly error: string };

export type QuoteOutcome =
  | { readonly ok: true; readonly paidPriceTry: string; readonly spreadBps: number | null }
  | { readonly ok: false; readonly error: string };

export interface PostIntentOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface GetStatusOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// Default request budgets. A stalled socket (accepted then never answered) must reject after a bound instead
// of hanging forever — otherwise the background never replies, the content-script callback never fires, and
// the banner freezes on "Processing…" with no error and no retry. POST /intent is a one-shot; the /status +
// /receipt polls recur every few seconds, so they get a tighter budget.
const INTENT_TIMEOUT_MS = 15000;
const POLL_TIMEOUT_MS = 8000;

function isTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** Fetch with an abort-on-timeout race so a fetch that never settles rejects after `timeoutMs`. The race also
 *  covers a fetch impl that ignores the AbortSignal; the real fetch is aborted regardless. */
async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error('request timed out');
      err.name = 'AbortError';
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([doFetch(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- C-13: the /intent session token ---
//
// The backend requires a short-lived session token on POST /intent (its anti-flood gate). The background
// worker caches one here and refreshes it on expiry or on a 401 — one extra round-trip per ~15 minutes, and
// after a backend restart (which invalidates all tokens) the 401-retry below self-heals. Module state in an
// MV3 service worker dies whenever the worker idles out; that just means a fresh /session next time.

interface CachedSession {
  readonly token: string;
  readonly expiresAtUnix: number;
}
let cachedSession: CachedSession | null = null;
/** Refresh margin: treat a token this close to expiry as already dead, so an /intent never sails out with a
 *  token that expires mid-flight. */
const SESSION_EXPIRY_MARGIN_SECS = 30;

/** Test seam: the cache is module state, so specs reset it between cases. */
export function resetSessionCache(): void {
  cachedSession = null;
}

type SessionResult =
  { readonly ok: true; readonly token: string } | { readonly ok: false; readonly error: string };

async function fetchSessionToken(
  baseUrl: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<SessionResult> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedSession !== null && cachedSession.expiresAtUnix > now + SESSION_EXPIRY_MARGIN_SECS) {
    return { ok: true, token: cachedSession.token };
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(doFetch, `${baseUrl}/session`, { method: 'POST' }, timeoutMs);
  } catch (e) {
    // keep the failure vocabulary the caller already speaks: a dead network at /session IS a dead network
    return { ok: false, error: isTimeout(e) ? 'timeout' : 'network' };
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(json) || typeof json.token !== 'string') {
    return { ok: false, error: 'session_unavailable' };
  }
  cachedSession = {
    token: json.token,
    expiresAtUnix: typeof json.expiresAtUnix === 'number' ? json.expiresAtUnix : now,
  };
  return { ok: true, token: json.token };
}

export async function postIntent(
  body: IntentBody,
  opts: PostIntentOptions = {},
): Promise<IntentOutcome> {
  const baseUrl = opts.baseUrl ?? BACKEND_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? INTENT_TIMEOUT_MS;

  const attempt = async (sessionToken: string): Promise<Response> =>
    fetchWithTimeout(
      doFetch,
      `${baseUrl}/intent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-troia-session': sessionToken },
        // The client sends no IP — the backend derives the buyer IP server-side from the request (zero-trust).
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

  const session = await fetchSessionToken(baseUrl, doFetch, timeoutMs);
  if (!session.ok) return { ok: false, status: null, error: session.error };

  let res: Response;
  try {
    res = await attempt(session.token);
    // A 401 means OUR token went stale (expiry, or a backend restart rotated the secret) — never the order's
    // fault. Refresh once and retry once; a second 401 is surfaced.
    if (res.status === 401) {
      resetSessionCache();
      const fresh = await fetchSessionToken(baseUrl, doFetch, timeoutMs);
      if (!fresh.ok) return { ok: false, status: null, error: fresh.error };
      res = await attempt(fresh.token);
    }
  } catch (e) {
    return { ok: false, status: null, error: isTimeout(e) ? 'timeout' : 'network' };
  }

  const json: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    // Surface the backend's fail-closed reason (e.g. PoolInsufficient, MemoMismatch) when present.
    const error =
      isRecord(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`;
    return { ok: false, status: res.status, error };
  }
  if (!isRecord(json) || typeof json.token !== 'string' || typeof json.orderId !== 'string') {
    return { ok: false, status: res.status, error: 'malformed_response' };
  }
  return { ok: true, response: json as unknown as IntentResponse };
}

/** Poll the coarse public status of an order (GET /status/:orderId). Never throws; a transient failure is a
 *  fail outcome the caller keeps polling through. */
export async function getStatus(
  orderId: string,
  opts: GetStatusOptions = {},
): Promise<StatusOutcome> {
  const baseUrl = opts.baseUrl ?? BACKEND_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      doFetch,
      `${baseUrl}/status/${encodeURIComponent(orderId)}`,
      {},
      opts.timeoutMs ?? POLL_TIMEOUT_MS,
    );
  } catch (e) {
    return { ok: false, error: isTimeout(e) ? 'timeout' : 'network' };
  }

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(json) || typeof json.status !== 'string') {
    const error =
      isRecord(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`;
    return { ok: false, error };
  }
  return { ok: true, status: json.status as PublicStatus };
}

/** Fetch the settlement receipt (GET /receipt/:orderId): the on-chain pay() tx hash + the TRY charged, once
 *  known. Reviewer-facing proof; never throws. */
export async function getReceipt(
  orderId: string,
  opts: GetStatusOptions = {},
): Promise<ReceiptOutcome> {
  const baseUrl = opts.baseUrl ?? BACKEND_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      doFetch,
      `${baseUrl}/receipt/${encodeURIComponent(orderId)}`,
      {},
      opts.timeoutMs ?? POLL_TIMEOUT_MS,
    );
  } catch (e) {
    return { ok: false, error: isTimeout(e) ? 'timeout' : 'network' };
  }

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(json)) {
    const error =
      isRecord(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`;
    return { ok: false, error };
  }
  return {
    ok: true,
    txHash: typeof json.txHash === 'string' ? json.txHash : null,
    paidPriceTry: typeof json.paidPriceTry === 'string' ? json.paidPriceTry : null,
  };
}

/** Fetch the read-only price PREVIEW for a USDC amount (GET /quote/:amountStroops): the indicative TRY the
 *  customer would be charged, priced via the SAME path /intent uses. A preview only — the charged price is locked
 *  server-side at /intent. Never throws; a failure is a fail outcome the caller degrades through (shows no TL,
 *  keeps the USDC amount + an enabled Pay button). Read-only on the backend: it reserves nothing. */
export async function getQuote(
  amountStroops: string,
  opts: GetStatusOptions = {},
): Promise<QuoteOutcome> {
  const baseUrl = opts.baseUrl ?? BACKEND_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      doFetch,
      `${baseUrl}/quote/${encodeURIComponent(amountStroops)}`,
      {},
      opts.timeoutMs ?? POLL_TIMEOUT_MS,
    );
  } catch (e) {
    return { ok: false, error: isTimeout(e) ? 'timeout' : 'network' };
  }

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(json) || typeof json.paidPriceTry !== 'string') {
    const error =
      isRecord(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`;
    return { ok: false, error };
  }
  return {
    ok: true,
    paidPriceTry: json.paidPriceTry,
    spreadBps: typeof json.spreadBps === 'number' ? json.spreadBps : null,
  };
}
