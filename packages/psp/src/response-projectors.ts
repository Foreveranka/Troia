// PURE projectors: extract the happy-path fields the NEXT step needs from a raw iyzico body. A missing or
// wrong-typed required field returns { kind: 'malformed' } rather than a fabricated value — a projector can
// never make an absent field masquerade as a real one. The money VERDICT is classify.ts's job; projectors
// only carry forward tokens/ids on the success path.

import type {
  CheckoutFormInitFields,
  CheckoutFormResultFields,
  PaymentFields,
  Projection,
  RawIyzicoResult,
} from './outcomes.js';

function bodyOf(raw: RawIyzicoResult): Readonly<Record<string, unknown>> | null {
  return raw.kind === 'body' ? raw.body : null;
}
function str(body: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}
function reasonOf(raw: RawIyzicoResult): string {
  return raw.kind === 'timeout' ? 'transport timeout' : raw.kind === 'malformed' ? raw.reason : 'unknown';
}

export function projectCheckoutFormInit(raw: RawIyzicoResult): Projection<CheckoutFormInitFields> {
  const body = bodyOf(raw);
  if (body === null) return { kind: 'malformed', reason: reasonOf(raw) };
  const token = str(body, 'token');
  const checkoutFormContent = str(body, 'checkoutFormContent');
  const conversationId = str(body, 'conversationId');
  if (token === undefined || checkoutFormContent === undefined || conversationId === undefined) {
    return { kind: 'malformed', reason: 'missing token/checkoutFormContent/conversationId' };
  }
  // paymentPageUrl is optional: iyzico returns it for the hosted page, but its absence must not malform a
  // valid init (the content-embed path still works). Only carry it forward when present.
  const paymentPageUrl = str(body, 'paymentPageUrl');
  return {
    kind: 'ok',
    token,
    checkoutFormContent,
    conversationId,
    ...(paymentPageUrl !== undefined ? { paymentPageUrl } : {}),
  };
}

export function projectCheckoutFormResult(raw: RawIyzicoResult): Projection<CheckoutFormResultFields> {
  const body = bodyOf(raw);
  if (body === null) return { kind: 'malformed', reason: reasonOf(raw) };
  const token = str(body, 'token');
  const paymentId = str(body, 'paymentId');
  const paymentStatus = str(body, 'paymentStatus');
  const conversationId = str(body, 'conversationId');
  if (token === undefined || paymentId === undefined || paymentStatus === undefined || conversationId === undefined) {
    return { kind: 'malformed', reason: 'missing token/paymentId/paymentStatus/conversationId' };
  }
  return { kind: 'ok', token, paymentId, paymentStatus, conversationId };
}

/** For PreAuth / PostAuth / Cancel — carries the paymentId forward. */
export function projectPayment(raw: RawIyzicoResult): Projection<PaymentFields> {
  const body = bodyOf(raw);
  if (body === null) return { kind: 'malformed', reason: reasonOf(raw) };
  const paymentId = str(body, 'paymentId');
  const conversationId = str(body, 'conversationId');
  if (paymentId === undefined || conversationId === undefined) {
    return { kind: 'malformed', reason: 'missing paymentId/conversationId' };
  }
  return { kind: 'ok', paymentId, conversationId };
}
