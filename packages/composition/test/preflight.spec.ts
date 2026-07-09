import { describe, expect, it } from 'vitest';
import { OracleError } from '@troia/oracle';
import type { OracleResult } from '@troia/oracle';
import { runPreflight } from '../src/preflight.js';
import type { PreflightProbes } from '../src/preflight.js';

// runPreflight is the offline-testable CORE of `just preflight`: given a set of injected probes (each smoking one
// live dependency the end-to-end run needs — operator fees, pool USDC, the CEX spot oracle, the Yahoo history, and
// iyzico reachability), it produces a green/red readiness report and NEVER throws (a probe that throws becomes a
// red check, not a crash). This is the gate a human runs BEFORE a real charge, so a missing/broken dependency is
// caught up front instead of mid-demo. The real probes (buildPreflightProbes) exercise the dirty adapters live;
// here we prove the report logic fail-closed with fakes.

const okRate: OracleResult = {
  ok: true,
  quote: { midTryPerUsdc: 405_000_000n, sources: ['binance', 'bybit', 'okx'], asOfMs: 0 },
};

function probes(over: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    operatorNativeXlm: () => Promise.resolve(9999),
    poolBalanceStroops: () => Promise.resolve(100_000n * 10_000_000n), // 100,000 USDC
    spotRate: () => Promise.resolve(okRate),
    historyCloseCount: () => Promise.resolve(126),
    iyzicoReachable: () =>
      Promise.resolve({ reached: true, detail: 'reached iyzico (status=failure)' }),
    ...over,
  };
}

describe('runPreflight — the live-smoke readiness gate (offline, injected probes)', () => {
  it('all green -> report.ok true with one check per dirty dependency', async () => {
    const r = await runPreflight(probes());
    expect(r.ok).toBe(true);
    expect(r.checks).toHaveLength(5);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('an RPC read that THROWS (pool balance) fails only that check + the whole report, and never throws', async () => {
    const r = await runPreflight(
      probes({ poolBalanceStroops: () => Promise.reject(new Error('RPC 503')) }),
    );
    expect(r.ok).toBe(false);
    const pool = r.checks.find((c) => c.name.includes('pool'));
    expect(pool?.ok).toBe(false);
    expect(pool?.detail).toContain('RPC 503');
    // the other checks are unaffected — one dead dependency doesn't mask the rest
    expect(r.checks.filter((c) => c.ok)).toHaveLength(4);
  });

  it('a pool BELOW the minimum fails closed (no USDC to settle a demo order)', async () => {
    const r = await runPreflight(probes({ poolBalanceStroops: () => Promise.resolve(1n) }), {
      minPoolStroops: 100_000_000n,
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.includes('pool'))?.ok).toBe(false);
  });

  it('a fail-closed oracle (no quorum) fails the spot check and surfaces the error code', async () => {
    const r = await runPreflight(
      probes({
        spotRate: () =>
          Promise.resolve({ ok: false, error: new OracleError('InsufficientSources', 'only 2') }),
      }),
    );
    expect(r.ok).toBe(false);
    const spot = r.checks.find((c) => c.name.includes('oracle'));
    expect(spot?.ok).toBe(false);
    expect(spot?.detail).toContain('InsufficientSources');
  });

  it('too few history closes fails the history check (commission stats need a sample)', async () => {
    const r = await runPreflight(probes({ historyCloseCount: () => Promise.resolve(2) }), {
      minCloses: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.includes('history'))?.ok).toBe(false);
  });

  it('an unreachable iyzico (network failure) fails the reachability check', async () => {
    const r = await runPreflight(
      probes({
        iyzicoReachable: () =>
          Promise.resolve({ reached: false, detail: 'network timeout/failure' }),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.includes('iyzico'))?.ok).toBe(false);
  });

  it('an operator with too little XLM for fees fails closed', async () => {
    const r = await runPreflight(probes({ operatorNativeXlm: () => Promise.resolve(0) }), {
      minNativeXlm: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.includes('XLM'))?.ok).toBe(false);
  });
});
