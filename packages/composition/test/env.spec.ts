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

// An unset var must not escape its own bound. Two call sites in main.ts derive `min` from ANOTHER settable var, so
// a perfectly valid setting there can lift `min` above a default that was written for the base cadence. Returning
// that default anyway degrades silently — exactly what this module's contract says it never does.
describe('intEnv — an unset var does not escape its minimum (the relational-min trap)', () => {
  it('THROWS when the default itself is below min', () => {
    expect(() => intEnv({}, 'P', 5000, 6000)).toThrow(/default/);
  });

  it('THROWS when the default itself is above max', () => {
    expect(() => intEnv({}, 'P', 70_000, 1, 65_535)).toThrow(/default/);
  });

  it('THROWS when a settable SETTLEMENT_TICK_MS lifts RECON_INTERVAL_MS min above its default', () => {
    // Composed exactly as main.ts does it. Silently returning 30_000 here would invert the documented cadence
    // (recon must be slower than settle) and make the solvency tripwire read inside the booking-lag window — a
    // false drift alarm, from one plausible ops action.
    const env = { SETTLEMENT_TICK_MS: '60000' };
    const settlementTickMs = intEnv(env, 'SETTLEMENT_TICK_MS', 5000, 1000);
    expect(settlementTickMs).toBe(60_000);
    expect(() => intEnv(env, 'RECON_INTERVAL_MS', 30_000, settlementTickMs + 1000)).toThrow(
      /RECON_INTERVAL_MS/,
    );
  });

  it('THROWS when a settable OUTFLOW_INTERVAL_MS lifts RECONCILE_INTERVAL_MS min above its default', () => {
    const env = { OUTFLOW_INTERVAL_MS: '40000' };
    const outflowTickMs = intEnv(env, 'OUTFLOW_INTERVAL_MS', 20_000, 5_000);
    expect(() => intEnv(env, 'RECONCILE_INTERVAL_MS', 30_000, outflowTickMs + 1000)).toThrow(
      /RECONCILE_INTERVAL_MS/,
    );
  });

  it('an all-default boot is untouched: every main.ts default still satisfies its own bound', () => {
    // The regression guard for this change. A default deployment sets none of these, so validating the default
    // must not turn a working boot into a throwing one.
    const env: Record<string, string | undefined> = {};
    const port = intEnv(env, 'PORT', 3000, 1, 65_535);
    const pollIntervalMs = intEnv(env, 'POLL_INTERVAL_MS', 5000, 1000);
    const settlementTickMs = intEnv(env, 'SETTLEMENT_TICK_MS', 5000, 1000);
    const reconTickMs = intEnv(env, 'RECON_INTERVAL_MS', 30_000, settlementTickMs + 1000);
    const outflowTickMs = intEnv(env, 'OUTFLOW_INTERVAL_MS', 20_000, 5_000);
    const reconcileTickMs = intEnv(env, 'RECONCILE_INTERVAL_MS', 30_000, outflowTickMs + 1000);
    const demoValorSecs = intEnv(env, 'DEMO_VALOR_SECS', 30, 1);

    expect([port, pollIntervalMs, settlementTickMs, demoValorSecs]).toEqual([3000, 5000, 5000, 30]);
    // and the cadences the defaults encode really do hold the documented ordering
    expect(reconTickMs).toBeGreaterThan(settlementTickMs);
    expect(reconcileTickMs).toBeGreaterThan(outflowTickMs);
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
