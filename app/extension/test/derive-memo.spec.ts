// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalizeOrderId, deriveMemoHex } from '../src/lib/derive-memo';

// Parity is enforced against the SAME golden vectors @troia/core tests itself against - NOT a hand-copied
// snapshot. If core's memo algorithm ever changes, core regenerates this fixture, this replica no longer
// matches it, and THIS test fails - instead of every real payment silently failing MemoMismatch in the field.
interface GoldenVector {
  name: string;
  order_id: string;
  memo: string;
}
const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, '../../../packages/core/test/fixtures/derive-ids.golden.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { vectors: GoldenVector[] };

describe('deriveMemoHex - parity with core golden vectors', () => {
  for (const v of golden.vectors) {
    it(`matches core's memo for "${v.name}" (order_id ${JSON.stringify(v.order_id)})`, async () => {
      expect(await deriveMemoHex(v.order_id)).toBe(v.memo);
    });
  }

  it('the golden set actually covers the empty order_id and a non-ASCII order_id', () => {
    const ids = golden.vectors.map((v) => v.order_id);
    expect(ids).toContain(''); // empty-order-id vector
    // eslint-disable-next-line no-control-regex
    expect(ids.some((id) => /[^\x00-\x7F]/.test(id))).toBe(true); // unicode vector
  });
});

describe('deriveMemoHex - canonicalization (mirrors core)', () => {
  // Strings are built from \u escapes + runtime normalize (never file literals) so the file's own encoding
  // cannot flatten NFC and NFD to the same bytes.
  const NFC = 'café'; // "cafe" + precomposed e-acute (U+00E9) — already NFC
  const NFD = NFC.normalize('NFD'); // "cafe" + combining acute accent (U+0301)

  it('NFC-normalizes: NFD and NFC forms of the same id hash identically', async () => {
    expect(NFD).not.toBe(NFC); // different UTF-16, same logical id — this is what pins normalize('NFC')
    expect(await deriveMemoHex(NFD)).toBe(await deriveMemoHex(NFC));
  });

  it('rejects a lone surrogate exactly like core (fail-closed, not a replacement char)', () => {
    expect(() => canonicalizeOrderId('ab\uD83D')).toThrow(); // lone high surrogate
    expect(() => canonicalizeOrderId('\uDC00')).toThrow(); // lone low surrogate
    expect(canonicalizeOrderId(NFC)).toBe(NFC); // well-formed passes through (already NFC)
    expect(canonicalizeOrderId(NFD)).toBe(NFC); // decomposed input is returned in NFC form
    expect(canonicalizeOrderId('')).toBe(''); // empty is allowed (the non-empty rule lives in buildIntentBody)
  });

  it('deriveMemoHex rejects a lone-surrogate order_id rather than hashing U+FFFD', async () => {
    await expect(deriveMemoHex('ab\uD83D')).rejects.toThrow();
  });

  it('returns a 64-char lowercase hex string and is deterministic', async () => {
    expect(await deriveMemoHex('ST-AB12CD')).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveMemoHex('ST-AB12CD')).toBe(await deriveMemoHex('ST-AB12CD'));
  });
});
