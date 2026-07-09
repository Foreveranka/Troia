import { describe, expect, it } from 'vitest';
import { isDurableLogFailure } from '../../src/ports.js';
import { InMemoryStore } from '../../src/store/in-memory-store.js';
import type { DurableLog, EvidenceRecord, OrderFacts } from '../../src/ports.js';

const FACTS: OrderFacts = {
  destination: 'GDESTINATIONACCOUNTPLACEHOLDER0000000000000000',
  amountStroops: 1_000_000_000n,
  memoHex: 'ab'.repeat(32),
  appliedRateStroops: 340_000_000n,
  paidPriceTry: '3400.00',
  spreadKurus: 5_000n,
  feeKurus: 2_000n,
};

// A poisoned durable log is a fail-STOP condition, not a retryable one: nothing can be booked again, so a caller
// that swallows it and retries would re-run whatever preceded the write (in the settlement worker, an on-chain
// mint) forever, recording none of it. The backend recognises the failure structurally, without importing the
// composition root's fs module — this pins that contract from both ends.

const REC: EvidenceRecord = {
  txHash: 'a'.repeat(64),
  signedXdr: 'AAAAAg==',
  seq: '1001',
  witnessedAtUnix: 1_700_000_000,
};

/** The shape packages/composition's FileAppendLog throws. Duplicated here on purpose: if that class ever stops
 *  carrying this code, this test still passes but the composition-side test fails — which is the drift we want. */
class FakeDurableLogError extends Error {
  readonly code = 'DurableLogFailure';
}

describe('isDurableLogFailure', () => {
  it('recognises a durable-log failure by its code, not its class', () => {
    expect(isDurableLogFailure(new FakeDurableLogError('poisoned'))).toBe(true);
    expect(isDurableLogFailure({ code: 'DurableLogFailure' })).toBe(true);
  });

  it('does not mistake an ordinary failure for one', () => {
    expect(isDurableLogFailure(new Error('ENOSPC'))).toBe(false);
    expect(isDurableLogFailure({ code: 'DuplicateRef' })).toBe(false);
    expect(isDurableLogFailure(null)).toBe(false);
    expect(isDurableLogFailure('DurableLogFailure')).toBe(false);
  });

  it('a store whose log is poisoned surfaces a recognisable failure, having booked nothing', async () => {
    const poisoned: DurableLog = {
      append(): void {
        throw new FakeDurableLogError('the log is poisoned by an earlier write failure');
      },
    };
    const s = new InMemoryStore({ balanceStroops: 1n, baseSeq: 1n, evidenceLog: poisoned });
    const err = await s.appendEvidence('o1', REC, FACTS).catch((e: unknown) => e);
    expect(isDurableLogFailure(err)).toBe(true);
    expect(s.evidenceRecords()).toEqual([]);
  });
});
