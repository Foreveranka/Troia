import { createHash } from 'node:crypto';

// Canonical, byte-exact identity derivation. Every per-order identity comes from one order_id via
// one pure function, so two independent implementations produce byte-identical output. See
// docs/ARCHITECTURE.md §4 and test/fixtures/derive-ids.golden.json.
//
// Canonical input rules (pinned so two implementers cannot diverge — verified independently):
//   - order_id is NFC-normalized before UTF-8 encoding; lone surrogates are rejected.
//   - destination is hashed as raw ASCII bytes: no trimming, no case-folding; non-ASCII is rejected
//     (never silently masked).
//   - amount is an i128 in stroops, restricted to [-2^127, 2^127-1]; out-of-range is rejected.
// Emptiness of order_id and non-positive amounts are ALLOWED here (byte-level concerns); the
// "non-empty" / "amount > 0" business rules live in PayoutIntent.build (fail-closed, Phase 1.2).

const MEMO_TAG = 'troia.memo.v1';
const TXID_TAG = 'troia.txid.v1';
const IDEM_TAG = 'troia.idem.v1';

const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;

// A lone (unpaired) UTF-16 surrogate: a high surrogate not followed by a low one, or a low
// surrogate not preceded by a high one. Such strings are not well-formed Unicode and encode
// ambiguously to UTF-8 across languages (strict error vs U+FFFD vs WTF-8).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// eslint-disable-next-line no-control-regex -- control chars are valid ASCII bytes; we only reject > 0x7F
const NON_ASCII = /[^\x00-\x7F]/;

export type DeriveIdsErrorCode = 'OrderIdNotWellFormed' | 'DestinationNotAscii' | 'AmountOutOfRange';

export class DeriveIdsError extends Error {
  readonly code: DeriveIdsErrorCode;
  constructor(code: DeriveIdsErrorCode, message: string) {
    super(message);
    this.name = 'DeriveIdsError';
    this.code = code;
  }
}

/**
 * The single authority for order_id canonical form. Rejects malformed Unicode (lone surrogates)
 * and returns the NFC-normalized string, so logically-equal ids always produce identical bytes.
 * Callers that persist or key on order_id (e.g. SequenceAllocator.allocate, DB rows) MUST store
 * THIS canonical form so every guard derives from the same identity.
 */
export function canonicalizeOrderId(raw: string): string {
  // Defensive at the trust boundary: RawPayout.orderId is typed `string`, but inputs arriving from
  // JSON / queues / DB rows are not type-checked. A non-string here must fail closed, not throw.
  if (typeof raw !== 'string') {
    throw new DeriveIdsError('OrderIdNotWellFormed', 'order_id must be a string');
  }
  if (LONE_SURROGATE.test(raw)) {
    throw new DeriveIdsError(
      'OrderIdNotWellFormed',
      'order_id is not well-formed Unicode (contains a lone surrogate)',
    );
  }
  return raw.normalize('NFC');
}

/** 4-byte big-endian unsigned length. */
function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** lp(b) = u32be(len(b)) ‖ b — length-prefix for variable-width fields (prevents concat collisions). */
function lengthPrefixed(bytes: Buffer): Buffer {
  return Buffer.concat([u32be(bytes.length), bytes]);
}

/** amount as a 16-byte big-endian two's-complement i128 (fixed width, NO length prefix). */
function amountBe16(amount: bigint): Buffer {
  const mask = (1n << 128n) - 1n;
  let v = amount & mask; // wrap into 128-bit two's complement (negatives => high bytes set)
  const out = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function sha256(bytes: Buffer): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function tag(value: string): Buffer {
  return lengthPrefixed(Buffer.from(value, 'utf8'));
}

/** Single source of the memo formula, shared by deriveMemo and deriveIds so they cannot drift. */
function computeMemo(orderIdBytes: Buffer): Buffer {
  return sha256(Buffer.concat([tag(MEMO_TAG), lengthPrefixed(orderIdBytes)]));
}

/**
 * Derive only the memo (settlement-ref) from order_id. Used by PayoutIntent.build to check the
 * provided memo against the canonical one without needing destination/amount.
 */
export function deriveMemo(orderId: string): Uint8Array {
  return computeMemo(Buffer.from(canonicalizeOrderId(orderId), 'utf8'));
}

export interface DerivedIds {
  /** settlement-ref and pay() memo argument (BytesN<32>). */
  readonly memo: Uint8Array;
  /** contract DataKey::Processed replay-guard key (BytesN<32>). Derived from order_id, NOT tx_hash. */
  readonly txId: Uint8Array;
  /** general dedup / idempotency key. */
  readonly idempotencyKey: Uint8Array;
  readonly memoHex: string;
  readonly txIdHex: string;
  readonly idempotencyKeyHex: string;
}

/**
 * Derive memo, tx_id, and idempotency_key from a single order_id. Pure and deterministic — no
 * network, no clock, no randomness. Throws DeriveIdsError for inputs outside the canonical domain
 * (see the module header). `destination` is an OPAQUE ASCII StrKey ("G…"/"C…"); its checksum,
 * trustline, and allowlist validity are enforced in PayoutIntent.build, never here.
 */
export function deriveIds(orderId: string, destination: string, amount: bigint): DerivedIds {
  if (amount < I128_MIN || amount > I128_MAX) {
    throw new DeriveIdsError('AmountOutOfRange', `amount ${amount} is outside the i128 range`);
  }
  if (NON_ASCII.test(destination)) {
    throw new DeriveIdsError('DestinationNotAscii', 'destination must be an ASCII StrKey string');
  }

  const orderIdBytes = Buffer.from(canonicalizeOrderId(orderId), 'utf8');
  const destinationBytes = Buffer.from(destination, 'ascii');

  const memo = computeMemo(orderIdBytes);
  const txId = sha256(Buffer.concat([tag(TXID_TAG), lengthPrefixed(orderIdBytes)]));
  const idempotencyKey = sha256(
    Buffer.concat([
      tag(IDEM_TAG),
      lengthPrefixed(orderIdBytes),
      lengthPrefixed(destinationBytes),
      amountBe16(amount),
      memo, // 32 raw bytes, appended without a length prefix
    ]),
  );

  return {
    memo,
    txId,
    idempotencyKey,
    memoHex: memo.toString('hex'),
    txIdHex: txId.toString('hex'),
    idempotencyKeyHex: idempotencyKey.toString('hex'),
  };
}
