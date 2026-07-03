import { describe, expect, it } from 'vitest';
import { createStellarClient } from '../src/client.js';
import type { HorizonPort, RpcPort, Signer, WriteAheadJournal } from '../src/ports.js';
import type { SendOutcome } from '../src/outcomes.js';
import { fakeSimResult } from './fixtures/fake-sim-result.js';
import { buildParams, MERCHANT, OPERATOR_PUBLIC, TROY_POOL } from './fixtures/vectors.js';

// The write-ahead invariant: the exact signed envelope is durable BEFORE any send. The fake RpcPort.send
// throws if it ever receives bytes that were not persisted first, so any ordering regression fails here.

describe('client.submitPay — write-ahead ordering (persist before send)', () => {
  it('persists the signed envelope BEFORE the first send, with the SAME bytes', async () => {
    const persisted = new Set<string>();
    const log: string[] = [];

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
        return fakeSimResult(TROY_POOL, MERCHANT);
      },
      async send(signedXdr: string): Promise<SendOutcome> {
        if (!persisted.has(signedXdr)) throw new Error('SEND BEFORE PERSIST — write-ahead violated');
        log.push('send');
        return { kind: 'PENDING', hashHex: 'ab' };
      },
    } as unknown as RpcPort;

    const signer: Signer = {
      publicKey: () => OPERATOR_PUBLIC,
      sign: (tx) => tx.toEnvelope().toXDR('base64'),
    };

    const client = createStellarClient({
      rpc,
      horizon: {} as HorizonPort,
      signer,
      journal,
      clock: { nowUnix: () => 0 },
    });

    const res = await client.submitPay({ ...buildParams, orderId: 'ord-1' });

    expect(log).toEqual(['persist', 'send']);
    expect(res.outcome.kind).toBe('PENDING');
    expect(persisted.has(res.signedXdr)).toBe(true);
  });
});
