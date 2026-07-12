import { describe, expect, it } from 'vitest';
import { formatApproxTry, toStroops } from '../src/lib/amount';

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

describe('formatApproxTry', () => {
  it('groups thousands and appends the indicative ≈ … TL suffix', () => {
    expect(formatApproxTry('2650.00')).toBe('≈ 2,650.00 TL');
    expect(formatApproxTry('41.42')).toBe('≈ 41.42 TL');
    expect(formatApproxTry('1234567.89')).toBe('≈ 1,234,567.89 TL');
    expect(formatApproxTry('999')).toBe('≈ 999 TL'); // no fractional part
  });

  it('is pure string formatting — keeps the fraction verbatim, no Number/float drift', () => {
    expect(formatApproxTry('10000.10')).toBe('≈ 10,000.10 TL');
    expect(formatApproxTry('0.30')).toBe('≈ 0.30 TL');
  });

  it('passes an unexpected shape through un-grouped rather than throwing', () => {
    expect(() => formatApproxTry('')).not.toThrow();
    expect(formatApproxTry('n/a')).toBe('≈ n/a TL');
  });
});
