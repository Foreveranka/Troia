import { describe, expect, it } from 'vitest';
import { advance, start } from '../../src/engine/driver.js';
import { makeCtx, makeHarness } from '../fakes/harness.js';

// Regression guard for the live-smoke fix: the pay() tx LOWER timebound MUST be 0, NOT clock.now(). A validated
// ledger's closeTime LAGS real-now by up to an inter-ledger interval (~5s), so a tx built with minTime=now() is
// rejected `txTooEarly` at submission and NEVER lands — this silently blocked EVERY on-chain settlement in the
// first live run. maxTime (the deadness expiry) stays clock-derived; only the lower bound is 0, which is
// skew-proof and carries no money-safety role (replay/liveness are the order-pinned seq + Processed(tx_id) guard).
describe('pay() timebounds — minTime is 0 (skew-proof), never clock.now()', () => {
  it('submitPay receives minTime=0 and maxTime=now+timeboundsSecs', async () => {
    const h = makeHarness();
    h.clock.now = 1_700_000_000; // a known, NON-zero clock — a regression to minTime=now() would surface here
    const ctx = makeCtx(h.store);
    await start(ctx, h.deps);
    await advance(ctx, 'SolvencyReserved', { type: 'chargeOk' }, h.deps);

    expect(h.stellar.submitReqs).toHaveLength(1);
    const req = h.stellar.submitReqs[0]!;
    expect(req.minTime).toBe(0); // NOT the clock's now — a now()-derived lower bound is txTooEarly under ledger lag
    expect(req.maxTime).toBe(1_700_000_000 + h.config.stellar.timeboundsSecs); // the expiry IS clock-derived
    expect(req.minTime).toBeLessThan(req.maxTime); // build.ts requires 0 <= minTime < maxTime
  });
});
