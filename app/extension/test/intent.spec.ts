// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { evaluate, type Detection } from '../src/lib/adapter';
import { buildIntentBody, intentUiAction, statusCopy } from '../src/lib/intent';
import type { IntentResponse, PublicStatus } from '../src/lib/intent';

const MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
const ISSUER = 'GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W';
const MEMO_STAB12CD = 'e01397d329505f05c70b253c3f2e925f488cd5b07a9d9336e36c463f96020db0';

function payableUri(memo = 'ST-AB12CD', amount = '62.00'): string {
  const p = new URLSearchParams({ destination: MERCHANT, amount, memo, memo_type: 'text' });
  p.set('asset_code', 'USDC');
  p.set('asset_issuer', ISSUER);
  return `web+stellar:pay?${p.toString()}`;
}

describe('buildIntentBody', () => {
  it('builds a well-formed /intent body from a payable detection', async () => {
    const detection = evaluate(payableUri())!;
    const r = await buildIntentBody(detection);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.body).toEqual({
      orderId: 'ST-AB12CD',
      destination: MERCHANT,
      amountStroops: '620000000',
      assetIssuer: ISSUER,
      memoHex: MEMO_STAB12CD, // == deriveMemo(orderId), so the backend's MemoMismatch guard passes
    });
  });

  it('refuses a non-payable detection (fail-closed)', async () => {
    // native XLM (no USDC) — evaluate marks it not payable
    const detection = evaluate(`web+stellar:pay?destination=${MERCHANT}&amount=1&memo=X&memo_type=text`)!;
    const r = await buildIntentBody(detection);
    expect(r).toEqual({ ok: false, reason: 'not-payable' });
  });

  it('fails closed on a malformed order_id (lone surrogate) instead of sending a doomed memo', async () => {
    const detection: Detection = {
      sep7: { operation: 'pay', destination: MERCHANT, amount: '62.00', assetCode: 'USDC', assetIssuer: ISSUER, memo: 'ab\uD83D', memoType: 'text' },
      checks: [],
      confidence: 1,
      payable: true,
    };
    const r = await buildIntentBody(detection);
    expect(r).toEqual({ ok: false, reason: 'bad-order-ref' });
  });
});

describe('statusCopy', () => {
  it('maps each public status to copy + kind + terminality', () => {
    expect(statusCopy('pending')).toMatchObject({ kind: 'info', terminal: false });
    expect(statusCopy('processing')).toMatchObject({ kind: 'info', terminal: false });
    expect(statusCopy('completed')).toMatchObject({ kind: 'info', terminal: true });
    expect(statusCopy('failed')).toMatchObject({ kind: 'error', terminal: true });
    expect(statusCopy('review')).toMatchObject({ kind: 'info', terminal: true });
  });

  it('every status yields non-empty text', () => {
    const all: PublicStatus[] = ['pending', 'processing', 'completed', 'failed', 'review'];
    for (const s of all) expect(statusCopy(s).text.length).toBeGreaterThan(0);
  });
});

describe('intentUiAction', () => {
  const base: IntentResponse = { orderId: 'o', token: 't', paidPriceTry: '1.00' };

  it('opens + polls when a hosted page URL is present', () => {
    const a = intentUiAction({ ...base, paymentPageUrl: 'https://sandbox-cpp.iyzipay.com/?token=t' });
    expect(a).toMatchObject({ kind: 'open', poll: true });
  });

  it('reports already-in-progress (never a false "opening") on a duplicate with no URL', () => {
    const a = intentUiAction({ ...base, alreadyStarted: true });
    expect(a.kind).toBe('already');
    expect(a.poll).toBe(true);
    expect(a.text.toLowerCase()).not.toContain('opening');
  });

  it('errors (no poll, no false "opening") on a success that opened no form', () => {
    const a = intentUiAction(base);
    expect(a).toMatchObject({ kind: 'error', poll: false });
    expect(a.text.toLowerCase()).not.toContain('opening');
  });
});
