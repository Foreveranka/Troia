import { describe, expect, it } from 'vitest';
import { Transaction } from '@stellar/stellar-base';
import { buildPayTransaction } from '../src/build.js';
import { BuildError } from '../src/errors.js';
import { decodeSignedPay } from '../../reconciler/src/decode.js';
import {
  AMOUNT,
  APPLIED_RATE,
  buildParams,
  MAX_TIME,
  MEMO,
  MERCHANT,
  OPERATOR_PUBLIC,
  PASSPHRASE,
  TROY_POOL,
  TX_ID,
} from './fixtures/vectors.js';

const xdrOf = (p = buildParams): string => buildPayTransaction(p).toEnvelope().toXDR('base64');

describe('buildPayTransaction — deterministic, correctly-shaped pay() builder', () => {
  it('is deterministic: identical params -> byte-identical XDR (no clock/RNG)', () => {
    expect(xdrOf()).toBe(xdrOf());
  });

  it('produces a plain v1 Transaction with exactly one op and the operator as source', () => {
    const tx = buildPayTransaction(buildParams);
    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]!.type).toBe('invokeHostFunction');
    expect(tx.source).toBe(OPERATOR_PUBLIC);
  });

  it('sets a finite injected upper timebound (never TimeoutInfinite)', () => {
    const tx = buildPayTransaction(buildParams);
    expect(tx.timeBounds).toBeDefined();
    expect(tx.timeBounds!.maxTime).toBe(String(MAX_TIME));
    expect(tx.timeBounds!.maxTime).not.toBe('0');
  });

  it('decodes back through the reconciler to the exact projection (arg encoding matches generate.ts)', () => {
    const dec = decodeSignedPay(xdrOf(), PASSPHRASE);
    expect(dec.projection).toEqual({
      function: 'pay',
      contract_id: TROY_POOL,
      source_account: OPERATOR_PUBLIC,
      tx_id_hex: TX_ID.toString('hex'),
      amount_stroops: AMOUNT.toString(),
      applied_rate_stroops: APPLIED_RATE.toString(),
      merchant: MERCHANT,
      memo_hex: MEMO.toString('hex'),
    });
  });

  it('a different amount changes the XDR (args are load-bearing, not ignored)', () => {
    expect(xdrOf({ ...buildParams, amount: AMOUNT + 1n })).not.toBe(xdrOf());
  });

  it('fails closed on a non-finite / TimeoutInfinite upper bound (an un-expirable order)', () => {
    expect(() => buildPayTransaction({ ...buildParams, maxTime: 0 })).toThrow(BuildError);
    expect(() => buildPayTransaction({ ...buildParams, maxTime: -1 })).toThrow(BuildError);
    expect(() => buildPayTransaction({ ...buildParams, minTime: 2000, maxTime: 1000 })).toThrow(
      BuildError,
    );
    expect(() => buildPayTransaction({ ...buildParams, maxTime: Number.POSITIVE_INFINITY })).toThrow(
      BuildError,
    );
  });
});
