// env.ts fail-closed validation — the money-relevant part is that a malformed value THROWS at boot rather than
// silently degrading (a POLL_INTERVAL_MS typo must never become a ~1ms hot loop).

import { describe, expect, it } from 'vitest';
import { intEnv, parseDeployment, requireEnv } from '../src/env.js';

describe('requireEnv', () => {
  it('returns a non-empty value', () => {
    expect(requireEnv({ X: 'v' }, 'X')).toBe('v');
  });
  it('throws when absent', () => {
    expect(() => requireEnv({}, 'X')).toThrow(/X/);
  });
  it('throws on a blank / whitespace value', () => {
    expect(() => requireEnv({ X: '   ' }, 'X')).toThrow(/X/);
  });
});

describe('intEnv — bounded positive integer, fail-closed', () => {
  it('uses the default when absent or blank', () => {
    expect(intEnv({}, 'P', 5000, 1000)).toBe(5000);
    expect(intEnv({ P: '' }, 'P', 5000, 1000)).toBe(5000);
  });
  it('accepts a valid in-range integer', () => {
    expect(intEnv({ P: '8080' }, 'P', 3000, 1, 65535)).toBe(8080);
  });
  it('THROWS on a non-numeric typo (the "5s" case that would hot-loop under Number()+setInterval)', () => {
    expect(() => intEnv({ P: '5s' }, 'P', 5000, 1000)).toThrow(/invalid/);
  });
  it('THROWS on zero / negative / below-min', () => {
    expect(() => intEnv({ P: '0' }, 'P', 5000, 1000)).toThrow();
    expect(() => intEnv({ P: '-1' }, 'P', 5000, 1000)).toThrow();
    expect(() => intEnv({ P: '500' }, 'P', 5000, 1000)).toThrow(); // below the 1000 floor
  });
  it('THROWS above max or on a non-integer', () => {
    expect(() => intEnv({ P: '999999999999' }, 'P', 5000, 1000)).toThrow();
    expect(() => intEnv({ P: '5000.5' }, 'P', 5000, 1000)).toThrow();
  });
});

describe('parseDeployment', () => {
  const good = {
    usdcIssuer: 'G1',
    usdcSacContractId: 'C1',
    troyPool: 'C2',
    operatorPublic: 'G2',
    adminPublic: 'G3',
  };
  it('accepts a complete deployment', () => {
    expect(parseDeployment(good, 'd.json')).toEqual(good);
  });
  it('throws on a non-object', () => {
    expect(() => parseDeployment(null, 'd.json')).toThrow(/d\.json/);
  });
  it('throws (naming the key) when an address is missing', () => {
    const bad: Record<string, unknown> = { ...good };
    delete bad.troyPool;
    expect(() => parseDeployment(bad, 'd.json')).toThrow(/troyPool/);
  });
});
