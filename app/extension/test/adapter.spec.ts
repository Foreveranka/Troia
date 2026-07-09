import { beforeEach, describe, expect, it } from 'vitest';
import { evaluate, findSep7Uri } from '../src/lib/adapter';
import { toStroops } from '../src/lib/amount';

const MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
const ISSUER = 'GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W';
const OTHER_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OTHER_MERCHANT = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';

function sep7(
  opts: { dest?: string; amount?: string; memo?: string; issuer?: string } = {},
): string {
  const p = new URLSearchParams({
    destination: opts.dest ?? MERCHANT,
    amount: opts.amount ?? '62.00',
    memo: opts.memo ?? 'ST-AB12CD',
    memo_type: 'text',
  });
  p.set('asset_code', 'USDC');
  p.set('asset_issuer', opts.issuer ?? ISSUER);
  return `web+stellar:pay?${p.toString()}`;
}

describe('evaluate', () => {
  it('marks the real storefront request payable with full confidence', () => {
    const d = evaluate(sep7());
    expect(d).not.toBeNull();
    expect(d!.payable).toBe(true);
    expect(d!.confidence).toBe(1);
  });

  it('rejects a spoofed issuer (fail-closed) but still parses', () => {
    const d = evaluate(sep7({ issuer: OTHER_ISSUER }))!;
    expect(d.payable).toBe(false);
    expect(d.checks.find((c) => c.id === 'issuer')!.pass).toBe(false);
  });

  it('rejects a non-USDC (native) asset', () => {
    const d = evaluate(`web+stellar:pay?destination=${MERCHANT}&amount=100&memo=X&memo_type=text`)!;
    expect(d.payable).toBe(false);
    expect(d.checks.find((c) => c.id === 'asset')!.pass).toBe(false);
  });

  it('rejects a zero, negative, non-numeric, or over-precise amount', () => {
    // '1e3', '1.', and '62.123456789' used to pass the lenient Number() gate but fail toStroops on click.
    for (const bad of ['0', '-5', 'abc', '1e3', '1.', '62.123456789']) {
      expect(evaluate(sep7({ amount: bad }))!.payable).toBe(false);
    }
  });

  it('accepts a clean positive amount up to USDC 7-decimal precision', () => {
    for (const good of ['62.00', '62', '62.5', '62.1234567', '0.0000001']) {
      expect(evaluate(sep7({ amount: good }))!.payable).toBe(true);
    }
  });

  it('the amount gate agrees exactly with toStroops (no payable banner that dead-ends on click)', () => {
    for (const a of [
      '62.00',
      '62.1234567',
      '0.0000001',
      '0',
      '-5',
      'abc',
      '1e3',
      '1.',
      '62.123456789',
      '7',
    ]) {
      expect(evaluate(sep7({ amount: a }))!.payable).toBe(toStroops(a) !== null);
    }
  });

  it('rejects a missing memo', () => {
    const uri = `web+stellar:pay?destination=${MERCHANT}&amount=1&asset_code=USDC&asset_issuer=${ISSUER}`;
    expect(evaluate(uri)!.payable).toBe(false);
  });

  it('rejects an invalid destination address (corrupted checksum)', () => {
    const swapped = MERCHANT[10] === 'A' ? 'B' : 'A';
    const bad = MERCHANT.slice(0, 10) + swapped + MERCHANT.slice(11);
    const d = evaluate(sep7({ dest: bad }))!;
    expect(d.payable).toBe(false);
    expect(d.checks.find((c) => c.id === 'destination')!.pass).toBe(false);
  });

  it('is payable for a valid but unknown merchant (soft check), with confidence < 1', () => {
    const d = evaluate(sep7({ dest: OTHER_MERCHANT }))!;
    expect(d.payable).toBe(true);
    expect(d.confidence).toBeLessThan(1);
    expect(d.checks.find((c) => c.id === 'merchant')!.pass).toBe(false);
  });

  it('returns null for a non-SEP-7 string', () => {
    expect(evaluate('https://example.com')).toBeNull();
  });
});

describe('findSep7Uri', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reads the href of the wallet anchor', () => {
    const uri = sep7();
    document.body.innerHTML = `<a href="${uri}">Open in wallet</a>`;
    expect(findSep7Uri()).toBe(uri);
  });

  it('returns null when no SEP-7 anchor is present', () => {
    document.body.innerHTML = `<a href="https://example.com">x</a>`;
    expect(findSep7Uri()).toBeNull();
  });
});
