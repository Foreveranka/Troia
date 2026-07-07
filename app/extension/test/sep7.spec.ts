import { describe, expect, it } from 'vitest';
import { parseSep7 } from '../src/lib/sep7';

const MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
const ISSUER = 'GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W';
const USDC = `web+stellar:pay?destination=${MERCHANT}&amount=62.00&memo=ST-AB12CD&memo_type=text&asset_code=USDC&asset_issuer=${ISSUER}`;

describe('parseSep7', () => {
  it('parses a full USDC pay request (matching the storefront output)', () => {
    expect(parseSep7(USDC)).toMatchObject({
      operation: 'pay',
      destination: MERCHANT,
      amount: '62.00',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memo: 'ST-AB12CD',
      memoType: 'text',
    });
  });

  it('parses a native (XLM) request with no asset params', () => {
    const r = parseSep7(`web+stellar:pay?destination=${MERCHANT}&amount=100&memo=X&memo_type=text`);
    expect(r?.assetCode).toBeNull();
    expect(r?.assetIssuer).toBeNull();
  });

  it('returns null for a non-stellar scheme', () => {
    expect(parseSep7(`https://example.com/pay?destination=${MERCHANT}&amount=1`)).toBeNull();
  });

  it('returns null for a non-pay operation (tx)', () => {
    expect(parseSep7('web+stellar:tx?xdr=AAAA')).toBeNull();
  });

  it('returns null when destination is missing', () => {
    expect(parseSep7('web+stellar:pay?amount=10&memo=X')).toBeNull();
  });

  it('returns null when amount is missing', () => {
    expect(parseSep7(`web+stellar:pay?destination=${MERCHANT}&memo=X`)).toBeNull();
  });

  it('returns null when there is no query at all', () => {
    expect(parseSep7('web+stellar:pay')).toBeNull();
  });

  it('decodes URL-encoded parameter values', () => {
    const r = parseSep7(`web+stellar:pay?destination=${MERCHANT}&amount=1&memo=order%20123`);
    expect(r?.memo).toBe('order 123');
  });

  it('never throws on junk input', () => {
    expect(parseSep7('')).toBeNull();
    expect(parseSep7('web+stellar:')).toBeNull();
    expect(() => parseSep7('web+stellar:pay?%%%')).not.toThrow();
  });
});
