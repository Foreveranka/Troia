// @vitest-environment node
// B-11: the manual wizard's decision surface. Everything the wizard can refuse or assemble is here — the page
// itself only renders these outcomes, so this spec IS the wizard's behavioral contract.

import { describe, expect, it } from 'vitest';
import {
  buildManualIntentBody,
  MANUAL_MAX_STROOPS,
  MANUAL_MAX_USDC,
  newManualOrderId,
  validateWizardInput,
  wizardErrorCopy,
} from '../src/lib/wizard-core';
import { deriveMemoHex } from '../src/lib/derive-memo';
import { USDC_ISSUER_ALLOWLIST } from '../src/lib/config';

// a checksum-valid ed25519 public key (same fixture family the strkey spec uses)
const DEST = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';

describe('validateWizardInput', () => {
  it('accepts a valid address + amount, forgiving pasted whitespace', () => {
    const r = validateWizardInput(`  ${DEST}  `, ' 25.50 ');
    expect(r).toEqual({ ok: true, destination: DEST, amountStroops: 255_000_000n });
  });

  it('rejects a bad address (checksum, C-address, garbage) fail-closed', () => {
    expect(validateWizardInput(DEST.slice(0, -1) + 'A', '1')).toEqual({
      ok: false,
      reason: 'bad-address',
    });
    // contract (C...) destinations are deliberately outside the manual flow
    expect(
      validateWizardInput('CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ', '1'),
    ).toEqual({ ok: false, reason: 'bad-address' });
    expect(validateWizardInput('not-an-address', '1')).toEqual({
      ok: false,
      reason: 'bad-address',
    });
  });

  it('rejects unparseable / non-positive amounts', () => {
    for (const bad of ['', 'abc', '0', '-5', '1.23456789', '1,50']) {
      expect(validateWizardInput(DEST, bad)).toEqual({ ok: false, reason: 'bad-amount' });
    }
  });

  it(`enforces the per-transaction cap (${MANUAL_MAX_USDC} USDC): at the cap passes, above fails`, () => {
    const atCap = validateWizardInput(DEST, MANUAL_MAX_USDC);
    expect(atCap.ok).toBe(true);
    if (atCap.ok) expect(atCap.amountStroops).toBe(MANUAL_MAX_STROOPS);
    expect(validateWizardInput(DEST, '500.0000001')).toEqual({ ok: false, reason: 'over-cap' });
  });
});

describe('newManualOrderId', () => {
  it('is recognizably manual, unique per call, and stable in shape', () => {
    let n = 0;
    const id1 = newManualOrderId(1_700_000_000_000, () => n++);
    const id2 = newManualOrderId(1_700_000_000_000, () => n++);
    expect(id1).toMatch(/^manual-[0-9a-z]+-[0-9a-z]{8}$/);
    expect(id1).not.toBe(id2); // different randomness -> different order (a retry is a NEW order)
  });
});

describe('buildManualIntentBody', () => {
  it('assembles the same body shape the SEP-7 path sends, with the derived memo and our issuer', async () => {
    const body = await buildManualIntentBody('manual-x-abc', DEST, 255_000_000n);
    expect(body).toEqual({
      orderId: 'manual-x-abc',
      destination: DEST,
      amountStroops: '255000000',
      assetIssuer: USDC_ISSUER_ALLOWLIST[0],
      memoHex: await deriveMemoHex('manual-x-abc'), // backend's memoHex == deriveMemo(orderId) check passes
    });
  });
});

describe('wizardErrorCopy', () => {
  it('speaks to every refusal the flow can produce, never leaking a raw code', () => {
    // the SEP-29 message must say WHY exchange addresses cannot work, not just "error"
    expect(wizardErrorCopy('DestinationMemoRequired')).toMatch(/memo/i);
    expect(wizardErrorCopy('DestinationMemoRequired')).toMatch(/exchange/i);
    expect(wizardErrorCopy('TrustlineMissing')).toMatch(/trustline/i);
    expect(wizardErrorCopy('over-cap')).toContain(MANUAL_MAX_USDC);
    for (const code of [
      'bad-address',
      'bad-amount',
      'PoolInsufficient',
      'SessionBudgetExceeded',
      'PriceUnavailable',
      'session_unavailable',
      'network',
      'timeout',
      'SomethingNeverSeen',
    ]) {
      const copy = wizardErrorCopy(code);
      expect(copy.length).toBeGreaterThan(10);
      expect(copy).not.toContain(code); // raw codes never reach the screen
    }
  });
});
