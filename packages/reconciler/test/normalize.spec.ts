import { describe, expect, it } from 'vitest';
import { amountEqual, hexEqual } from '../src/normalize.js';

describe('normalize — amountEqual canonical-decimal guard (adversarial regression)', () => {
  it('equal for the same numeric value, including benign leading zeros', () => {
    expect(amountEqual('10', '10')).toBe(true);
    expect(amountEqual('010', '10')).toBe(true);
    expect(amountEqual('0', '0')).toBe(true);
  });

  it('blank / whitespace / hex / fractional / signed fail SAFE to not-equal (no BigInt conflation)', () => {
    expect(amountEqual('', '0')).toBe(false); // the confirmed defect: BigInt('') === 0n
    expect(amountEqual(' 10 ', '10')).toBe(false);
    expect(amountEqual('0x0a', '10')).toBe(false);
    expect(amountEqual('5.0', '5')).toBe(false);
    expect(amountEqual('-5', '5')).toBe(false);
  });

  it('genuinely different amounts are never equal', () => {
    expect(amountEqual('6000000', '5000000')).toBe(false);
  });
});

describe('normalize — hexEqual is a lowercase string compare (case-insensitive, no conflation)', () => {
  it('same bytes in different case are equal; different values are not', () => {
    expect(hexEqual('ABCD', 'abcd')).toBe(true);
    expect(hexEqual('', 'abcd')).toBe(false);
    expect(hexEqual('abce', 'abcd')).toBe(false);
  });
});
