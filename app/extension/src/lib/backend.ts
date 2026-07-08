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
async function fetchWithTimeout(doFetch: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
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

export async function postIntent(body: IntentBody, opts: PostIntentOptions = {}): Promise<IntentOutcome> {
  const baseUrl = opts.baseUrl ?? BACKEND_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      doFetch,
      `${baseUrl}/intent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The client sends no IP — the backend derives the buyer IP server-side from the request (zero-trust).
        body: JSON.stringify(body),
      },
      opts.timeoutMs ?? INTENT_TIMEOUT_MS,
    );
  } catch (e) {
    return { ok: false, status: null, error: isTimeout(e) ? 'timeout' : 'network' };
  }

  const json: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    // Surface the backend's fail-closed reason (e.g. PoolInsufficient, MemoMismatch) when present.
    const error = isRecord(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`;
    return { ok: false, status: res.status, error };
  }
  if (!isRecord(json) || typeof json.token !== 'string' || typeof json.orderId !== 'string') {
    return { ok: false, status: res.status, error: 'malformed_response' };
  }
  return { ok: true, response: json as unknown as IntentResponse };
}

/** Poll the coarse public status of an order (GET /status/:orderId). Never throws; a transient failure is a
 *  fail outcome the caller keeps polling through. */
export async function getStatus(orderId: string, opts: GetStatusOptions = {}): Promise<StatusOutcome> {
  const baseUrl = opts.baseUrl ?? BACKEND_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchWithTimeout(doFetch, `${baseUrl}/status/${encodeURIComponent(orderId)}`, {}, opts.timeoutMs ?? POLL_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, error: isTimeout(e) ? 'timeout' : 'network' };
  }

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(json) || typeof json.status !== 'string') {
    const error = isRecord(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`;
    return { ok: false, error };
  }
  return { ok: true, status: json.status as PublicStatus };
}

/** Fetch the settlement receipt (GET /receipt/:orderId): the on-chain pay() tx hash + the TRY charged, once
 *  known. Reviewer-facing proof; never throws. */
export async function getReceipt(orderId: string, opts: GetStatusOptions = {}): Promise<ReceiptOutcome> {
  const baseUrl = opts.baseUrl ?? BACKEND_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchWithTimeout(doFetch, `${baseUrl}/receipt/${encodeURIComponent(orderId)}`, {}, opts.timeoutMs ?? POLL_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, error: isTimeout(e) ? 'timeout' : 'network' };
  }

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(json)) {
    const error = isRecord(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`;
    return { ok: false, error };
  }
  return {
    ok: true,
    txHash: typeof json.txHash === 'string' ? json.txHash : null,
    paidPriceTry: typeof json.paidPriceTry === 'string' ? json.paidPriceTry : null,
  };
}
