// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveMemoHex } from '../src/lib/derive-memo';

// Authoritative vectors generated from the REAL @troia/core deriveMemo (packages/core/dist/derive-ids.js).
// If the extension's replica ever drifts by a byte, these fail — and the backend would reject the memo with
// MemoMismatch. The unicode case pins NFC normalization + UTF-8 encoding.
const VECTORS: ReadonlyArray<{ orderId: string; memoHex: string }> = [
  { orderId: 'ST-AB12CD', memoHex: 'e01397d329505f05c70b253c3f2e925f488cd5b07a9d9336e36c463f96020db0' },
  { orderId: 'ST-XYZ999AB', memoHex: 'e9ed3b73f14c035a60ec7a830f41258ecf4ed5510e45f417f03bcbfcd6bb804d' },
  { orderId: 'order-123', memoHex: '358bc335f73c6546e0959563644197eb9bc095c66c8562a759a2bac8801f21fb' },
  { orderId: 'ünïcödë-42', memoHex: 'aecf64393794934ac4ca089390225d2154636bad961a01eb520465ec6cdb85f0' },
];

describe('deriveMemoHex', () => {
  for (const v of VECTORS) {
    it(`matches core for "${v.orderId}"`, async () => {
      expect(await deriveMemoHex(v.orderId)).toBe(v.memoHex);
    });
  }

  it('returns a 64-char lowercase hex string', async () => {
    expect(await deriveMemoHex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', async () => {
    expect(await deriveMemoHex('ST-AB12CD')).toBe(await deriveMemoHex('ST-AB12CD'));
  });
});
