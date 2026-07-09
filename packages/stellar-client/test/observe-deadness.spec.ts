import { describe, expect, it } from 'vitest';
import { createStellarClient } from '../src/client.js';
import type { HorizonPort, RpcPort, Signer, WriteAheadJournal } from '../src/ports.js';
import type { AccountSeqRead, GetTxOutcome } from '../src/outcomes.js';
import type { ReducerState } from '../src/submit-reducer.js';
import { OPERATOR_PUBLIC } from './fixtures/vectors.js';

// Exercises client.observe()'s deadness path end-to-end with fakes — the orchestration the pure specs could
// not reach. In particular it pins the fail-CLOSED handling of an unresolvable operator-seq read (the
// adversarial CONFIRMED finding): exists:false must escalate to LOSS_REVIEW, never SAFE_TO_REPLACE.

const OUR_SEQ = 101n;
const MAX_TIME = 1000;
const state: ReducerState = {
  phase: 'polling',
  hashHex: 'ab'.repeat(32),
  ourSeq: OUR_SEQ,
  maxTime: MAX_TIME,
};

function makeClient(opts: {
  getTx: GetTxOutcome;
  accountSeq?: AccountSeqRead;
  closeTimeUnix?: number;
}) {
  const rpc = {
    async getTransaction(): Promise<GetTxOutcome> {
      return opts.getTx;
    },
    async readAccountSeq(): Promise<AccountSeqRead> {
      if (opts.accountSeq === undefined) throw new Error('readAccountSeq should not be called');
      return opts.accountSeq;
    },
    async latestLedger() {
      return { sequence: 5, closeTimeUnix: opts.closeTimeUnix ?? 0 };
    },
  } as unknown as RpcPort;

  const signer: Signer = { publicKey: () => OPERATOR_PUBLIC, sign: () => 'X' };
  return createStellarClient({
    rpc,
    horizon: {} as HorizonPort,
    signer,
    journal: {} as WriteAheadJournal,
    clock: { nowUnix: () => 0 },
  });
}

describe('client.observe — deadness orchestration', () => {
  it('FAIL-CLOSED: an unresolvable operator-seq read (exists:false) escalates to LOSS_REVIEW, not a replace', async () => {
    const client = makeClient({
      getTx: { kind: 'NOT_FOUND', latestLedgerCloseTimeUnix: 2000 }, // past maxTime -> expired
      accountSeq: { exists: false, seq: '0' },
      closeTimeUnix: 2000,
    });
    const r = await client.observe(state);
    expect(r.action).toBe('resolveDeadness');
    expect(r.deadness).toBe('LOSS_REVIEW');
    expect(r.verdict).toBe('INDETERMINATE_LOSS_REVIEW');
  });

  it('unburned + ledger-expired -> SAFE_TO_REPLACE / DEAD_REPLACEABLE', async () => {
    const client = makeClient({
      getTx: { kind: 'NOT_FOUND', latestLedgerCloseTimeUnix: 2000 },
      accountSeq: { exists: true, seq: '100' }, // < ourSeq (101) -> unburned
      closeTimeUnix: 2000,
    });
    const r = await client.observe(state);
    expect(r.deadness).toBe('SAFE_TO_REPLACE');
    expect(r.verdict).toBe('DEAD_REPLACEABLE');
  });

  it('burned seq without proven success -> LOSS_REVIEW', async () => {
    const client = makeClient({
      getTx: { kind: 'NOT_FOUND', latestLedgerCloseTimeUnix: 2000 },
      accountSeq: { exists: true, seq: '101' }, // >= ourSeq -> burned
      closeTimeUnix: 2000,
    });
    const r = await client.observe(state);
    expect(r.deadness).toBe('LOSS_REVIEW');
    expect(r.verdict).toBe('INDETERMINATE_LOSS_REVIEW');
  });

  it('a live SUCCESS concludes without any deadness read', async () => {
    const client = makeClient({ getTx: { kind: 'SUCCESS', ledger: 42 } }); // accountSeq omitted -> must not be read
    const r = await client.observe(state);
    expect(r.action).toBe('none');
    expect(r.verdict).toBe('LANDED_SUCCESS');
    expect(r.deadness).toBeUndefined();
  });

  it('NOT_FOUND with valid timebounds keeps polling (no deadness read)', async () => {
    const client = makeClient({ getTx: { kind: 'NOT_FOUND', latestLedgerCloseTimeUnix: 500 } }); // <= maxTime
    const r = await client.observe(state);
    expect(r.action).toBe('poll');
    expect(r.verdict).toBe('STILL_PENDING');
    expect(r.deadness).toBeUndefined();
  });
});
