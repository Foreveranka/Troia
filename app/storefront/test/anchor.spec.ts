import { describe, expect, it } from 'vitest';
import {
  checkedAmount,
  quoteIsLive,
  statusLabel,
  trustedLink,
  units,
  type Quote,
} from '../../extension/src/anchor/client';

describe('anchor money and recovery guards', () => {
  it('keeps seven-decimal USDC precision beyond Number safe integers', () => {
    expect(units('9007199254740993.1234567', 7)).toBe(90071992547409931234567n);
    expect(checkedAmount('1,25', 2)).toBe('1.25');
    for (const amount of ['1e3', '-1', 'NaN', '1.001', '0', '1,2,3'])
      expect(() => checkedAmount(amount, 2)).toThrow();
  });
  it('rejects expired and malformed quote expiry', () => {
    expect(quoteIsLive({ expires_at: 'bad' } as Quote)).toBe(false);
    expect(quoteIsLive({ expires_at: new Date(10000).toISOString() } as Quote, 6000)).toBe(false);
    expect(quoteIsLive({ expires_at: new Date(20000).toISOString() } as Quote, 6000)).toBe(true);
  });
  it('never follows an anchor-supplied link to another origin', () => {
    expect(trustedLink('javascript:alert(1)')).toBeUndefined();
    expect(trustedLink('https://tr-mock-anchor.fly.dev.evil.test/')).toBeUndefined();
    expect(trustedLink('http://tr-mock-anchor.fly.dev/')).toBeUndefined();
  });
  it('surfaces unknown and pending states without calling them successful', () => {
    expect(statusLabel('pending_trust')).toContain('trustline');
    expect(statusLabel('new_anchor_status')).toContain('Awaiting');
    expect(statusLabel('completed')).toBe('Completed');
  });
});
