// NetworkConfig — the single authority for network-specific, NON-SECRET values.
// Secrets (keys, API credentials) are NEVER here; they come from env. Any network-specific
// literal outside this package is a bug (guarded by a test).

export interface UsdcConfig {
  readonly code: 'USDC';
  /** Issuer public G-address (on testnet this is our own self-mint issuer). */
  readonly issuer: string;
  /** Stellar Asset Contract id (C-address) exposing USDC to Soroban. */
  readonly sacContractId: string;
  /** Stellar classic assets use 7 decimals at the protocol level. */
  readonly decimals: 7;
}

export interface ContractsConfig {
  /** TroyPool contract C-address (holds USDC custody). */
  readonly troyPool: string;
}

export interface PspConfig {
  /** iyzico API base url. */
  readonly baseUrl: string;
}

export interface NetworkConfig {
  readonly network: 'testnet' | 'mainnet';
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly horizonUrl: string;
  readonly usdc: UsdcConfig;
  readonly contracts: ContractsConfig;
  /** operator public G-address (signs + submits every pay() tx). */
  readonly operatorPublic: string;
  /** admin public G-address (upgrade/pause/set_*). */
  readonly adminPublic: string;
  /** issuer public G-address (USDC SAC mint authority; disappears on mainnet). */
  readonly issuerPublic: string;
  readonly psp: PspConfig;
}

// --- Non-secret network constants ---

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const IYZICO_SANDBOX_BASE_URL = 'https://sandbox-api.iyzipay.com';

/**
 * Deploy-specific addresses produced by `just fund` (Phase 4.4). These are not known until the
 * contract and SAC are deployed, so they are injected rather than hard-coded.
 */
export interface TestnetDeployment {
  readonly usdcIssuer: string;
  readonly usdcSacContractId: string;
  readonly troyPool: string;
  readonly operatorPublic: string;
  readonly adminPublic: string;
}

/** Build the testnet NetworkConfig from a concrete deployment's addresses. */
export function testnetConfig(deployment: TestnetDeployment): NetworkConfig {
  return {
    network: 'testnet',
    passphrase: TESTNET_PASSPHRASE,
    rpcUrl: TESTNET_RPC_URL,
    horizonUrl: TESTNET_HORIZON_URL,
    usdc: {
      code: 'USDC',
      issuer: deployment.usdcIssuer,
      sacContractId: deployment.usdcSacContractId,
      decimals: 7,
    },
    contracts: {
      troyPool: deployment.troyPool,
    },
    operatorPublic: deployment.operatorPublic,
    adminPublic: deployment.adminPublic,
    issuerPublic: deployment.usdcIssuer,
    psp: {
      baseUrl: IYZICO_SANDBOX_BASE_URL,
    },
  };
}
