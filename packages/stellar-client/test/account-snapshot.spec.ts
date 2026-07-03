import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-base';
import { toAccountSnapshot } from '../src/account-snapshot.js';
import { deriveMemo, PayoutIntent } from '../../core/src/index.js';
import type { AccountSnapshot } from '../../core/src/index.js';
import { bytes32, ISSUER } from './fixtures/vectors.js';

const DEST = Keypair.fromRawEd25519Seed(bytes32('dest-account')).publicKey();
const ORDER = 'order-acct-snap-1';

function raw() {
  return {
    orderId: ORDER,
    destination: DEST,
    amount: 10_000_000n,
    assetIssuer: ISSUER,
    memo: deriveMemo(ORDER),
  };
}

describe('toAccountSnapshot — Horizon balances -> core AccountSnapshot -> PayoutIntent.build (offline)', () => {
  it('maps a USDC trustline through and the destination preflight passes', () => {
    const json = {
      balances: [
        { asset_type: 'native' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER },
        { asset_type: 'credit_alphanum12', asset_code: 'OTHERCOIN', asset_issuer: 'GX' },
      ],
    };
    const snapshot: AccountSnapshot = toAccountSnapshot(json);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.trustlines).toContainEqual({ assetCode: 'USDC', assetIssuer: ISSUER });

    const res = PayoutIntent.build(raw(), { snapshot, allowedIssuers: [ISSUER] });
    expect(res.ok).toBe(true);
  });

  it('a missing account (null) yields a fail-closed snapshot -> TrustlineMissing', () => {
    const snapshot: AccountSnapshot = toAccountSnapshot(null);
    expect(snapshot).toEqual({ exists: false, trustlines: [] });

    const res = PayoutIntent.build(raw(), { snapshot, allowedIssuers: [ISSUER] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('TrustlineMissing');
  });
});
