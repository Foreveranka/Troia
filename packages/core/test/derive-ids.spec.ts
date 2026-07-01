import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalizeOrderId, deriveIds, DeriveIdsError } from '../src/index.js';

interface GoldenVector {
  name: string;
  order_id: string;
  destination: string;
  amount: string;
  memo: string;
  tx_id: string;
  idempotency_key: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(here, 'fixtures', 'derive-ids.golden.json'), 'utf8'),
) as { vectors: GoldenVector[] };

const I128_MAX = 2n ** 127n - 1n;
const I128_MIN = -(2n ** 127n);

describe('deriveIds — golden vectors', () => {
  for (const v of golden.vectors) {
    it(`matches golden hex for "${v.name}"`, () => {
      const ids = deriveIds(v.order_id, v.destination, BigInt(v.amount));
      expect(ids.memoHex).toBe(v.memo);
      expect(ids.txIdHex).toBe(v.tx_id);
      expect(ids.idempotencyKeyHex).toBe(v.idempotency_key);
    });
  }

  it('produces 32-byte outputs', () => {
    const ids = deriveIds('ord-001', 'GAAA', 1n);
    expect(ids.memo).toHaveLength(32);
    expect(ids.txId).toHaveLength(32);
    expect(ids.idempotencyKey).toHaveLength(32);
    expect(ids.memoHex).toHaveLength(64);
  });
});

describe('deriveIds — properties', () => {
  it('is deterministic (same inputs → same output)', () => {
    const a = deriveIds('ord-001', 'GDEST', 15000000n);
    const b = deriveIds('ord-001', 'GDEST', 15000000n);
    expect(a.idempotencyKeyHex).toBe(b.idempotencyKeyHex);
    expect(a.memoHex).toBe(b.memoHex);
  });

  it('memo and tx_id depend only on order_id, not destination or amount', () => {
    const a = deriveIds('ord-x', 'GAAA', 1n);
    const b = deriveIds('ord-x', 'GBBB', 999n);
    expect(a.memoHex).toBe(b.memoHex);
    expect(a.txIdHex).toBe(b.txIdHex);
  });

  it('idempotency_key changes with destination and amount', () => {
    const base = deriveIds('ord-x', 'GAAA', 1n);
    expect(deriveIds('ord-x', 'GBBB', 1n).idempotencyKeyHex).not.toBe(base.idempotencyKeyHex);
    expect(deriveIds('ord-x', 'GAAA', 2n).idempotencyKeyHex).not.toBe(base.idempotencyKeyHex);
  });

  it('domain separation: memo, tx_id, idempotency_key all differ for the same order_id', () => {
    const ids = deriveIds('ord-001', 'GAAA', 1n);
    expect(new Set([ids.memoHex, ids.txIdHex, ids.idempotencyKeyHex]).size).toBe(3);
  });
});

describe('deriveIds — canonicalization & validation', () => {
  it('NFC-normalizes order_id: NFD and NFC forms of the same id hash identically', () => {
    const nfc = 'café'; // U+00E9
    const nfd = 'café'; // 'e' + combining acute accent
    expect(nfc).not.toBe(nfd); // different UTF-16, same logical id
    const a = deriveIds(nfc, 'GAAA', 1n);
    const b = deriveIds(nfd, 'GAAA', 1n);
    expect(a.memoHex).toBe(b.memoHex);
    expect(a.idempotencyKeyHex).toBe(b.idempotencyKeyHex);
  });

  it('canonicalizeOrderId returns the NFC form and allows empty', () => {
    expect(canonicalizeOrderId('café')).toBe('café');
    expect(canonicalizeOrderId('')).toBe('');
  });

  it('rejects order_id with a lone surrogate', () => {
    expect(() => deriveIds('ab\uD83D', 'GAAA', 1n)).toThrow(DeriveIdsError);
    try {
      canonicalizeOrderId('\uDC00');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DeriveIdsError);
      expect((e as DeriveIdsError).code).toBe('OrderIdNotWellFormed');
    }
  });

  it('rejects non-ASCII destination instead of silently masking', () => {
    try {
      deriveIds('ord-1', 'GÇ', 1n);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DeriveIdsError);
      expect((e as DeriveIdsError).code).toBe('DestinationNotAscii');
    }
  });

  it('accepts the i128 boundaries and rejects just outside them', () => {
    expect(() => deriveIds('ord-1', 'GAAA', I128_MAX)).not.toThrow();
    expect(() => deriveIds('ord-1', 'GAAA', I128_MIN)).not.toThrow();
    for (const bad of [I128_MAX + 1n, I128_MIN - 1n, 2n ** 200n]) {
      try {
        deriveIds('ord-1', 'GAAA', bad);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(DeriveIdsError);
        expect((e as DeriveIdsError).code).toBe('AmountOutOfRange');
      }
    }
  });
});
