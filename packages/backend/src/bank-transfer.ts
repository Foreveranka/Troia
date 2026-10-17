// Provider-neutral merchant checkout. Never accept payment evidence from the browser.
import type { Event } from '@troia/core';
import type { OrderCtx } from './ctx.js';
import { isDurableLogFailure } from './ports.js';

export interface BankTransferInstructions {
  readonly providerId: string;
  readonly transferId: string;
  readonly orderId: string;
  readonly reference: string;
  readonly iban: string;
  readonly beneficiary: string;
  readonly amountTry: string;
  readonly currency: 'TRY';
  readonly expiresAtUnix: number;
  /** Public, order-scoped sandbox capability; never a bank credential. */
  readonly sandboxToken?: string;
}

export interface BankTransferRequest {
  readonly minimumUsdcStroops?: string;
  readonly reference: string;
  readonly orderId: string;
  readonly idempotencyKey: string;
  readonly amountTry: string;
  readonly currency: 'TRY';
  readonly expiresAtUnix: number;
}

/** 128 bits from the backend's order-derived identity; stable on retries, distinct per purchase. */
export function bankTransferReference(idempotencyKey: string): string {
  if (!/^[a-f0-9]{64}$/i.test(idempotencyKey)) throw new Error('Invalid bank reference identity');
  return `TROIA-${idempotencyKey.slice(0, 32).toUpperCase()}`;
}

export interface BankTransferObservation {
  readonly providerId: string;
  readonly transferId: string;
  readonly orderId: string;
  readonly reference: string;
  readonly amountTry: string;
  readonly currency: string;
  /** received means cleared, final funds, not an initiated/pending bank transfer.
   * expired_unpaid means CLOSED with zero funds; late funds must be returned by the provider. */
  readonly status: 'pending' | 'received' | 'expired_unpaid' | 'review';
  readonly receivedAtUnix?: number;
}

export interface BankTransferProvider {
  readonly referenceMode?: 'provider';
  simulate?(instructions: BankTransferInstructions): Promise<void>;
  /** Must return the SAME transfer on every retry, including after a timeout/restart. */
  create(request: BankTransferRequest): Promise<BankTransferInstructions>;
  retrieve(instructions: BankTransferInstructions): Promise<BankTransferObservation>;
  /** Idempotent, to the ORIGINAL payer only. pending/unknown must not mean refunded. */
  refund(instructions: BankTransferInstructions): Promise<'refunded' | 'pending'>;
}

export function validTurkishIban(value: unknown): value is string {
  if (typeof value !== 'string' || !/^TR\d{24}$/.test(value)) return false;
  const digits = value.slice(4) + '2927' + value.slice(2, 4);
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

export function parseBankInstructions(value: unknown): BankTransferInstructions {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid bank instructions');
  const o = value as Record<string, unknown>;
  for (const field of ['providerId', 'transferId', 'orderId', 'reference', 'beneficiary']) {
    if (typeof o[field] !== 'string' || o[field].length === 0 || o[field].length > 256)
      throw new Error('Invalid bank instructions');
  }
  if (
    !validTurkishIban(o.iban) ||
    o.currency !== 'TRY' ||
    typeof o.amountTry !== 'string' ||
    !/^(0|[1-9]\d*)\.\d{2}$/.test(o.amountTry) ||
    BigInt(o.amountTry.replace('.', '')) <= 0n ||
    !Number.isSafeInteger(o.expiresAtUnix) ||
    (o.expiresAtUnix as number) <= 0
  )
    throw new Error('Invalid bank instructions');
  // Explicit projection: no provider secrets/extra fields may reach disk or the browser.
  return {
    providerId: o.providerId as string,
    transferId: o.transferId as string,
    orderId: o.orderId as string,
    reference: o.reference as string,
    iban: o.iban,
    beneficiary: o.beneficiary as string,
    amountTry: o.amountTry,
    currency: 'TRY',
    expiresAtUnix: o.expiresAtUnix as number,
    ...(o.providerId === 'tr-mock-anchor' &&
    typeof o.sandboxToken === 'string' &&
    /^[a-f0-9]{64}$/.test(o.sandboxToken)
      ? { sandboxToken: o.sandboxToken }
      : {}),
  };
}

export async function initializeBankTransfer(
  ctx: OrderCtx,
  provider: BankTransferProvider,
  expiresAtUnix: number,
): Promise<BankTransferInstructions | null> {
  try {
    const instructions = parseBankInstructions(
      await provider.create({
        orderId: ctx.orderId,
        idempotencyKey: ctx.conversationId,
        reference: bankTransferReference(ctx.conversationId),
        amountTry: ctx.paidPriceTry,
        currency: 'TRY',
        expiresAtUnix,
        minimumUsdcStroops: ctx.amountStroops.toString(),
      }),
    );
    if (
      instructions.orderId !== ctx.orderId ||
      instructions.amountTry !== ctx.paidPriceTry ||
      (provider.referenceMode !== 'provider' &&
        instructions.reference !== bankTransferReference(ctx.conversationId)) ||
      instructions.expiresAtUnix > expiresAtUnix
    )
      return null;
    return instructions;
  } catch (error) {
    if (isDurableLogFailure(error)) throw error;
    // Unknown create outcome is a durable wait. Retry ONLY with the same idempotency key.
    return null;
  }
}

/** Exact amount/reference/order/provider matching before the irreversible USDC leg. */
export function bankTransferEvent(
  expected: BankTransferInstructions,
  actual: BankTransferObservation,
  nowUnix: number,
): { event: Event; review: boolean } {
  const bound =
    actual.providerId === expected.providerId &&
    actual.transferId === expected.transferId &&
    actual.orderId === expected.orderId &&
    actual.reference === expected.reference &&
    actual.currency === 'TRY';
  if (!bound) return { event: { type: 'chargeUnknown' }, review: true };
  if (actual.status === 'received') {
    if (
      actual.amountTry !== expected.amountTry ||
      !Number.isSafeInteger(actual.receivedAtUnix) ||
      actual.receivedAtUnix! <= 0 ||
      actual.receivedAtUnix! > expected.expiresAtUnix ||
      actual.receivedAtUnix! > nowUnix
    )
      return { event: { type: 'chargeUnknown' }, review: true };
    return { event: { type: 'chargeOk' }, review: false };
  }
  if (actual.status === 'expired_unpaid' && actual.amountTry === '0.00')
    return { event: { type: 'chargeRejected' }, review: false };
  return { event: { type: 'chargeUnknown' }, review: actual.status !== 'pending' };
}
