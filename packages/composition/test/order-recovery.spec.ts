// A-1 end-to-end through the real factory: an order parked in SolvencyReserved (customer possibly paying on
// the hosted form) when the process dies must come back on the next boot's poll work-list, with its ctx, its
// reservation and its retry budget intact. This is the KNOWN_ISSUES §1 crash window, closed and pinned.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-base';
import type { OracleProvider, OracleResult, RateHistoryProvider } from '@troia/oracle';
import type { OrderCtx, ServerDeps } from '@troia/backend';
import { buildTestnetServerDeps } from '../src/testnet-deps.js';
import type { BootstrapReads, TestnetServerConfig } from '../src/testnet-deps.js';

const MID_E7 = 405_000_000n;
const POOL = 1_000n * 10_000_000n;
const AMOUNT = 100n * 10_000_000n;

const fakeOracle: OracleProvider = {
  getRate: () =>
    Promise.resolve({
      ok: true,
      quote: { midTryPerUsdc: MID_E7, sources: ['fake'], asOfMs: 0 },
    } as OracleResult),
};
const fakeHistory: RateHistoryProvider = {
  dailyCloses: () => Promise.resolve([40.0, 40.1, 40.2, 40.3, 40.4]),
};
const bootstrap: BootstrapReads = {
  operatorSeqNum: () => Promise.resolve(4242n),
  poolBalanceStroops: () => Promise.resolve(POOL),
};

function cfg(dataDir: string): TestnetServerConfig {
  const kp = Keypair.random();
  const issuerKp = Keypair.random();
  return {
    deployment: {
      usdcIssuer: issuerKp.publicKey(),
      usdcSacContractId: 'CCOAUUKWWPSVFZUPIVZECTV3PIVFRTVFKWWF2PQY5Q5CN3JBCDXGNCMB',
      troyPool: 'CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ',
      operatorPublic: kp.publicKey(),
      adminPublic: 'GBNPLKNNSAR6JZRYQLDFJKZ5WY73S42BDDPWVHNLDMNHIQHLZYOJ2QDZ',
    },
    secrets: {
      operatorSecret: kp.secret(),
      issuerSecret: issuerKp.secret(),
      iyzicoApiKey: 'ak',
      iyzicoSecretKey: 'sk',
      webhookSigningSecret: 'wh',
    },
    callbackUrl: 'https://troia.example/webhook',
    spotOracle: fakeOracle,
    history: fakeHistory,
    dataDir,
  };
}

function ctxOf(orderId: string): OrderCtx {
  return {
    orderId,
    conversationId: `conv-${orderId}`,
    destination: 'GDESTINATIONACCOUNTPLACEHOLDER0000000000000000',
    amountStroops: AMOUNT,
    appliedRateStroops: MID_E7,
    memoHex: 'ab'.repeat(32),
    paymentId: null,
    token: 'form-token-1',
    paymentPageUrl: 'https://sandbox.iyzico/form/1',
    paidPriceTry: '4131.00',
    spreadKurus: 5_000n,
    feeKurus: 2_000n,
    currency: 'TRY',
    ip: '203.0.113.7',
    activeSeq: null,
    hashHex: null,
    signedXdr: null,
    payMaxTimeUnix: null,
    deadRetries: 0,
    reversalRetries: 0,
  };
}

/** The factory injects a durable registry whenever a dataDir is present — assert and narrow. */
function durableRegistry(deps: ServerDeps): NonNullable<ServerDeps['registry']> {
  expect(deps.registry).toBeDefined();
  return deps.registry as NonNullable<ServerDeps['registry']>;
}

describe('order recovery through the real factory (A-1)', () => {
  it('a SolvencyReserved order survives the restart with ctx, reservation and counters intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'troia-recovery-'));

    // Life 1 — the /intent flow up to the hosted-form wait, exactly as app.ts orders the writes.
    const deps1 = await buildTestnetServerDeps(cfg(dir), bootstrap);
    const reg1 = durableRegistry(deps1);
    reg1.put(ctxOf('o-1'), 'Reserved'); // app.ts:271 — ctx durable BEFORE start()
    await deps1.ports.store.createIfAbsent('o-1');
    await deps1.ports.store.reserve('o-1', AMOUNT, 60_000, 1_700_000_000_000);
    await deps1.ports.store.bumpDeadRetries('o-1');
    reg1.put(ctxOf('o-1'), 'SolvencyReserved'); // quiescent put after the form was issued
    expect(deps1.ports.store.availableStroops()).toBe(POOL - AMOUNT);

    // CRASH — every object dropped. Life 2 boots over the same data dir (fresh chain reads, same pool).
    const deps2 = await buildTestnetServerDeps(cfg(dir), bootstrap);

    // The reservation is replayed as held: the pool cannot be over-committed while the order's fate is open.
    expect(deps2.ports.store.availableStroops()).toBe(POOL - AMOUNT);

    // The poll worker's work-list finds the order, with the form token it needs to re-retrieve the sale.
    const work = durableRegistry(deps2).ordersInStates(['SolvencyReserved']);
    expect(work).toHaveLength(1);
    expect(work[0]?.ctx.token).toBe('form-token-1');
    expect(work[0]?.ctx.amountStroops).toBe(AMOUNT);

    // And the retry budget kept counting instead of resetting to zero.
    expect(await deps2.ports.store.bumpDeadRetries('o-1')).toBe(2);
  });
});
