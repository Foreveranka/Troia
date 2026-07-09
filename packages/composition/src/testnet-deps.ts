// buildTestnetServerDeps — the top factory: map a testnet deployment + env secrets + injected oracle/history into
// the ServerDeps that @troia/backend's createServer consumes. This is where ALL the pieces meet: the real Stellar
// adapters (buildStellarPort), the iyzico provider (createPaymentProvider), the PSP-inclusive quote (makeQuoteFn),
// and an InMemoryStore SEEDED from two bootstrap chain reads — the operator's on-chain sequence (so allocated tx
// seqNums are valid) and the pool's live USDC balance (so the reservation ledger reflects reality).
//
// The bootstrap reads are an injectable seam, so the assembly is offline-unit-testable (a fake supplies the two
// numbers); the DEFAULT reads hit the network and are live-smoked. Fail-closed: a mismatched operator secret
// throws before anything is wired, so the server never runs signing with the wrong key.

import { testnetConfig } from '@troia/config';
import type { TestnetDeployment } from '@troia/config';
import {
  InMemoryStore,
  InMemoryPendingSettlementStore,
  TryDrivenRebalancePolicy,
  OFFLINE_DEFAULT_POLICY,
  OFFLINE_DEFAULT_PRICING_POLICY,
} from '@troia/backend';
import type {
  EnginePspConfig,
  PolicyConfig,
  PricingPolicy,
  ServerDeps,
  SettlementBundle,
} from '@troia/backend';
import { createPaymentProvider } from '@troia/psp';
import type { OracleProvider, RateHistoryProvider } from '@troia/oracle';
import { SimulatedRebalance } from '@troia/rebalance';
import { Ledger } from '@troia/ledger';
import { SystemClock, createSacMintClient } from '@troia/stellar-client';
import { LocalKeySigner, SorobanRpcAdapter } from '@troia/stellar-client/adapters';
import { buildStellarPort } from './build-stellar-port.js';
import type { BuildStellarPortOptions } from './build-stellar-port.js';
import { makeQuoteFn } from './quote.js';

/** Secrets injected from env at the composition root — NEVER from NetworkConfig/deployment. */
export interface TestnetSecrets {
  readonly operatorSecret: string;
  /** the USDC SAC admin (asset issuer) key — signs the rebalance mint. SEPARATE from operatorSecret so a mint
   *  never consumes an operator payout sequence. */
  readonly issuerSecret: string;
  readonly iyzicoApiKey: string;
  readonly iyzicoSecretKey: string;
  readonly webhookSigningSecret: string;
}

/** The merchant/buyer TEMPLATE for the hosted form — a KYC-stub for the settlement-bridge PoC (no real cardholder
 *  data leaves iyzico's hosted form). callbackUrl + currency are filled per-deploy, so they are omitted here. */
export type MerchantTemplate = Omit<EnginePspConfig, 'callbackUrl' | 'currency'>;

export interface TestnetServerConfig {
  readonly deployment: TestnetDeployment;
  readonly secrets: TestnetSecrets;
  /** the PUBLIC url iyzico POSTs the webhook to — must be reachable (a tunnel on testnet). */
  readonly callbackUrl: string;
  /** live spot mid + daily-close history for the quote (LiveCexOracle / YahooUsdTryHistory in prod; fakes in tests). */
  readonly spotOracle: OracleProvider;
  readonly history: RateHistoryProvider;
  readonly pricingPolicy?: PricingPolicy; // default OFFLINE_DEFAULT_PRICING_POLICY
  readonly policy?: PolicyConfig; // default OFFLINE_DEFAULT_POLICY
  readonly feeStroops?: string; // default '100'
  readonly timeboundsSecs?: number; // default 45
  /** the compressed settlement valör for the TRY-driven rebalance demo — real is ~21 days; default 30s. */
  readonly demoValorSecs?: number;
  readonly merchant?: MerchantTemplate; // override the KYC-stub buyer/addresses/basket
  readonly opts?: BuildStellarPortOptions;
}

/** The two one-time chain reads that seed the store at bootstrap. Injectable so the factory is offline-testable. */
export interface BootstrapReads {
  /** the operator account's CURRENT on-chain sequence (the allocator hands out this + 1 as the first tx seqNum). */
  operatorSeqNum(): Promise<bigint>;
  /** the pool contract's live USDC balance in stroops. */
  poolBalanceStroops(): Promise<bigint>;
}

/** A KYC-stub merchant template for the testnet PoC (the real cardholder data never leaves iyzico's hosted form). */
export const DEFAULT_TESTNET_MERCHANT: MerchantTemplate = {
  paymentGroup: 'PRODUCT',
  locale: 'tr',
  buyer: {
    id: 'buyer-stub',
    name: 'Troia',
    surname: 'Buyer',
    identityNumber: '11111111111',
    email: 'buyer@example.com', // iyzico rejects reserved/non-public TLDs (e.g. .test) — use a valid public one
    registrationAddress: 'Test Mah. Test Cad. No:1',
    city: 'Istanbul',
    country: 'Turkey',
    ip: '0.0.0.0',
  },
  shippingAddress: {
    contactName: 'Troia Buyer',
    city: 'Istanbul',
    country: 'Turkey',
    address: 'Test Mah. No:1',
  },
  billingAddress: {
    contactName: 'Troia Buyer',
    city: 'Istanbul',
    country: 'Turkey',
    address: 'Test Mah. No:1',
  },
  basketItemTemplate: {
    id: 'item-1',
    name: 'USDC settlement',
    category1: 'Settlement',
    itemType: 'VIRTUAL',
  },
};

function assertOperatorKeyMatches(operatorSecret: string, expectedPublic: string): void {
  const derived = new LocalKeySigner(operatorSecret).publicKey();
  if (derived !== expectedPublic) {
    throw new Error(
      `operator secret does not match the deployment operatorPublic (${expectedPublic}) — check .env / deployment`,
    );
  }
}

function assertIssuerKeyMatches(issuerSecret: string, expectedPublic: string): void {
  const derived = new LocalKeySigner(issuerSecret).publicKey();
  if (derived !== expectedPublic) {
    throw new Error(
      `issuer secret does not match the deployment usdc issuer (${expectedPublic}) — check .env / deployment`,
    );
  }
}

/** Build the TRY-driven rebalance bundle: a real issuer-signed USDC SAC mint provider + the live-rate reader +
 *  the decision policy + the top-up ledger. Fail-closed: the issuer key is validated before any wiring. */
function buildSettlementBundle(
  network: ReturnType<typeof testnetConfig>,
  issuerSecret: string,
  clock: SystemClock,
  spotOracle: OracleProvider,
  readPoolBalanceStroops: () => Promise<bigint>,
  demoValorSecs: number,
  feeStroops: string,
  timeboundsSecs: number,
  opts?: BuildStellarPortOptions,
): SettlementBundle {
  assertIssuerKeyMatches(issuerSecret, network.usdc.issuer); // fail-closed BEFORE any wiring
  const mintPort = createSacMintClient(
    {
      rpc: new SorobanRpcAdapter(network.rpcUrl, network.passphrase, opts),
      signer: new LocalKeySigner(issuerSecret),
      nowUnix: () => clock.nowUnix(),
    },
    {
      sacContractId: network.usdc.sacContractId,
      pool: network.contracts.troyPool,
      passphrase: network.passphrase,
      feeStroops,
      timeboundsSecs,
      finalityPollMs: 2_000,
      finalityMaxAttempts: 30, // ~60s finality budget, then fail-closed (retry next tick)
      readPoolBalanceStroops,
    },
  );
  return {
    pending: new InMemoryPendingSettlementStore(),
    policy: new TryDrivenRebalancePolicy(),
    rebalance: new SimulatedRebalance(mintPort),
    ledger: new Ledger(),
    rate: {
      async liveRateStroops(): Promise<bigint> {
        const r = await spotOracle.getRate();
        if (!r.ok) throw r.error; // oracle down -> fail-closed (the worker skips this tick, retries later)
        return r.quote.midTryPerUsdc; // scaled by RATE_SCALE (1e7) == the policy's stroops scale
      },
    },
    demoValorSecs,
  };
}

/** The DEFAULT bootstrap: read the operator seq (throwaway rpc adapter) and the pool balance (via the port). */
function defaultBootstrap(
  network: ReturnType<typeof testnetConfig>,
  poolBalance: () => Promise<bigint>,
  opts?: BuildStellarPortOptions,
): BootstrapReads {
  const rpc = new SorobanRpcAdapter(network.rpcUrl, network.passphrase, opts);
  return {
    async operatorSeqNum() {
      const r = await rpc.readAccountSeq(network.operatorPublic);
      if (!r.exists) {
        throw new Error(
          `operator account ${network.operatorPublic} not found on-chain — fund it before serving`,
        );
      }
      return BigInt(r.seq);
    },
    poolBalanceStroops: poolBalance,
  };
}

/** Build the full ServerDeps for a testnet deployment. Async: it seeds the store from two chain reads (injectable). */
export async function buildTestnetServerDeps(
  cfg: TestnetServerConfig,
  bootstrap?: BootstrapReads,
): Promise<ServerDeps> {
  const network = testnetConfig(cfg.deployment);
  assertOperatorKeyMatches(cfg.secrets.operatorSecret, network.operatorPublic); // fail-closed BEFORE any wiring

  const stellar = buildStellarPort(network, cfg.secrets.operatorSecret, cfg.opts);
  const psp = createPaymentProvider(network.psp, {
    apiKey: cfg.secrets.iyzicoApiKey,
    secretKey: cfg.secrets.iyzicoSecretKey,
    webhookSigningSecret: cfg.secrets.webhookSigningSecret,
  });
  const quote = makeQuoteFn({
    spotOracle: cfg.spotOracle,
    history: cfg.history,
    policy: cfg.pricingPolicy ?? OFFLINE_DEFAULT_PRICING_POLICY,
  });

  const reads =
    bootstrap ?? defaultBootstrap(network, () => stellar.readPoolBalanceStroops(), cfg.opts);
  const [baseSeq, balanceStroops] = await Promise.all([
    reads.operatorSeqNum(),
    reads.poolBalanceStroops(),
  ]);
  const store = new InMemoryStore({ balanceStroops, baseSeq });

  const clock = new SystemClock(); // shared: the app/worker clock AND the mint client's timebounds source
  const settlement = buildSettlementBundle(
    network,
    cfg.secrets.issuerSecret,
    clock,
    cfg.spotOracle,
    () => stellar.readPoolBalanceStroops(),
    cfg.demoValorSecs ?? 30,
    cfg.feeStroops ?? '100',
    cfg.timeboundsSecs ?? 45,
    cfg.opts,
  );

  const merchant = cfg.merchant ?? DEFAULT_TESTNET_MERCHANT;
  return {
    network,
    extras: {
      feeStroops: cfg.feeStroops ?? '100',
      timeboundsSecs: cfg.timeboundsSecs ?? 45,
      psp: { ...merchant, callbackUrl: cfg.callbackUrl, currency: 'TRY' },
      policy: cfg.policy ?? OFFLINE_DEFAULT_POLICY,
    },
    ports: { stellar, psp, store, clock },
    quote,
    webhookSigningSecret: cfg.secrets.webhookSigningSecret,
    settlement,
  };
}
