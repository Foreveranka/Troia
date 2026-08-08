// The wire format of the durable OrderCtx (the registry's ctx_json column): one JSON object per row, carrying
// its own version so schema drift is detected, never silently misread. Decoding FAILS CLOSED, exactly like the
// evidence codec: a row whose bytes are intact but whose shape is wrong means format drift or tampering, and a
// half-guessed ctx would be driven by the recovery worker with real money consequences.
//
// bigints go out as base-10 strings (JSON.stringify throws on raw bigint; a JSON number silently rounds past
// 2^53). Nullable fields are encoded as JSON null, never omitted — a missing key and a null key must stay
// distinguishable from format drift.

import type { OrderCtx } from '@troia/backend';

const CTX_VERSION = 1;
/** Canonical non-negative decimal: no sign, no exponent, no leading zeros, no whitespace. */
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export class OrderCtxCodecError extends Error {
  constructor(what: string) {
    super(`order ctx is not decodable: ${what}`);
    this.name = 'OrderCtxCodecError';
  }
}

/** Fixed key order, so a row's bytes are a pure function of its value. */
export function encodeOrderCtx(ctx: OrderCtx): string {
  return JSON.stringify({
    v: CTX_VERSION,
    orderId: ctx.orderId,
    conversationId: ctx.conversationId,
    destination: ctx.destination,
    amountStroops: String(ctx.amountStroops),
    appliedRateStroops: String(ctx.appliedRateStroops),
    memoHex: ctx.memoHex,
    paymentId: ctx.paymentId,
    token: ctx.token,
    paymentPageUrl: ctx.paymentPageUrl,
    paidPriceTry: ctx.paidPriceTry,
    spreadKurus: String(ctx.spreadKurus),
    feeKurus: String(ctx.feeKurus),
    currency: ctx.currency,
    ip: ctx.ip,
    activeSeq: ctx.activeSeq,
    hashHex: ctx.hashHex,
    signedXdr: ctx.signedXdr,
    payMaxTimeUnix: ctx.payMaxTimeUnix,
    deadRetries: ctx.deadRetries,
    reversalRetries: ctx.reversalRetries,
  });
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new OrderCtxCodecError(`bad ${field}`);
  return value;
}

function strOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new OrderCtxCodecError(`bad ${field}`);
  return value;
}

function big(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new OrderCtxCodecError(`non-canonical ${field}`);
  }
  return BigInt(value);
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OrderCtxCodecError(`bad ${field}`);
  }
  return value as number;
}

export function decodeOrderCtx(payload: string): OrderCtx {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new OrderCtxCodecError('not JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new OrderCtxCodecError('not an object');
  const o = raw as Record<string, unknown>;
  if (o.v !== CTX_VERSION) throw new OrderCtxCodecError(`unsupported version ${String(o.v)}`);
  const payMaxTimeUnix = o.payMaxTimeUnix;
  if (payMaxTimeUnix !== null && !Number.isSafeInteger(payMaxTimeUnix)) {
    throw new OrderCtxCodecError('bad payMaxTimeUnix');
  }
  return {
    orderId: str(o.orderId, 'orderId'),
    conversationId: str(o.conversationId, 'conversationId'),
    destination: str(o.destination, 'destination'),
    amountStroops: big(o.amountStroops, 'amountStroops'),
    appliedRateStroops: big(o.appliedRateStroops, 'appliedRateStroops'),
    memoHex: str(o.memoHex, 'memoHex'),
    paymentId: strOrNull(o.paymentId, 'paymentId'),
    token: strOrNull(o.token, 'token'),
    paymentPageUrl: strOrNull(o.paymentPageUrl, 'paymentPageUrl'),
    paidPriceTry: str(o.paidPriceTry, 'paidPriceTry'),
    spreadKurus: big(o.spreadKurus, 'spreadKurus'),
    feeKurus: big(o.feeKurus, 'feeKurus'),
    currency: str(o.currency, 'currency'),
    ip: str(o.ip, 'ip'),
    activeSeq: strOrNull(o.activeSeq, 'activeSeq'),
    hashHex: strOrNull(o.hashHex, 'hashHex'),
    signedXdr: strOrNull(o.signedXdr, 'signedXdr'),
    payMaxTimeUnix: payMaxTimeUnix as number | null,
    deadRetries: count(o.deadRetries, 'deadRetries'),
    reversalRetries: count(o.reversalRetries, 'reversalRetries'),
  };
}
