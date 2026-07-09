// wrapStellarPort: pure wiring of a StellarClient + the two extra Soroban reads + the write-ahead journal into
// the backend StellarPort. Tested with fakes (no SDK, no network). The money-critical guarantee: readRevertErrorCode
// scopes the revert-code read to the TroyPool contract (never the USDC SAC) and resolves the order's tx hash from
// the SHARED journal; readPoolBalanceStroops reads the pool's SAC balance with the right holder + source.

import { describe, expect, it } from 'vitest';
import { InMemoryJournal } from '@troia/stellar-client';
import type {
  CoreAccountSnapshot,
  ObserveResult,
  PayRequest,
  ReducerState,
  SendOutcome,
  StellarClient,
  SubmitResult,
} from '@troia/stellar-client';
import { wrapStellarPort } from '../src/stellar-port.js';
import type { SorobanReads } from '../src/stellar-port.js';

const WIRING = {
  sacContractId: 'CCOAUUKWWPSVFZUPIVZECTV3PIVFRTVFKWWF2PQY5Q5CN3JBCDXGNCMB', // USDC SAC
  troyPool: 'CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ', // pool contract
  operatorPublic: 'GDMAG4EMNWL6T4IJ6PXGBTBJEWAKFJ2YRKRFRIF7ZM7MG6YFZZU35E4S',
};

const SUBMIT: SubmitResult = {
  hashHex: 'h1',
  signedXdr: 's1',
  seq: '1001',
  outcome: { kind: 'PENDING', hashHex: 'h1' },
};
const RESEND: SendOutcome = { kind: 'PENDING', hashHex: 'h1' };
const OBSERVE: ObserveResult = {
  next: { phase: 'polling', hashHex: 'h1', ourSeq: 1001n, maxTime: 0 },
  action: 'none',
};
const SNAP: CoreAccountSnapshot = {
  exists: true,
  trustlines: [{ assetCode: 'USDC', assetIssuer: 'GISSUER' }],
};

class FakeClient implements StellarClient {
  submitArg?: PayRequest;
  resendArg?: string;
  observeArg?: ReducerState;
  snapArg?: string;
  submitPay(req: PayRequest): Promise<SubmitResult> {
    this.submitArg = req;
    return Promise.resolve(SUBMIT);
  }
  resendPersisted(orderId: string): Promise<SendOutcome> {
    this.resendArg = orderId;
    return Promise.resolve(RESEND);
  }
  observe(state: ReducerState): Promise<ObserveResult> {
    this.observeArg = state;
    return Promise.resolve(OBSERVE);
  }
  loadDestinationSnapshot(destination: string): Promise<CoreAccountSnapshot> {
    this.snapArg = destination;
    return Promise.resolve(SNAP);
  }
}

class FakeReads implements SorobanReads {
  sacCalls: [string, string, string][] = [];
  codeCalls: [string, string][] = [];
  balance = 99_994n * 10_000_000n;
  code: number | null = 1;
  readSacBalance(
    sacContractId: string,
    holderAddress: string,
    sourcePublic: string,
  ): Promise<bigint> {
    this.sacCalls.push([sacContractId, holderAddress, sourcePublic]);
    return Promise.resolve(this.balance);
  }
  readContractErrorCode(hashHex: string, contractId: string): Promise<number | null> {
    this.codeCalls.push([hashHex, contractId]);
    return Promise.resolve(this.code);
  }
}

function make(): {
  port: ReturnType<typeof wrapStellarPort>;
  client: FakeClient;
  reads: FakeReads;
  journal: InMemoryJournal;
} {
  const client = new FakeClient();
  const reads = new FakeReads();
  const journal = new InMemoryJournal();
  return { port: wrapStellarPort(client, reads, journal, WIRING), client, reads, journal };
}

describe('wrapStellarPort — the two extra reads (money-critical)', () => {
  it('readPoolBalanceStroops reads the SAC balance with (sac, POOL-as-holder, operator-as-source)', async () => {
    const { port, reads } = make();
    const bal = await port.readPoolBalanceStroops();
    expect(bal).toBe(99_994n * 10_000_000n);
    expect(reads.sacCalls).toEqual([
      [WIRING.sacContractId, WIRING.troyPool, WIRING.operatorPublic],
    ]);
  });

  it('readRevertErrorCode resolves orderId->hash from the journal and scopes the read to the POOL contract', async () => {
    const { port, reads, journal } = make();
    await journal.persistPreSubmit('order-1', '1001', 'txhashABC', 'signedXDR');
    const code = await port.readRevertErrorCode('order-1');
    expect(code).toBe(1);
    // the money-critical assertion: the contractId is the TroyPool id, NEVER the USDC SAC id.
    expect(reads.codeCalls).toEqual([['txhashABC', WIRING.troyPool]]);
    expect(reads.codeCalls[0]![1]).not.toBe(WIRING.sacContractId);
  });

  it('readRevertErrorCode returns null (and never reads a code) when the order has no persisted witness', async () => {
    const { port, reads } = make();
    expect(await port.readRevertErrorCode('unknown-order')).toBeNull();
    expect(reads.codeCalls).toEqual([]);
  });

  it('propagates a null revert code (unreadable -> safe re-drive default)', async () => {
    const { port, reads, journal } = make();
    reads.code = null;
    await journal.persistPreSubmit('order-1', '1001', 'txhashABC', 'signedXDR');
    expect(await port.readRevertErrorCode('order-1')).toBeNull();
  });
});

describe('wrapStellarPort — core methods forward to the client', () => {
  it('forwards submitPay / resendPersisted / observe / loadDestinationSnapshot verbatim', async () => {
    const { port, client } = make();
    const req = { orderId: 'order-1' } as unknown as PayRequest;
    expect(await port.submitPay(req)).toBe(SUBMIT);
    expect(client.submitArg).toBe(req);
    expect(await port.resendPersisted('order-1')).toBe(RESEND);
    expect(client.resendArg).toBe('order-1');
    const state: ReducerState = { phase: 'polling', hashHex: 'h1', ourSeq: 1n, maxTime: 0 };
    expect(await port.observe(state)).toBe(OBSERVE);
    expect(client.observeArg).toBe(state);
    expect(await port.loadDestinationSnapshot('GDEST')).toBe(SNAP);
    expect(client.snapArg).toBe('GDEST');
  });

  it('exposes all six StellarPort methods', () => {
    const { port } = make();
    for (const m of [
      'submitPay',
      'resendPersisted',
      'observe',
      'loadDestinationSnapshot',
      'readPoolBalanceStroops',
      'readRevertErrorCode',
    ] as const) {
      expect(typeof port[m]).toBe('function');
    }
  });
});
