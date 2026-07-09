import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { buildErrorRank, deriveMemo, PayoutIntent } from '../src/index.js';
import type { AccountSnapshot, BuildContext, BuildError, RawPayout } from '../src/index.js';

// Fixed, real StrKey addresses (deterministic seeds via @stellar/stellar-base).
const DEST_G = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const DEST_C = 'CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L';
const ISSUER = 'GAJZR5RMNUNEK7CRXJVEWXZ5XUXWT7FJGILCDDOITF7EC26RPWJ4UVOE';
const OTHER_ISSUER = 'GBXHUHG5FGYLPD6RHL2MKWMP572O6KUXCZXDZJXS4T57ZTMAKBN7DWXN';
const ORDER = 'ord-001';

function memoHex(orderId: string): string {
  return Buffer.from(deriveMemo(orderId)).toString('hex');
}

function makeRaw(overrides: Partial<RawPayout> = {}): RawPayout {
  return {
    orderId: ORDER,
    destination: DEST_G,
    amount: 15_000_000n,
    assetIssuer: ISSUER,
    memo: memoHex(ORDER),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<BuildContext> = {}): BuildContext {
  const snapshot: AccountSnapshot = {
    exists: true,
    trustlines: [{ assetCode: 'USDC', assetIssuer: ISSUER }],
  };
  return { snapshot, allowedIssuers: [ISSUER], ...overrides };
}

function expectError(raw: RawPayout, ctx: BuildContext, code: BuildError) {
  const r = PayoutIntent.build(raw, ctx);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe(code);
}

describe('PayoutIntent.build — happy paths', () => {
  it('builds for a classic (G) destination with a matching trustline', () => {
    const r = PayoutIntent.build(makeRaw(), makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fields.destinationType).toBe('ed25519');
      expect(r.value.fields.orderId).toBe(ORDER);
      expect(r.value.fields.ids.memoHex).toBe(memoHex(ORDER));
      expect(Buffer.from(r.value.fields.memo).toString('hex')).toBe(memoHex(ORDER));
    }
  });

  it('builds for a contract (C) destination without any trustline', () => {
    const r = PayoutIntent.build(
      makeRaw({ destination: DEST_C }),
      makeCtx({ snapshot: { exists: false, trustlines: [] } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fields.destinationType).toBe('contract');
  });

  it('accepts a 32-byte Uint8Array memo', () => {
    const r = PayoutIntent.build(makeRaw({ memo: deriveMemo(ORDER) }), makeCtx());
    expect(r.ok).toBe(true);
  });

  it('accepts the i128 max amount', () => {
    const r = PayoutIntent.build(makeRaw({ amount: 2n ** 127n - 1n }), makeCtx());
    expect(r.ok).toBe(true);
  });

  it('canonicalizes order_id: an NFD input builds and stores the NFC form', () => {
    const nfd = 'cafe\u0301'; // decomposed: 'cafe' + U+0301 combining acute accent
    const nfc = 'caf\u00e9'; // precomposed: 'caf' + U+00E9 e-acute (NFC)
    expect(nfd).not.toBe(nfc);
    const r = PayoutIntent.build(makeRaw({ orderId: nfd, memo: memoHex(nfd) }), makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fields.orderId).toBe(nfc);
  });
});

describe('PayoutIntent.build — one leaf per BuildError', () => {
  it('OrderIdMalformed', () =>
    expectError(makeRaw({ orderId: 'ab\uD83D' }), makeCtx(), 'OrderIdMalformed'));
  it('OrderIdEmpty', () => expectError(makeRaw({ orderId: '' }), makeCtx(), 'OrderIdEmpty'));
  it('AddressInvalidChecksum', () =>
    expectError(
      makeRaw({ destination: DEST_G.toLowerCase() }),
      makeCtx(),
      'AddressInvalidChecksum',
    ));
  it('MemoMissing', () => expectError(makeRaw({ memo: null }), makeCtx(), 'MemoMissing'));
  it('MemoWrongLength', () => expectError(makeRaw({ memo: 'dead' }), makeCtx(), 'MemoWrongLength'));
  it('MemoZero', () => expectError(makeRaw({ memo: '0'.repeat(64) }), makeCtx(), 'MemoZero'));
  it('MemoMismatch', () =>
    expectError(makeRaw({ memo: memoHex('a-different-order') }), makeCtx(), 'MemoMismatch'));
  it('AmountNonPositive (zero)', () =>
    expectError(makeRaw({ amount: 0n }), makeCtx(), 'AmountNonPositive'));
  it('AmountNonPositive (negative)', () =>
    expectError(makeRaw({ amount: -1n }), makeCtx(), 'AmountNonPositive'));
  it('AmountNonPositive (above i128 max — build stays total, no throw)', () =>
    expectError(makeRaw({ amount: 2n ** 127n }), makeCtx(), 'AmountNonPositive'));
  it('IssuerNotAllowlisted', () =>
    expectError(
      makeRaw({ assetIssuer: OTHER_ISSUER }),
      makeCtx({ allowedIssuers: [ISSUER] }),
      'IssuerNotAllowlisted',
    ));
  it('TrustlineMissing (no matching trustline)', () =>
    expectError(
      makeRaw(),
      makeCtx({ snapshot: { exists: true, trustlines: [] } }),
      'TrustlineMissing',
    ));
  it('TrustlineMissing (account does not exist)', () =>
    expectError(
      makeRaw(),
      makeCtx({ snapshot: { exists: false, trustlines: [] } }),
      'TrustlineMissing',
    ));
});

describe('PayoutIntent.build — deterministic control order (multi-violation input)', () => {
  const brokenCtx = makeCtx({ allowedIssuers: [], snapshot: { exists: false, trustlines: [] } });

  it('OrderIdMalformed wins over everything', () => {
    expectError(
      makeRaw({
        orderId: '\uD83D',
        destination: 'bad',
        memo: null,
        amount: 0n,
        assetIssuer: OTHER_ISSUER,
      }),
      brokenCtx,
      'OrderIdMalformed',
    );
  });
  it('AddressInvalidChecksum wins over memo/amount/issuer/trustline', () => {
    expectError(
      makeRaw({ destination: 'bad', memo: null, amount: 0n, assetIssuer: OTHER_ISSUER }),
      brokenCtx,
      'AddressInvalidChecksum',
    );
  });
  it('MemoMissing wins over amount/issuer/trustline', () => {
    expectError(
      makeRaw({ memo: null, amount: 0n, assetIssuer: OTHER_ISSUER }),
      brokenCtx,
      'MemoMissing',
    );
  });
  it('AmountNonPositive wins over issuer/trustline', () => {
    expectError(makeRaw({ amount: 0n, assetIssuer: OTHER_ISSUER }), brokenCtx, 'AmountNonPositive');
  });
  it('IssuerNotAllowlisted wins over trustline', () => {
    expectError(
      makeRaw({ assetIssuer: OTHER_ISSUER }),
      makeCtx({ allowedIssuers: [ISSUER], snapshot: { exists: false, trustlines: [] } }),
      'IssuerNotAllowlisted',
    );
  });

  it('buildErrorRank reflects the documented control order', () => {
    expect(buildErrorRank('OrderIdMalformed')).toBeLessThan(
      buildErrorRank('AddressInvalidChecksum'),
    );
    expect(buildErrorRank('MemoMismatch')).toBeLessThan(buildErrorRank('AmountNonPositive'));
    expect(buildErrorRank('IssuerNotAllowlisted')).toBeLessThan(buildErrorRank('TrustlineMissing'));
  });
});

describe('PayoutIntent.build — trust boundary (runtime type violations must fail closed, never throw)', () => {
  // RawPayout field types are compile-time only. Inputs arriving from JSON / queues / DB rows are
  // NOT type-checked (JSON.parse never yields bigint; order_id can be null/number). build() is the
  // money-safety gate and must return a BuildError for any such input, never throw.
  const anyVal = (v: unknown) => v as never;

  it('non-string orderId -> OrderIdMalformed', () => {
    for (const bad of [null, undefined, 123, {}, [], 5n]) {
      const r = PayoutIntent.build(makeRaw({ orderId: anyVal(bad) }), makeCtx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('OrderIdMalformed');
    }
  });

  it('non-bigint amount -> AmountNonPositive', () => {
    for (const bad of [1000, 5.5, NaN, Infinity, '1000', null, undefined]) {
      const r = PayoutIntent.build(makeRaw({ amount: anyVal(bad) }), makeCtx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('AmountNonPositive');
    }
  });

  it('non-string destination -> AddressInvalidChecksum', () => {
    for (const bad of [123, null, undefined, {}]) {
      const r = PayoutIntent.build(makeRaw({ destination: anyVal(bad) }), makeCtx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('AddressInvalidChecksum');
    }
  });

  it('non-string / non-bytes memo -> MemoWrongLength', () => {
    for (const bad of [123, true, {}, new Array(32).fill(0)]) {
      const r = PayoutIntent.build(makeRaw({ memo: anyVal(bad) }), makeCtx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('MemoWrongLength');
    }
  });

  it('never throws across a matrix of fully-malformed raw inputs', () => {
    const bads: unknown[] = [null, undefined, 123, 5.5, NaN, Infinity, '1000', {}, [], 5n, true];
    for (const b of bads) {
      expect(() =>
        PayoutIntent.build(
          anyVal({ orderId: b, destination: b, amount: b, assetIssuer: b, memo: b }),
          makeCtx(),
        ),
      ).not.toThrow();
    }
  });
});
