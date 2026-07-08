// Byte-exact replica of @troia/core deriveMemo, so the memoHex the extension sends to POST /intent always
// equals deriveMemo(orderId) on the backend — otherwise PayoutIntent.build fail-closes with MemoMismatch.
//
//   memo = SHA-256( lp(utf8("troia.memo.v1")) ‖ lp(utf8(NFC(orderId))) )      lp(b) = u32be(len(b)) ‖ b
//
// Uses Web Crypto (crypto.subtle), available in the content script (localhost is a secure context) and the
// background service worker. order_id is canonicalized exactly like core (NFC; lone surrogates rejected). The
// test checks this replica against the SAME golden vectors core tests against
// (packages/core/test/fixtures/derive-ids.golden.json), so any drift in core breaks the extension's test too.

const MEMO_TAG = 'troia.memo.v1';

// A lone (unpaired) UTF-16 surrogate encodes ambiguously to UTF-8, so @troia/core's canonicalizeOrderId rejects
// it (fail-closed) instead of emitting a replacement char. Mirror that exactly, so the extension and the backend
// agree byte-for-byte on which order_ids are even representable.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Mirror of @troia/core canonicalizeOrderId: reject a lone surrogate, else return the NFC form — so a
 *  logically-equal order_id always produces identical bytes on both sides. */
export function canonicalizeOrderId(raw: string): string {
  if (LONE_SURROGATE.test(raw)) {
    throw new Error('order_id is not well-formed Unicode (contains a lone surrogate)');
  }
  return raw.normalize('NFC');
}

// Return the concrete `Uint8Array<ArrayBuffer>` (not the default ArrayBufferLike) so the digest input is a
// valid BufferSource under TS 6's stricter typed-array generics.
function u32be(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false); // big-endian, unsigned
  return b;
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + bytes.length);
  out.set(u32be(bytes.length), 0);
  out.set(bytes, 4);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The canonical 32-byte settlement memo for an orderId, hex-encoded (64 chars). */
export async function deriveMemoHex(orderId: string): Promise<string> {
  const enc = new TextEncoder();
  const tag = lengthPrefixed(enc.encode(MEMO_TAG));
  const id = lengthPrefixed(enc.encode(canonicalizeOrderId(orderId)));
  const digest = await crypto.subtle.digest('SHA-256', concat(tag, id));
  return toHex(new Uint8Array(digest));
}
