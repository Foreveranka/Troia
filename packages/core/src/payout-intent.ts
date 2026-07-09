import { canonicalizeOrderId, deriveIds, deriveMemo, DeriveIdsError } from './derive-ids.js';
import type { DerivedIds } from './derive-ids.js';
import { classifyAddress } from './strkey.js';
import type { AddressType } from './strkey.js';
import { err, ok } from './result.js';
import type { Result } from './result.js';

// Invariant ① — MEMO FAIL-CLOSED. A PayoutIntent cannot exist unless order_id, address, memo,
// amount, issuer, and trustline are all valid. Any miss returns a BuildError; nothing partial is
// ever constructed. See docs/ARCHITECTURE.md §6 and troia-olay-orgusu.md §5/§6.

/** Flat taxonomy (no nesting). The order below is the DETERMINISTIC control order build() uses. */
export type BuildError =
  | 'OrderIdMalformed' // not well-formed Unicode (lone surrogate)
  | 'OrderIdEmpty' // empty after canonicalization
  | 'AddressInvalidChecksum' // destination is not a valid G/C StrKey
  | 'MemoMissing'
  | 'MemoWrongLength' // present but not 32 bytes
  | 'MemoZero' // 32 zero bytes
  | 'MemoMismatch' // 32 non-zero bytes but != deriveMemo(order_id)
  | 'AmountNonPositive' // amount <= 0, or above the i128 max (not a valid positive payable amount)
  | 'IssuerNotAllowlisted'
  | 'TrustlineMissing'; // classic destination lacks the USDC trustline

// Largest representable i128 (Soroban amount type). Amounts must be a positive i128 so the later
// deriveIds call (which enforces the same bound) can never throw — build() stays total.
const I128_MAX = 2n ** 127n - 1n;

const BUILD_ERROR_ORDER: readonly BuildError[] = [
  'OrderIdMalformed',
  'OrderIdEmpty',
  'AddressInvalidChecksum',
  'MemoMissing',
  'MemoWrongLength',
  'MemoZero',
  'MemoMismatch',
  'AmountNonPositive',
  'IssuerNotAllowlisted',
  'TrustlineMissing',
];

/** Exposed so tests / callers can reason about the control order without duplicating it. */
export function buildErrorRank(error: BuildError): number {
  return BUILD_ERROR_ORDER.indexOf(error);
}

export interface RawPayout {
  readonly orderId: string;
  readonly destination: string;
  readonly amount: bigint; // stroops
  readonly assetIssuer: string; // issuer G-address of the USDC being paid
  readonly memo?: string | Uint8Array | null; // provided memo (64-char hex or 32 raw bytes)
}

export interface Trustline {
  readonly assetCode: string;
  readonly assetIssuer: string;
}

export interface AccountSnapshot {
  readonly exists: boolean;
  readonly trustlines: readonly Trustline[];
}

export interface BuildContext {
  /** Snapshot of the destination account; the network read is the loader's job, not build()'s. */
  readonly snapshot: AccountSnapshot;
  readonly allowedIssuers: readonly string[];
  /** Defaults to 'USDC'. */
  readonly assetCode?: string;
}

export interface ValidatedPayout {
  readonly orderId: string; // canonical (NFC)
  readonly destination: string;
  readonly destinationType: Exclude<AddressType, 'invalid'>;
  readonly amount: bigint;
  readonly assetIssuer: string;
  readonly memo: Uint8Array; // validated; equals deriveMemo(orderId)
  readonly ids: DerivedIds;
}

type MemoDecode = Uint8Array | 'missing' | 'wrong-length';

function decodeMemo(memo: string | Uint8Array | null | undefined): MemoDecode {
  if (memo == null) return 'missing';
  if (typeof memo === 'string') {
    if (memo.length === 0) return 'missing';
    if (memo.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(memo)) return 'wrong-length';
    return Buffer.from(memo, 'hex');
  }
  // Only genuine bytes are accepted; a plain array / arbitrary object is not a valid memo.
  if (!(memo instanceof Uint8Array)) return 'wrong-length';
  if (memo.length !== 32) return 'wrong-length';
  return memo;
}

function isAllZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export class PayoutIntent {
  private constructor(readonly fields: ValidatedPayout) {}

  /**
   * The ONLY way to construct a PayoutIntent. Runs validations in a fixed, deterministic order and
   * returns the FIRST failure, so multi-violation inputs always yield the same BuildError (required
   * for golden / fail-closed tests). Pure: no network, no clock.
   */
  static build(raw: RawPayout, ctx: BuildContext): Result<PayoutIntent, BuildError> {
    // 1) order_id well-formed
    let canonicalOrderId: string;
    try {
      canonicalOrderId = canonicalizeOrderId(raw.orderId);
    } catch (e) {
      if (e instanceof DeriveIdsError && e.code === 'OrderIdNotWellFormed')
        return err('OrderIdMalformed');
      throw e;
    }

    // 2) order_id non-empty (business rule)
    if (canonicalOrderId.length === 0) return err('OrderIdEmpty');

    // 3) destination checksum + type (a non-string fails closed as an invalid address)
    if (typeof raw.destination !== 'string') return err('AddressInvalidChecksum');
    const destinationType = classifyAddress(raw.destination);
    if (destinationType === 'invalid') return err('AddressInvalidChecksum');

    // 4-7) memo: present -> 32 bytes -> non-zero -> equals derived
    const decoded = decodeMemo(raw.memo);
    if (decoded === 'missing') return err('MemoMissing');
    if (decoded === 'wrong-length') return err('MemoWrongLength');
    if (isAllZero(decoded)) return err('MemoZero');
    if (!bytesEqual(decoded, deriveMemo(canonicalOrderId))) return err('MemoMismatch');

    // 8) amount is a positive i128. The `typeof bigint` check is load-bearing: a JS number or
    // numeric string passes the relational comparisons (Number-vs-BigInt compares are legal) but
    // would throw in deriveIds' bitwise `&`. Reject non-bigints here so build() stays total.
    if (typeof raw.amount !== 'bigint' || raw.amount <= 0n || raw.amount > I128_MAX) {
      return err('AmountNonPositive');
    }

    // 9) issuer allowlisted
    if (!ctx.allowedIssuers.includes(raw.assetIssuer)) return err('IssuerNotAllowlisted');

    // 10) trustline — classic accounts must hold the USDC trustline; contracts need none
    if (destinationType === 'ed25519') {
      const assetCode = ctx.assetCode ?? 'USDC';
      const hasTrustline =
        ctx.snapshot.exists &&
        ctx.snapshot.trustlines.some(
          (t) => t.assetCode === assetCode && t.assetIssuer === raw.assetIssuer,
        );
      if (!hasTrustline) return err('TrustlineMissing');
    }

    const ids = deriveIds(canonicalOrderId, raw.destination, raw.amount);
    return ok(
      new PayoutIntent({
        orderId: canonicalOrderId,
        destination: raw.destination,
        destinationType,
        amount: raw.amount,
        assetIssuer: raw.assetIssuer,
        memo: decoded,
        ids,
      }),
    );
  }
}
