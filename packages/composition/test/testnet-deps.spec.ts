// buildTestnetServerDeps assembles the full ServerDeps offline: the store is seeded from INJECTED bootstrap reads
// (so the network is never touched), and a valid operator keypair is generated so the fail-closed key check passes.
// The money-relevant assertions: the store's available balance == the read pool balance, and the first allocated
// seq == the on-chain seq + 1 (a valid tx seqNum); a mismatched operator secret fails closed.

import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-base';
import type { OracleProvider, OracleResult, RateHistoryProvider } from '@troia/oracle';
import { buildTestnetServerDeps, DEFAULT_TESTNET_MERCHANT } from '../src/testnet-deps.js';
import type { BootstrapReads, TestnetServerConfig } from '../src/testnet-deps.js';

const fakeOracle: OracleProvider = {
  getRate: () =>
    Promise.resolve({ ok: true, quote: { midTryPerUsdc: 405_000_000n, sources: ['fake'], asOfMs: 0 } } as OracleResult),
};
const fakeHistory: RateHistoryProvider = {
  dailyCloses: () => Promise.resolve([40.0, 40.1, 40.2, 40.3, 40.4]),
};

function baseCfg(): { cfg: TestnetServerConfig; pub: string } {
  const kp = Keypair.random();
  const pub = kp.publicKey();
  const issuerKp = Keypair.random(); // the USDC SAC admin — usdcIssuer is DERIVED so the issuer key check passes
  const cfg: TestnetServerConfig = {
    deployment: {
      usdcIssuer: issuerKp.publicKey(),
      usdcSacContractId: 'CCOAUUKWWPSVFZUPIVZECTV3PIVFRTVFKWWF2PQY5Q5CN3JBCDXGNCMB',
      troyPool: 'CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ',
      operatorPublic: pub,
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
  };
  return { cfg, pub };
}

const bootstrap: BootstrapReads = {
  operatorSeqNum: () => Promise.resolve(4242n),
  poolBalanceStroops: () => Promise.resolve(99_994n * 10_000_000n),
};

describe('buildTestnetServerDeps', () => {
  it('assembles ServerDeps: network from the deployment, store seeded from the bootstrap reads', async () => {
    const { cfg, pub } = baseCfg();
    const deps = await buildTestnetServerDeps(cfg, bootstrap);

    expect(deps.network.network).toBe('testnet');
    expect(deps.network.operatorPublic).toBe(pub);
    expect(deps.network.contracts.troyPool).toBe(cfg.deployment.troyPool);
    // store seeded from the reads: available == pool balance, first seq == on-chain seq + 1
    expect(deps.ports.store.availableStroops()).toBe(99_994n * 10_000_000n);
    expect(deps.ports.store.sequences.allocate('o1')).toBe(4243n);
    expect(deps.webhookSigningSecret).toBe('wh');
    expect(typeof deps.quote).toBe('function');
    // ports wired
    expect(typeof deps.ports.stellar.readPoolBalanceStroops).toBe('function');
    expect(typeof deps.ports.psp.initializeCheckoutForm).toBe('function');
    expect(typeof deps.ports.clock.nowUnix).toBe('function');
  });

  it('fills the merchant template with the callbackUrl + fixed TRY currency', async () => {
    const { cfg } = baseCfg();
    const deps = await buildTestnetServerDeps(cfg, bootstrap);
    expect(deps.extras.psp.callbackUrl).toBe('https://troia.example/webhook');
    expect(deps.extras.psp.currency).toBe('TRY');
    expect(deps.extras.psp.buyer.id).toBe('buyer-stub'); // the KYC-stub default
  });

  it('applies extras defaults and honours overrides', async () => {
    const { cfg } = baseCfg();
    const def = await buildTestnetServerDeps(cfg, bootstrap);
    expect(def.extras.feeStroops).toBe('100');
    expect(def.extras.timeboundsSecs).toBe(45);
    expect(def.extras.policy.maxDeadRetries).toBeGreaterThan(0);

    const over = await buildTestnetServerDeps({ ...cfg, feeStroops: '250', timeboundsSecs: 60 }, bootstrap);
    expect(over.extras.feeStroops).toBe('250');
    expect(over.extras.timeboundsSecs).toBe(60);
  });

  it('seeds the store so allocate() returns the on-chain seq + 1 and available == the read balance', async () => {
    const { cfg } = baseCfg();
    const deps = await buildTestnetServerDeps(cfg, {
      operatorSeqNum: () => Promise.resolve(100n),
      poolBalanceStroops: () => Promise.resolve(5n),
    });
    expect(deps.ports.store.sequences.allocate('x')).toBe(101n);
    expect(deps.ports.store.availableStroops()).toBe(5n);
  });

  it('FAILS CLOSED when the operator secret does not match the deployment operatorPublic', async () => {
    const { cfg } = baseCfg();
    const wrong: TestnetServerConfig = {
      ...cfg,
      deployment: { ...cfg.deployment, operatorPublic: Keypair.random().publicKey() },
    };
    await expect(buildTestnetServerDeps(wrong, bootstrap)).rejects.toThrow(/operator secret/i);
  });

  it('FAILS CLOSED when the issuer secret does not match the deployment usdcIssuer (the mint key)', async () => {
    const { cfg } = baseCfg();
    const wrong: TestnetServerConfig = {
      ...cfg,
      deployment: { ...cfg.deployment, usdcIssuer: Keypair.random().publicKey() },
    };
    await expect(buildTestnetServerDeps(wrong, bootstrap)).rejects.toThrow(/issuer secret/i);
  });

  it('wires the TRY-driven rebalance settlement bundle (demo valör default 30s)', async () => {
    const { cfg } = baseCfg();
    const deps = await buildTestnetServerDeps(cfg, bootstrap);
    expect(deps.settlement?.demoValorSecs).toBe(30);
    expect(typeof deps.settlement?.rebalance.topUp).toBe('function');
    expect(typeof deps.settlement?.rate.liveRateStroops).toBe('function');
    // the live-rate reader returns the oracle mid (scaled by RATE_SCALE == the policy's stroops)
    await expect(deps.settlement?.rate.liveRateStroops()).resolves.toBe(405_000_000n);
  });
});

// Regression guard for a live-smoke fix: iyzico rejects a reserved / non-resolvable email TLD (.test/.invalid/
// .localhost/.example) with errorCode 5 "email hatalı format", which fail-closed the checkout-form init (503
// CheckoutUnavailable). The KYC-stub buyer must use a valid public-TLD email.
describe('DEFAULT_TESTNET_MERCHANT — the KYC-stub buyer', () => {
  it('uses a valid, non-reserved-TLD buyer email (iyzico rejects .test etc. as an invalid format)', () => {
    const email = DEFAULT_TESTNET_MERCHANT.buyer.email;
    expect(email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/); // well-formed local@domain.tld
    const tld = (email.split('.').pop() ?? '').toLowerCase();
    expect(['test', 'invalid', 'localhost', 'example']).not.toContain(tld);
  });
});
