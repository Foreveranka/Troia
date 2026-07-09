import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRIFT_ALARM_AFTER,
  INITIAL_DRIFT_STATE,
  checkDrift,
  observeDrift,
} from '../../src/settlement/drift-worker.js';
import type { DriftTickReport } from '../../src/settlement/drift-worker.js';

// The one detector that does not need to know what it is looking for. Two properties matter: it must never go
// quiet when it cannot see, and it must not cry wolf at the booking lag that follows every payout.

const EXPECTED = 1000n;

function report(observed: bigint): DriftTickReport {
  return {
    expectedPoolStroops: EXPECTED,
    observedPoolStroops: observed,
    driftStroops: observed - EXPECTED,
    inSync: observed === EXPECTED,
  };
}

describe('checkDrift', () => {
  it('weighs the live chain balance against the ledger expectation', async () => {
    const out = await checkDrift({
      stellar: {
        async readPoolBalanceStroops(): Promise<bigint> {
          return 990n;
        },
      },
      ledger: { detectDrift: (observed) => report(observed) },
    });
    expect(out).toEqual({
      expectedPoolStroops: 1000n,
      observedPoolStroops: 990n,
      driftStroops: -10n,
      inSync: false,
    });
  });

  it('throws when it cannot read the chain — it never reports "in sync" because it could not look', async () => {
    await expect(
      checkDrift({
        stellar: {
          async readPoolBalanceStroops(): Promise<bigint> {
            throw new Error('rpc down');
          },
        },
        ledger: { detectDrift: (observed) => report(observed) },
      }),
    ).rejects.toThrow('rpc down');
  });
});

describe('observeDrift — a booking lag is not a leak', () => {
  it('stays quiet while the drift is still inside the lag window, but says it is settling', () => {
    let s = INITIAL_DRIFT_STATE;
    for (let i = 1; i < DEFAULT_DRIFT_ALARM_AFTER; i += 1) {
      const o = observeDrift(s, report(990n));
      expect(o.alarm).toBe(false);
      expect(o.settling).toBe(true);
      expect(o.state.consecutiveOutOfSync).toBe(i);
      s = o.state;
    }
  });

  it('alarms once the drift outlives the lag window', () => {
    let s = INITIAL_DRIFT_STATE;
    let fired = 0;
    for (let i = 0; i < DEFAULT_DRIFT_ALARM_AFTER; i += 1) {
      const o = observeDrift(s, report(990n));
      if (o.alarm) fired += 1;
      s = o.state;
    }
    expect(fired).toBe(1);
    expect(s.alarmed).toBe(true);
  });

  it('alarms exactly once per episode — a page repeated every tick is a page ignored', () => {
    let s = INITIAL_DRIFT_STATE;
    let fired = 0;
    for (let i = 0; i < 20; i += 1) {
      const o = observeDrift(s, report(990n));
      if (o.alarm) fired += 1;
      s = o.state;
    }
    expect(fired).toBe(1);
    expect(s.consecutiveOutOfSync).toBe(20); // but it never stops counting
  });

  it('a drift that closes by itself WAS the booking lag: the episode resets and is reported as recovered', () => {
    let s = INITIAL_DRIFT_STATE;
    s = observeDrift(s, report(990n)).state;
    s = observeDrift(s, report(990n)).state;
    const back = observeDrift(s, report(1000n));
    expect(back.recovered).toBe(true);
    expect(back.state).toEqual(INITIAL_DRIFT_STATE);

    // and a fresh episode can alarm again
    let t = back.state;
    let fired = 0;
    for (let i = 0; i < DEFAULT_DRIFT_ALARM_AFTER; i += 1) {
      const o = observeDrift(t, report(990n));
      if (o.alarm) fired += 1;
      t = o.state;
    }
    expect(fired).toBe(1);
  });

  it('an in-sync reading with no prior drift is not a "recovery"', () => {
    const o = observeDrift(INITIAL_DRIFT_STATE, report(1000n));
    expect(o).toEqual({
      state: INITIAL_DRIFT_STATE,
      alarm: false,
      settling: false,
      recovered: false,
    });
  });

  it('a GROWING drift does not reset the episode — it is still the same leak', () => {
    let s = INITIAL_DRIFT_STATE;
    let fired = 0;
    for (const observed of [990n, 980n, 970n, 960n]) {
      const o = observeDrift(s, report(observed));
      if (o.alarm) fired += 1;
      s = o.state;
    }
    expect(fired).toBe(1);
    expect(s.consecutiveOutOfSync).toBe(4);
  });

  it('a positive drift alarms too — unrecorded USDC arriving is as suspicious as USDC leaving', () => {
    let s = INITIAL_DRIFT_STATE;
    let fired = 0;
    for (let i = 0; i < DEFAULT_DRIFT_ALARM_AFTER; i += 1) {
      const o = observeDrift(s, report(1010n));
      if (o.alarm) fired += 1;
      s = o.state;
    }
    expect(fired).toBe(1);
  });
});
