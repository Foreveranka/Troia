import { describe, expect, it } from 'vitest';
import { createStellarClient } from '../src/client.js';
import type { HorizonPort, RpcPort, Signer, WriteAheadJournal } from '../src/ports.js';
import type { SendOutcome } from '../src/outcomes.js';
import { SubmitError } from '../src/errors.js';
import { OPERATOR_PUBLIC } from './fixtures/vectors.js';

// SPIKE-2 idempotent recovery: resend the EXACT persisted bytes, NEVER rebuild / re-simulate / re-sign
// (which would change the footprint -> a different hash -> a double-pay on the same sequence).

describe('client.resendPersisted — byte-exact idempotent recovery', () => {
  it('sends the persisted bytes verbatim and does not simulate or sign again', async () => {
    let simulateCalls = 0;
    let signCalls = 0;
    let sent: string | null = null;

    const journal: WriteAheadJournal = {
      async persistPreSubmit() {},
      async loadPersisted() {
        return { hashHex: 'ab', signedXdr: 'PERSISTED_BYTES' };
      },
    };

    const rpc = {
      async simulate() {
        simulateCalls++;
        throw new Error('must not simulate on resend');
      },
      async send(signedXdr: string): Promise<SendOutcome> {
        sent = signedXdr;
        return { kind: 'DUPLICATE', hashHex: 'ab' };
      },
    } as unknown as RpcPort;

    const signer: Signer = {
      publicKey: () => OPERATOR_PUBLIC,
      sign: () => {
        signCalls++;
        return 'X';
      },
    };

    const client = createStellarClient({
      rpc,
      horizon: {} as HorizonPort,
      signer,
      journal,
      clock: { nowUnix: () => 0 },
    });

    const outcome = await client.resendPersisted('ord-1');

    expect(sent).toBe('PERSISTED_BYTES');
    expect(simulateCalls).toBe(0);
    expect(signCalls).toBe(0);
    expect(outcome.kind).toBe('DUPLICATE');
  });

  it('fails closed when there is nothing persisted to resend', async () => {
    const journal: WriteAheadJournal = {
      async persistPreSubmit() {},
      async loadPersisted() {
        return null;
      },
    };
    const rpc = {
      async send(): Promise<SendOutcome> {
        throw new Error('should not send');
      },
    } as unknown as RpcPort;
    const signer: Signer = { publicKey: () => OPERATOR_PUBLIC, sign: () => 'X' };

    const client = createStellarClient({
      rpc,
      horizon: {} as HorizonPort,
      signer,
      journal,
      clock: { nowUnix: () => 0 },
    });

    await expect(client.resendPersisted('missing')).rejects.toBeInstanceOf(SubmitError);
  });
});
