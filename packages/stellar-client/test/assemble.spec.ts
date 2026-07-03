import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-base';
import { assembleFromSimulation, hashOf } from '../src/assemble.js';
import { buildPayTransaction } from '../src/build.js';
import { SimulationError } from '../src/errors.js';
import { decodeSignedPay } from '../../reconciler/src/decode.js';
import {
  addressAuthXdr,
  DEFAULT_RESOURCE_FEE,
  fakeSimResult,
} from './fixtures/fake-sim-result.js';
import { bytes32, buildParams, MERCHANT, PASSPHRASE, TROY_POOL } from './fixtures/vectors.js';

const unprepared = (): ReturnType<typeof buildPayTransaction> => buildPayTransaction(buildParams);
const sim = (fee?: string): ReturnType<typeof fakeSimResult> => fakeSimResult(TROY_POOL, MERCHANT, fee);

// helper to read the invokeHostFunction op's auth entries off an assembled tx
function opAuth(tx: ReturnType<typeof buildPayTransaction>): readonly { credentials(): { switch(): { name: string } } }[] {
  const op = tx.operations[0] as { auth?: readonly { credentials(): { switch(): { name: string } } }[] };
  return op.auth ?? [];
}

describe('assembleFromSimulation — deterministic footprint + source-account auth folding', () => {
  it('is deterministic: same (unprepared, sim) -> byte-identical submittable XDR and identical hash', () => {
    const a = assembleFromSimulation(unprepared(), sim());
    const b = assembleFromSimulation(unprepared(), sim());
    expect(a.toEnvelope().toXDR('base64')).toBe(b.toEnvelope().toXDR('base64'));
    expect(hashOf(a)).toBe(hashOf(b));
  });

  it('the hash is footprint-sensitive: a different sim -> a different hash (so it must be persisted once)', () => {
    const a = assembleFromSimulation(unprepared(), sim(DEFAULT_RESOURCE_FEE));
    const b = assembleFromSimulation(unprepared(), sim('7654321'));
    expect(hashOf(a)).not.toBe(hashOf(b));
  });

  it('final fee = inclusion fee + resource fee', () => {
    const assembled = assembleFromSimulation(unprepared(), sim());
    const expected = (BigInt(buildParams.fee) + BigInt(DEFAULT_RESOURCE_FEE)).toString();
    expect(assembled.fee).toBe(expected);
  });

  it('INJECTS the simulated source-account auth entry into the op (so the live tx is submittable)', () => {
    const assembled = assembleFromSimulation(unprepared(), sim());
    const auth = opAuth(assembled);
    expect(auth).toHaveLength(1);
    expect(auth[0]!.credentials().switch().name).toBe('sorobanCredentialsSourceAccount');
  });

  it('an empty-auth simulation assembles an op with no auth entries', () => {
    const assembled = assembleFromSimulation(unprepared(), { ...sim(), authXdr: [] });
    expect(opAuth(assembled)).toHaveLength(0);
  });

  it('the assembled (submittable-shaped) tx still decodes to the exact pay() projection', () => {
    const assembled = assembleFromSimulation(unprepared(), sim());
    const dec = decodeSignedPay(assembled.toEnvelope().toXDR('base64'), PASSPHRASE);
    expect(dec.projection.function).toBe('pay');
    expect(dec.projection.contract_id).toBe(TROY_POOL);
  });

  it('fails closed on a nonce-bearing ADDRESS authorization entry (non-source authorizer)', () => {
    const authorizer = Keypair.fromRawEd25519Seed(bytes32('rogue-authorizer')).publicKey();
    const bad = { ...sim(), authXdr: [addressAuthXdr(TROY_POOL, authorizer)] };
    expect(() => assembleFromSimulation(unprepared(), bad)).toThrow(SimulationError);
  });

  it('fails closed when the footprint resource fee disagrees with minResourceFee', () => {
    const inconsistent = { ...sim(), minResourceFee: '999' };
    expect(() => assembleFromSimulation(unprepared(), inconsistent)).toThrow(SimulationError);
  });
});
