import { describe, expect, it } from 'vitest';
import { testnetConfig, TESTNET_PASSPHRASE, type TestnetDeployment } from '../src/index.js';

const deployment: TestnetDeployment = {
  usdcIssuer: 'GISSUER',
  usdcSacContractId: 'CSAC',
  troyPool: 'CPOOL',
  operatorPublic: 'GOPERATOR',
  adminPublic: 'GADMIN',
};

describe('testnetConfig', () => {
  it('builds a testnet config from deployment addresses', () => {
    const cfg = testnetConfig(deployment);
    expect(cfg.network).toBe('testnet');
    expect(cfg.passphrase).toBe(TESTNET_PASSPHRASE);
    expect(cfg.contracts.troyPool).toBe('CPOOL');
    expect(cfg.operatorPublic).toBe('GOPERATOR');
  });

  it('pins USDC to 7 decimals (Stellar protocol)', () => {
    const cfg = testnetConfig(deployment);
    expect(cfg.usdc.decimals).toBe(7);
    expect(cfg.usdc.code).toBe('USDC');
  });

  it('uses the issuer address as the USDC issuer', () => {
    const cfg = testnetConfig(deployment);
    expect(cfg.usdc.issuer).toBe('GISSUER');
    expect(cfg.issuerPublic).toBe('GISSUER');
  });
});
