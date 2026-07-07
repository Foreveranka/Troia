// Minimal Stellar strkey validation for ed25519 public keys ("G..." addresses). Fully offline and
// deterministic — the extension uses it as a confidence check before offering to pay; the backend's
// PayoutIntent.build remains the authoritative validator (same G-address + CRC16 rule, fail-closed).
//
// A strkey is base32(version_byte || payload || crc16). For an ed25519 public key the version byte is 6<<3
// (0x30), the payload is 32 bytes, and the checksum is CRC16-XModem over (version || payload), little-endian.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  let index = 0;
  const output = new Uint8Array(Math.floor((input.length * 5) / 8));
  for (const ch of input) {
    const idx = B32.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return output;
}

// CRC16-XModem (poly 0x1021, init 0x0000).
function crc16(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** True iff `address` is a well-formed, checksum-valid Stellar ed25519 public key ("G..."). */
export function isValidStellarPublicKey(address: string): boolean {
  if (!/^G[A-Z2-7]{55}$/.test(address)) return false;
  const decoded = base32Decode(address);
  if (decoded === null || decoded.length !== 35) return false;
  if (decoded[0] !== 0x30) return false; // version byte: ed25519 public key
  const checksum = decoded[33] | (decoded[34] << 8); // stored little-endian
  return crc16(decoded.subarray(0, 33)) === checksum;
}
