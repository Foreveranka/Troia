// GENESIS. The ledger starts at zero; the pool does not. Its opening balance was minted by our own issuer,
// outside the TRY book, so nothing in the journal explains it — and the drift alarm, which weighs the ledger
// against the chain, would read that unexplained balance as a permanent discrepancy the size of the whole pool.
//
// So the opening balance is booked once, on the first boot with an empty journal, and never again. These tests
// pin the two ways that can go wrong: booking it never (a permanent alarm), and booking it twice (a permanent
// alarm of the opposite sign, which is worse — the books would claim more USDC than the chain ever held).

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-base';
import type { OracleProvider, OracleResult, RateHistoryProvider } from '@troia/oracle';
import { checkDrift } from '@troia/backend';
import { buildTestnetServerDeps } from '../src/testnet-deps.js';
import type { BootstrapReads, TestnetServerConfig } from '../src/testnet-deps.js';
import { buildDurableBundle } from '../src/durable-bundle.js';

const MID_E7 = 405_000_000n; // 40.50 TRY/USDC
const POOL = 99_994n * 10_000_000n; // 99,994 USDC on chain

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

function cfg(dataDir: string | undefined): TestnetServerConfig {
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
    ...(dataDir === undefined ? {} : { dataDir }),
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'troia-genesis-'));
}

describe('genesis — the opening pool balance is explained, exactly once', () => {
  it('the drift alarm starts silent: the books already account for what the chain holds', async () => {
    const dir = tmp();
    await buildTestnetServerDeps(cfg(dir), bootstrap);

    const { ledger } = buildDurableBundle(dir); // read the journal back the way a restart would
    expect(ledger.all()).toHaveLength(1);
    expect(ledger.all()[0]?.ref).toBe('genesis');
    expect(ledger.nativeBalance('USDC_POOL')).toBe(POOL);

    const drift = await checkDrift({
      stellar: { readPoolBalanceStroops: () => Promise.resolve(POOL) },
      ledger,
    });
    expect(drift).toMatchObject({ inSync: true, driftStroops: 0n });
  });

  it('values the opening balance at the live mid, and books it as external funding', async () => {
    const dir = tmp();
    await buildTestnetServerDeps(cfg(dir), bootstrap);
    const { ledger } = buildDurableBundle(dir);

    // 99,994 USDC × 40.50 TRY = 4,049,757.00 TRY = 404,975,700 kuruş
    const expectedKurus = (POOL * MID_E7) / 1_000_000_000_000n;
    expect(expectedKurus).toBe(404_975_700n);
    expect(ledger.balanceKurus('EXTERNAL_FUNDING')).toBe(-expectedKurus); // credit-normal
    expect(ledger.trialBalanceKurus()).toBe(0n);
  });

  it('a restart does NOT book it again — the journal already explains the pool', async () => {
    const dir = tmp();
    await buildTestnetServerDeps(cfg(dir), bootstrap);
    await buildTestnetServerDeps(cfg(dir), bootstrap); // the process came back

    const { ledger } = buildDurableBundle(dir);
    expect(ledger.all()).toHaveLength(1);
    expect(ledger.nativeBalance('USDC_POOL')).toBe(POOL); // not 2× the pool
  });

  it('an empty pool books nothing — there is nothing to explain', async () => {
    const dir = tmp();
    await buildTestnetServerDeps(cfg(dir), {
      operatorSeqNum: () => Promise.resolve(1n),
      poolBalanceStroops: () => Promise.resolve(0n),
    });
    expect(buildDurableBundle(dir).ledger.all()).toEqual([]);
  });

  it('a dead oracle fails the FIRST boot closed rather than guessing the opening valuation', async () => {
    const dir = tmp();
    const dead: OracleProvider = {
      getRate: () =>
        Promise.resolve({ ok: false, error: new Error('all sources down') } as OracleResult),
    };
    await expect(
      buildTestnetServerDeps({ ...cfg(dir), spotOracle: dead }, bootstrap),
    ).rejects.toThrow('all sources down');
    expect(buildDurableBundle(dir).ledger.all()).toEqual([]); // nothing half-booked
  });

  it('without a data dir the ledger stays pure and no genesis is booked (the offline suite)', async () => {
    const deps = await buildTestnetServerDeps(cfg(undefined), bootstrap);
    expect(deps.settlement.ledger.detectDrift(0n).expectedPoolStroops).toBe(0n);
  });
});
