// Byte-exact replica of @troia/core deriveMemo, so the memoHex the extension sends to POST /intent always
// equals deriveMemo(orderId) on the backend — otherwise PayoutIntent.build fail-closes with MemoMismatch.
//
//   memo = SHA-256( lp(utf8("troia.memo.v1")) ‖ lp(utf8(NFC(orderId))) )      lp(b) = u32be(len(b)) ‖ b
//
// Uses Web Crypto (crypto.subtle), available in the content script (localhost is a secure context) and the
// background service worker. Verified against authoritative vectors generated from the core implementation.

const MEMO_TAG = 'troia.memo.v1';

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
  const id = lengthPrefixed(enc.encode(orderId.normalize('NFC')));
  const digest = await crypto.subtle.digest('SHA-256', concat(tag, id));
  return toHex(new Uint8Array(digest));
}
