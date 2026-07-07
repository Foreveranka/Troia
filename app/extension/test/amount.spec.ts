import { describe, expect, it } from 'vitest';
import { toStroops } from '../src/lib/amount';

describe('toStroops', () => {
  it('converts whole and 2-decimal USDC amounts (7-decimal stroops)', () => {
    expect(toStroops('62.00')).toBe(620000000n);
    expect(toStroops('62')).toBe(620000000n);
    expect(toStroops('1')).toBe(10000000n);
    expect(toStroops('0.01')).toBe(100000n);
  });

  it('handles full 7-decimal precision', () => {
    expect(toStroops('62.5')).toBe(625000000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('1234.1234567')).toBe(12341234567n);
  });

  it('rejects more than 7 fractional digits (fail-closed, no truncation)', () => {
    expect(toStroops('1.12345678')).toBeNull();
  });

  it('rejects zero and non-positive', () => {
    expect(toStroops('0')).toBeNull();
    expect(toStroops('0.00')).toBeNull();
    expect(toStroops('-5')).toBeNull();
  });

  it('rejects non-decimal junk', () => {
    expect(toStroops('')).toBeNull();
    expect(toStroops('abc')).toBeNull();
    expect(toStroops('1e3')).toBeNull();
    expect(toStroops('1.2.3')).toBeNull();
    expect(toStroops('62,00')).toBeNull();
    expect(toStroops(' 62')).toBeNull();
  });

  it('uses exact integer math (no float error) on a tricky value', () => {
    // 0.1 + 0.2 in float is 0.30000000000000004; string/BigInt math must be exact.
    expect(toStroops('0.3')).toBe(3000000n);
  });
});
