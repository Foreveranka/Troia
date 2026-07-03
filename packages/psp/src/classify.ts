// The money-safety oracle. classifyIyzicoResult maps a raw iyzico result into {SUCCESS, FAILURE, UNKNOWN}
// with a deliberate ASYMMETRY that is LAW:
//   - SUCCESS is asserted ONLY on an exact, whitelisted terminal-success shape (incl. fraudStatus === 1).
//   - FAILURE (for a charge) is asserted ONLY on a CLOSED, deliberately-small terminal-decline whitelist.
//   - EVERYTHING else — timeouts, malformed bodies, unknown/intermediate states, unrecognized error codes,
//     failed signatures — is UNKNOWN. Under-populating the whitelist fails SAFE (an extra poll, never a
//     wrongful void and never a wrongful USDC payout).
// A valid webhook signature proves AUTHENTICITY, not OUTCOME: SUCCESS is only ever asserted after a
// server-side re-retrieve, never from a webhook alone (that wiring lives in the backend, Phase 4.3).

import type { IyzicoClass, PspOp, RawIyzicoResult } from './outcomes.js';

// A CLOSED set of definitive issuer/business declines (a charge that certainly did not and will not
// succeed). PROVISIONAL — the exact iyzico errorCode taxonomy is confirmed against a live sandbox in
// Phase 4.5. Any code NOT in this set classifies as UNKNOWN, never FAILURE, so the set failing SAFE is the
// whole point: it may only ever SHRINK risk, never widen it.
export const TERMINAL_DECLINE_WHITELIST: ReadonlySet<string> = new Set([
  '10051', // insufficient funds
  '10005', // do not honour / general decline
  '10054', // expired card
  '10041', // lost card
  '10043', // stolen card
  '10012', // invalid transaction
  '10057', // transaction not permitted to cardholder
]);

const TERMINAL_SUCCESS_PAYMENT_STATUS = 'SUCCESS';
const FRAUD_STATUS_OK = 1; // 1 = approved; 0 = manual review (UNKNOWN); -1 = fraud reject (UNKNOWN)

function bodyOf(raw: RawIyzicoResult): Readonly<Record<string, unknown>> | null {
  return raw.kind === 'body' ? raw.body : null;
}
function readString(body: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}
function readNumber(body: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = body[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * The 3-valued classifier. Total and defensive: it never trusts the shape of `raw` and never throws.
 */
export function classifyIyzicoResult(raw: RawIyzicoResult, op: PspOp): IyzicoClass {
  const body = bodyOf(raw);
  if (body === null) return 'UNKNOWN'; // timeout / malformed transport marker

  const status = readString(body, 'status');
  if (status === undefined) return 'UNKNOWN'; // not a recognizable iyzico envelope

  if (status === 'failure') {
    // void/refund move money BACK to the customer: a clear failure is safe to retry (idempotent), so it is
    // a definite FAILURE that re-drives the release. A charge failure is FAILURE only on the closed decline
    // whitelist; anything else is UNKNOWN (could be a transient/system error over a possibly-live hold).
    if (op === 'void' || op === 'refund') return 'FAILURE';
    const code = readString(body, 'errorCode');
    return code !== undefined && TERMINAL_DECLINE_WHITELIST.has(code) ? 'FAILURE' : 'UNKNOWN';
  }

  if (status !== 'success') return 'UNKNOWN'; // any non-{success,failure} status value

  // status === 'success' — the envelope is OK; apply the per-op TERMINAL-success shape.
  switch (op) {
    case 'preauth':
    case 'checkout': {
      // A hold is only real when the payment reached the terminal SUCCESS state AND fraud approved it.
      // Any intermediate paymentStatus (INIT_THREEDS/CALLBACK_THREEDS/PENDING_*/...) or fraud review -> UNKNOWN.
      const paymentStatus = readString(body, 'paymentStatus');
      const fraudStatus = readNumber(body, 'fraudStatus');
      return paymentStatus === TERMINAL_SUCCESS_PAYMENT_STATUS && fraudStatus === FRAUD_STATUS_OK
        ? 'SUCCESS'
        : 'UNKNOWN';
    }
    case 'capture': {
      // A captured PostAuth: success envelope + a real paymentId + NO error (any type) + NOT a PRE_AUTH-phase
      // body. A PRE_AUTH payment-detail is a still-live, UNCAPTURED hold; if it ever reached here it must read
      // UNKNOWN, never captured (that would keep the USDC while the TRY hold expires uncaptured = real loss).
      const paymentId = readString(body, 'paymentId');
      const hasError = body['errorCode'] !== undefined && body['errorCode'] !== null;
      const phase = readString(body, 'phase');
      return paymentId !== undefined && !hasError && phase !== 'PRE_AUTH' ? 'SUCCESS' : 'UNKNOWN';
    }
    case 'void':
    case 'refund':
      // A success envelope acknowledges the void/refund. (A false-positive void merely lets the hold expire
      // naturally later — the fail-SAFE direction for a release.)
      return 'SUCCESS';
    default:
      // Out-of-enum op (defensive): an unrecognized operation can never be a SUCCESS.
      return 'UNKNOWN';
  }
}

// --- Per-op mappers onto the @troia/core state-machine events (§3). Typed structurally (not by importing
// core) to keep this file dependency-light; the psp-to-core test proves core.transition accepts each event.

export type PreauthEvent =
  | { readonly type: 'preauthOk' }
  | { readonly type: 'preauthRejected' }
  | { readonly type: 'preauthUnknown' };
export type CaptureEvent =
  | { readonly type: 'captureSuccess' }
  | { readonly type: 'captureFailed'; readonly retriesRemaining: boolean }
  | { readonly type: 'captureUnknown' };
export type VoidEvent =
  | { readonly type: 'voidConfirmed' }
  | { readonly type: 'voidNotVoided' }
  | { readonly type: 'voidUnknown' };

export function preauthEvent(raw: RawIyzicoResult): PreauthEvent {
  switch (classifyIyzicoResult(raw, 'preauth')) {
    case 'SUCCESS':
      return { type: 'preauthOk' };
    case 'FAILURE':
      return { type: 'preauthRejected' };
    case 'UNKNOWN':
      return { type: 'preauthUnknown' };
  }
}

/** retriesRemaining is a backend retry-budget decision (not an iyzico signal), so it is passed in. */
export function captureEvent(raw: RawIyzicoResult, retriesRemaining: boolean): CaptureEvent {
  switch (classifyIyzicoResult(raw, 'capture')) {
    case 'SUCCESS':
      return { type: 'captureSuccess' };
    case 'FAILURE':
      return { type: 'captureFailed', retriesRemaining };
    case 'UNKNOWN':
      return { type: 'captureUnknown' };
  }
}

export function voidEvent(raw: RawIyzicoResult): VoidEvent {
  switch (classifyIyzicoResult(raw, 'void')) {
    case 'SUCCESS':
      return { type: 'voidConfirmed' };
    case 'FAILURE':
      return { type: 'voidNotVoided' };
    case 'UNKNOWN':
      return { type: 'voidUnknown' };
  }
}
