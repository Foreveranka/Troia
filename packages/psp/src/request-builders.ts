// PURE request builders. Each returns { path, body, json } where json === JSON.stringify(body) computed
// ONCE — the adapter signs that exact string and sends that exact string (sign-the-sent-string invariant).
// formatPrice matches iyzipay@2.0.69 utils.formatPrice on canonical decimal amounts, and fails CLOSED
// (throws) on empty/whitespace/partial-numeric/non-decimal input. It deliberately does NOT use parseFloat's
// leading-prefix salvage (parseFloat('10abc') === 10, '12.34.56' -> 12.34, '1,5' -> 1): a truncated amount
// would be silently signed and sent. Troia only ever formats clean decimals from its own pricing module.
// conversationId is INJECTED (the composition root derives it deterministically from the order); builders
// never invent entropy or read a clock, and reject an empty conversationId (it is the dedupe/correlation key).

import { PspBuildError } from './errors.js';
import type { Address, BasketItem, Buyer, Locale, PaymentCard } from './types.js';

export interface BuiltRequest {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly json: string;
}

// A non-negative canonical decimal string (no sign, no thousands separators, no scientific notation, no
// trailing garbage). This is the load-bearing fail-closed guard (mirrors the reconciler's amount guard).
const CANONICAL_PRICE = /^\d+(\.\d+)?$/;

/** Format a canonical decimal amount to iyzico's "N.M" form (append '.0' if integer). Byte-identical to the
 *  SDK for canonical decimals; fails CLOSED on empty/whitespace/partial-numeric/non-decimal input. */
export function formatPrice(price: number | string): string {
  if (typeof price === 'number') {
    if (!Number.isFinite(price)) throw new PspBuildError(`invalid price: ${String(price)}`);
    const r = price.toString();
    return r.includes('.') ? r : r + '.0';
  }
  if (typeof price === 'string' && CANONICAL_PRICE.test(price.trim())) {
    const r = Number(price.trim()).toString();
    return r.includes('.') ? r : r + '.0';
  }
  throw new PspBuildError(`invalid price: ${String(price)}`);
}

/** The conversationId is the idempotency/correlation key — an empty one would silently break dedupe. */
function requireConversationId(conversationId: string): void {
  if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
    throw new PspBuildError('conversationId (the dedupe/correlation key) must be a non-empty string');
  }
}

function finish(path: string, body: Record<string, unknown>): BuiltRequest {
  return { path, body, json: JSON.stringify(body) };
}

function normalizeItems(items: readonly BasketItem[]): Record<string, unknown>[] {
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    category1: i.category1,
    itemType: i.itemType,
    price: formatPrice(i.price),
  }));
}

// Money-first (Phase 4.6): the hosted form is the DIRECT-SALE (immediate-capture) checkout, NOT preauth.
// The user is charged on submit — there is no hold/provision to capture later.
const CHECKOUT_INITIALIZE_SALE_PATH = '/payment/iyzipos/checkoutform/initialize/ecom';
const CHECKOUT_RETRIEVE_PATH = '/payment/iyzipos/checkoutform/auth/ecom/detail';

export interface InitializeCheckoutFormParams {
  readonly locale?: Locale;
  readonly conversationId: string;
  readonly price: string | number;
  readonly paidPrice: string | number;
  readonly currency: string;
  readonly basketId: string;
  readonly paymentGroup: string;
  readonly callbackUrl: string;
  readonly buyer: Buyer;
  readonly shippingAddress: Address;
  readonly billingAddress: Address;
  readonly basketItems: readonly BasketItem[];
}

/** Checkout-form initialize on the DIRECT-SALE (immediate-capture) path — NOT the preauth (block/hold) path.
 *  The customer's TRY is charged when they submit; the pool only reserves USDC before this (money-first). */
export function buildInitializeCheckoutFormRequest(p: InitializeCheckoutFormParams): BuiltRequest {
  requireConversationId(p.conversationId);
  return finish(CHECKOUT_INITIALIZE_SALE_PATH, {
    locale: p.locale ?? 'tr',
    conversationId: p.conversationId,
    price: formatPrice(p.price),
    paidPrice: formatPrice(p.paidPrice),
    currency: p.currency,
    basketId: p.basketId,
    paymentGroup: p.paymentGroup,
    callbackUrl: p.callbackUrl,
    buyer: p.buyer,
    shippingAddress: p.shippingAddress,
    billingAddress: p.billingAddress,
    basketItems: normalizeItems(p.basketItems),
  });
}

export interface RetrieveCheckoutFormParams {
  readonly locale?: Locale;
  readonly conversationId: string;
  readonly token: string;
}

export function buildRetrieveCheckoutFormRequest(p: RetrieveCheckoutFormParams): BuiltRequest {
  requireConversationId(p.conversationId);
  return finish(CHECKOUT_RETRIEVE_PATH, {
    locale: p.locale ?? 'tr',
    conversationId: p.conversationId,
    token: p.token,
  });
}

export interface PreAuthParams {
  readonly locale?: Locale;
  readonly conversationId: string;
  readonly price: string | number;
  readonly paidPrice: string | number;
  readonly currency: string;
  readonly installment: number;
  readonly basketId: string;
  readonly paymentGroup: string;
  readonly paymentCard: PaymentCard;
  readonly buyer: Buyer;
  readonly shippingAddress: Address;
  readonly billingAddress: Address;
  readonly basketItems: readonly BasketItem[];
}

export function buildPreAuthRequest(p: PreAuthParams): BuiltRequest {
  requireConversationId(p.conversationId);
  return finish('/payment/preauth', {
    locale: p.locale ?? 'tr',
    conversationId: p.conversationId,
    price: formatPrice(p.price),
    paidPrice: formatPrice(p.paidPrice),
    currency: p.currency,
    installment: p.installment,
    paymentChannel: 'WEB',
    basketId: p.basketId,
    paymentGroup: p.paymentGroup,
    paymentCard: p.paymentCard,
    buyer: p.buyer,
    shippingAddress: p.shippingAddress,
    billingAddress: p.billingAddress,
    basketItems: normalizeItems(p.basketItems),
  });
}

export interface PostAuthParams {
  readonly locale?: Locale;
  readonly conversationId: string;
  readonly paymentId: string;
  readonly paidPrice: string | number;
  readonly currency: string;
  readonly ip: string;
}

export function buildPostAuthRequest(p: PostAuthParams): BuiltRequest {
  requireConversationId(p.conversationId);
  return finish('/payment/postauth', {
    locale: p.locale ?? 'tr',
    conversationId: p.conversationId,
    paymentId: p.paymentId,
    paidPrice: formatPrice(p.paidPrice),
    currency: p.currency,
    ip: p.ip,
  });
}

export interface RefundParams {
  readonly locale?: Locale;
  readonly conversationId: string;
  /** the per-item transaction id (from itemTransactions[]), NOT the paymentId. */
  readonly paymentTransactionId: string;
  readonly price: string | number;
  readonly currency: string;
  readonly ip: string;
}

export function buildRefundRequest(p: RefundParams): BuiltRequest {
  requireConversationId(p.conversationId);
  return finish('/payment/refund', {
    locale: p.locale ?? 'tr',
    conversationId: p.conversationId,
    paymentTransactionId: p.paymentTransactionId,
    price: formatPrice(p.price),
    currency: p.currency,
    ip: p.ip,
  });
}

export interface CancelParams {
  readonly locale?: Locale;
  readonly conversationId: string;
  /** the whole-payment id (same-day full void), NOT a per-item transaction id. */
  readonly paymentId: string;
  readonly ip: string;
}

export function buildCancelRequest(p: CancelParams): BuiltRequest {
  requireConversationId(p.conversationId);
  return finish('/payment/cancel', {
    locale: p.locale ?? 'tr',
    conversationId: p.conversationId,
    paymentId: p.paymentId,
    ip: p.ip,
  });
}
