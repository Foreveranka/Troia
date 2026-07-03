// PURE X-IYZ-SIGNATURE-V3 webhook verification. A forged webhook must NOT be able to trigger a USDC payout,
// so this is money-security-critical. A valid signature proves AUTHENTICITY only (that iyzico sent it) — NOT
// the payment outcome; the backend must always re-retrieve + validate before treating a PreAuth as a live
// hold. See docs and classify.ts.
//
// V3 signs a CONCATENATION OF PARSED FIELDS (not a body hash), with NO separator, where the account secret
// key is BOTH the HMAC key AND the leading concatenated field. The exact per-event field list differs by
// event family and is confirmed against a captured live sandbox event in Phase 4.5 — kept behind the
// `preimage` strategy so it can be swapped without touching any money logic.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookEvent {
  readonly iyziEventType: string;
  readonly iyziPaymentId?: string;
  readonly paymentId?: string;
  readonly token?: string;
  readonly paymentConversationId?: string;
  readonly status?: string;
}

export interface VerifyWebhookInput {
  /** the account secret key (env IYZICO_SECRET_KEY; WEBHOOK_SIGNING_SECRET defaults to it). */
  readonly signingSecret: string;
  /** the parsed, exactly-received webhook field strings. */
  readonly event: WebhookEvent;
  /** the X-IYZ-SIGNATURE-V3 header value. */
  readonly providedSignature: string | null | undefined;
}

// Hosted CheckoutForm / HPP-family events sign with the token; direct-API / 3DS events do not.
const HPP_EVENTS: ReadonlySet<string> = new Set([
  'CHECKOUT_FORM_AUTH',
  'BANK_TRANSFER_AUTH',
  'CREDIT_PAYMENT_AUTH',
  'CREDIT_PAYMENT_PENDING',
  'CREDIT_PAYMENT_INIT',
  'PWI_TKN_FUND',
  'PWI_TKN_AUTH',
  'PWI_TKN_THREEDS_AUTH',
  'CONTACTLESS_AUTH',
  'CONTACTLESS_REFUND',
]);

/** Reconstruct the signed preimage, or null if a required field is absent (cannot verify -> reject).
 *  NOTE (canonicalization, Phase 4.5): fields are concatenated with NO separator, so the MAC does not
 *  uniquely bind the field decomposition — a holder of one genuine signature could re-slice interior
 *  boundaries (e.g. paymentId/token) into a different tuple that verifies. This is NOT a forgery (no secret,
 *  no minting) and is NOT the money gate (the backend re-retrieves by paymentId server-side before any USDC
 *  step). When iyzico's exact V3 preimage is captured live, add domain separation here. */
function preimage(secretKey: string, e: WebhookEvent): string | null {
  if (e.iyziEventType === undefined || e.iyziEventType === '') return null; // family selector is required
  const status = e.status;
  const conv = e.paymentConversationId;
  if (status === undefined || conv === undefined) return null;

  if (HPP_EVENTS.has(e.iyziEventType)) {
    // secretKey + iyziEventType + iyziPaymentId + token + paymentConversationId + status
    if (e.iyziPaymentId === undefined || e.token === undefined) return null;
    return secretKey + e.iyziEventType + e.iyziPaymentId + e.token + conv + status;
  }
  // direct API / 3DS: secretKey + iyziEventType + paymentId + paymentConversationId + status
  if (e.paymentId === undefined) return null;
  return secretKey + e.iyziEventType + e.paymentId + conv + status;
}

/**
 * Returns true ONLY if the provided signature is a valid HMAC-SHA256 (lowercase hex) of the reconstructed
 * preimage under the signing secret. Fails CLOSED on a missing/empty signature, a missing required field,
 * or a length mismatch — each short-circuits to false BEFORE the constant-time compare (timingSafeEqual
 * throws on unequal lengths and is never a length oracle here). Never throws.
 */
export function verifyWebhookSignature(input: VerifyWebhookInput): boolean {
  // Fail closed on a missing/empty signing secret: an empty HMAC key is attacker-known, so verification
  // under it would be a fail-OPEN on a misconfigured deploy. (The factory also rejects empty secrets.)
  if (typeof input.signingSecret !== 'string' || input.signingSecret.length === 0) return false;

  const provided = input.providedSignature;
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const pre = preimage(input.signingSecret, input.event);
  if (pre === null) return false;

  const expected = Buffer.from(
    createHmac('sha256', input.signingSecret).update(pre).digest('hex'),
    'hex',
  );
  // Buffer.from(hex,'hex') stops at the first non-hex nibble, so a malformed header yields a short buffer
  // that fails the length guard below rather than a partial constant-time compare.
  const got = Buffer.from(provided.toLowerCase(), 'hex');
  if (expected.length === 0 || expected.length !== got.length) return false;

  return timingSafeEqual(expected, got);
}
