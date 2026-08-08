// CHANNEL MODE (A-5): the submit path with a channel tx source. What must hold: the operator's authorization
// rides as SIGNED address-credential entries (never source-account), the CHANNEL key signs the envelope, the
// write-ahead persist still precedes the send with the final bytes, and every mis-configuration fails closed
// BEFORE anything is journaled or broadcast. Deadness reads must target the channel, not the operator.

import { describe, expect, it } from 'vitest';
import { Keypair, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-base';
import { createStellarClient } from '../src/client.js';
import { assembleWithSignedAuth } from '../src/assemble.js';
import { buildPayTransaction } from '../src/build.js';
import { LocalKeySigner } from '../src/signer.js';
import { SubmitError } from '../src/errors.js';
import type { HorizonPort, RpcPort, Signer, WriteAheadJournal } from '../src/ports.js';
import type { GetTxOutcome, SendOutcome } from '../src/outcomes.js';
import { addressAuthXdr, fakeSimResult } from './fixtures/fake-sim-result.js';
import {
  buildParams,
  bytes32,
  MERCHANT,
  OPERATOR_PUBLIC,
  OPERATOR_SECRET,
  TROY_POOL,
} from './fixtures/vectors.js';

const channelKp = Keypair.fromRawEd25519Seed(bytes32('troia|channel-1'));
const CHANNEL_PUBLIC = channelKp.publicKey();
const HEAD_LEDGER = 1_000;

/** SimResult as a live prepare would return it in channel mode: the operator comes back as an ADDRESS
 *  credential (nonce, void signature) because it is no longer the tx source. */
function channelSim() {
  return {
    ...fakeSimResult(TROY_POOL, MERCHANT),
    authXdr: [addressAuthXdr(TROY_POOL, OPERATOR_PUBLIC)],
  };
}

interface Rig {
  journal: WriteAheadJournal;
  rpc: RpcPort;
  log: string[];
  seqReads: string[];
  persisted: Set<string>;
}

function rig(): Rig {
  const persisted = new Set<string>();
  const log: string[] = [];
  const seqReads: string[] = [];
  const journal: WriteAheadJournal = {
    async persistPreSubmit(_orderId, _seq, _hashHex, signedXdr) {
      persisted.add(signedXdr);
      log.push('persist');
    },
    async loadPersisted() {
      return null;
    },
  };
  const rpc = {
    async simulate() {
      return channelSim();
    },
    async latestLedger() {
      return { sequence: HEAD_LEDGER, closeTimeUnix: 0 };
    },
    async send(signedXdr: string): Promise<SendOutcome> {
      if (!persisted.has(signedXdr)) throw new Error('SEND BEFORE PERSIST — write-ahead violated');
      log.push('send');
      return { kind: 'PENDING', hashHex: 'ab' };
    },
    async getTransaction(): Promise<GetTxOutcome> {
      // past maxTime, so the reducer routes to resolveDeadness — the read whose target we assert on
      return { kind: 'NOT_FOUND', latestLedgerCloseTimeUnix: 999 };
    },
    async readAccountSeq(publicKey: string) {
      seqReads.push(publicKey);
      return { exists: true, seq: '1' };
    },
  } as unknown as RpcPort;
  return { journal, rpc, log, seqReads, persisted };
}

function makeClient(
  r: Rig,
  opts: { channelSigners?: ReadonlyMap<string, Signer>; signer?: Signer },
) {
  return createStellarClient({
    rpc: r.rpc,
    horizon: {} as HorizonPort,
    signer: opts.signer ?? new LocalKeySigner(OPERATOR_SECRET),
    journal: r.journal,
    clock: { nowUnix: () => 0 },
    ...(opts.channelSigners === undefined ? {} : { channelSigners: opts.channelSigners }),
  });
}

const channelReq = {
  ...buildParams,
  orderId: 'ord-ch-1',
  sourcePublic: CHANNEL_PUBLIC,
  seq: '200',
};

describe('channel-mode submitPay', () => {
  it('channel signs the envelope, the operator signs the auth entry, persist still precedes send', async () => {
    const r = rig();
    const client = makeClient(r, {
      channelSigners: new Map([[CHANNEL_PUBLIC, new LocalKeySigner(channelKp.secret())]]),
    });

    const res = await client.submitPay(channelReq);
    expect(r.log).toEqual(['persist', 'send']);

    const tx = TransactionBuilder.fromXDR(res.signedXdr, buildParams.passphrase) as Transaction;
    expect(tx.source).toBe(CHANNEL_PUBLIC); // the channel provides seq + fee...
    expect(tx.sequence).toBe('201');
    const sigs = tx.signatures;
    expect(sigs).toHaveLength(1); // ...and the ONE envelope signature is the channel's, not the operator's
    expect(sigs[0]?.hint().equals(channelKp.signatureHint())).toBe(true);

    // the operator's authorization is INSIDE the op: an address credential, actually signed, expiring
    // AUTH_VALIDITY_LEDGERS past the head — comfortably beyond the tx timebounds
    const op = tx.operations[0] as { auth?: xdr.SorobanAuthorizationEntry[] };
    const entry = op.auth?.[0];
    expect(entry).toBeDefined();
    const creds = (entry as xdr.SorobanAuthorizationEntry).credentials();
    expect(creds.switch().name).toBe('sorobanCredentialsAddress');
    expect(creds.address().signature().switch().name).not.toBe('scvVoid');
    expect(creds.address().signatureExpirationLedger()).toBe(HEAD_LEDGER + 120);
  });

  it('fails closed BEFORE journal/send when the channel has no signer', async () => {
    const r = rig();
    const client = makeClient(r, { channelSigners: new Map() });
    await expect(client.submitPay(channelReq)).rejects.toThrow(SubmitError);
    expect(r.log).toEqual([]); // nothing persisted, nothing sent
  });

  it('fails closed when the operator signer cannot sign auth entries', async () => {
    const r = rig();
    const bareSigner: Signer = {
      publicKey: () => OPERATOR_PUBLIC,
      sign: (tx) => tx.toEnvelope().toXDR('base64'),
      // no signAuthEntry
    };
    const client = makeClient(r, {
      signer: bareSigner,
      channelSigners: new Map([[CHANNEL_PUBLIC, new LocalKeySigner(channelKp.secret())]]),
    });
    await expect(client.submitPay(channelReq)).rejects.toThrow(/cannot sign auth entries/);
    expect(r.log).toEqual([]);
  });

  it('single-operator mode is byte-for-byte unaffected: no sourcePublic -> operator signs, source-account auth', async () => {
    const r = rig();
    // single-operator sim returns source-account credentials, exactly as before
    (r.rpc as { simulate: unknown }).simulate = async () => fakeSimResult(TROY_POOL, MERCHANT);
    const operatorKp = Keypair.fromSecret(OPERATOR_SECRET);
    const client = makeClient(r, {});
    const res = await client.submitPay({ ...buildParams, orderId: 'ord-op-1' });
    const tx = TransactionBuilder.fromXDR(res.signedXdr, buildParams.passphrase) as Transaction;
    expect(tx.source).toBe(OPERATOR_PUBLIC);
    expect(tx.signatures[0]?.hint().equals(operatorKp.signatureHint())).toBe(true);
  });
});

describe('channel-mode observe — deadness reads the CHANNEL account', () => {
  it('targets sourcePublic when present, the operator when absent', async () => {
    const r = rig();
    const client = makeClient(r, {});
    const base = { phase: 'polling' as const, hashHex: 'aa'.repeat(32), ourSeq: 201n, maxTime: 60 };
    await client.observe({ ...base, sourcePublic: CHANNEL_PUBLIC });
    await client.observe(base);
    expect(r.seqReads).toEqual([CHANNEL_PUBLIC, OPERATOR_PUBLIC]);
  });
});

describe('assembleWithSignedAuth — fail-closed validations', () => {
  const unprepared = buildPayTransaction({
    ...buildParams,
    sourcePublic: CHANNEL_PUBLIC,
    seq: '200',
  });
  const sim = channelSim();

  async function signedEntries(): Promise<string[]> {
    const signer = new LocalKeySigner(OPERATOR_SECRET);
    return Promise.all(
      sim.authXdr.map((b64) =>
        signer.signAuthEntry(b64, HEAD_LEDGER + 120, buildParams.passphrase),
      ),
    );
  }

  it('accepts properly signed operator entries', async () => {
    const tx = assembleWithSignedAuth(unprepared, sim, await signedEntries(), OPERATOR_PUBLIC);
    expect(tx.source).toBe(CHANNEL_PUBLIC);
  });

  it('rejects an UNSIGNED entry (a void signature would burn a channel seq on an auth-doomed tx)', () => {
    expect(() =>
      assembleWithSignedAuth(unprepared, sim, [...sim.authXdr], OPERATOR_PUBLIC),
    ).toThrow(/unsigned/);
  });

  it("rejects an entry authorizing someone ELSE (nobody else's authority belongs in a pay())", async () => {
    const foreign = addressAuthXdr(TROY_POOL, MERCHANT);
    const signer = new LocalKeySigner(OPERATOR_SECRET); // the operator "signs" a foreign-address entry
    const signed = await signer.signAuthEntry(foreign, HEAD_LEDGER + 120, buildParams.passphrase);
    expect(() => assembleWithSignedAuth(unprepared, sim, [signed], OPERATOR_PUBLIC)).toThrow(
      /not the operator/,
    );
  });

  it('rejects a SOURCE-ACCOUNT entry in channel mode (it would authorize the channel, not the operator)', () => {
    const sourceSim = fakeSimResult(TROY_POOL, MERCHANT);
    expect(() =>
      assembleWithSignedAuth(unprepared, sourceSim, [...sourceSim.authXdr], OPERATOR_PUBLIC),
    ).toThrow(/ADDRESS-credential/);
  });

  it('rejects an entry-count mismatch with the simulation', async () => {
    expect(() => assembleWithSignedAuth(unprepared, sim, [], OPERATOR_PUBLIC)).toThrow(
      /do not match/,
    );
  });
});

describe('LocalKeySigner.signAuthEntry', () => {
  it('round-trips: stamps validUntilLedger and a verifiable signature, leaving the invocation intact', async () => {
    const signer = new LocalKeySigner(OPERATOR_SECRET);
    const signed = await signer.signAuthEntry(
      addressAuthXdr(TROY_POOL, OPERATOR_PUBLIC),
      HEAD_LEDGER + 120,
      buildParams.passphrase,
    );
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(signed, 'base64');
    const creds = entry.credentials().address();
    expect(creds.signatureExpirationLedger()).toBe(HEAD_LEDGER + 120);
    expect(creds.signature().switch().name).not.toBe('scvVoid');
    expect(entry.rootInvocation().function().switch().name).toBe(
      'sorobanAuthorizedFunctionTypeContractFn',
    );
  });
});
