import type { ServerDeps } from '@troia/backend';
import type { OracleProvider, RateHistoryProvider } from '@troia/oracle';
import { intEnv, requireEnv } from './env.js';
import { HttpBankTransferProvider } from './bank-transfer-provider.js';
import { makeQuoteFn } from './quote.js';
import type { NetworkConfig } from '@troia/config';
import { TrMockAnchorProvider } from './tr-mock-anchor-provider.js';
import { join } from 'node:path';

export function buildBankTransferConfig(
  env: Record<string, string | undefined>,
  spotOracle: OracleProvider,
  history: RateHistoryProvider,
  sandbox?: { network: NetworkConfig; dataDir: string },
): ServerDeps['bankTransfer'] {
  const mode = env.BANK_TRANSFER_MODE?.trim() || 'disabled';
  if (mode === 'disabled') return undefined;
  if (mode === 'tr-mock-anchor') {
    if (sandbox === undefined)
      throw new Error('Sandbox network and durable directory are required');
    const provider = new TrMockAnchorProvider({
      network: sandbox.network,
      secret: requireEnv(env, 'BANK_TRANSFER_ANCHOR_SECRET'),
      journalPath: join(sandbox.dataDir, 'anchor-transfers.db'),
    });
    return { provider, quote: (amount) => provider.quote(amount) };
  }
  if (mode !== 'bridge') throw new Error('Invalid BANK_TRANSFER_MODE');
  // Enabling requires explicit provider costs/settlement terms. Never inherit iyzico card costs.
  for (const name of [
    'BANK_TRANSFER_FEE_BPS',
    'BANK_TRANSFER_FIXED_KURUS',
    'BANK_TRANSFER_VALOR_DAYS',
    'BANK_TRANSFER_MARGIN_BPS',
  ])
    requireEnv(env, name);
  const provider = new HttpBankTransferProvider({
    baseUrl: requireEnv(env, 'BANK_TRANSFER_API_BASE_URL'),
    apiKey: requireEnv(env, 'BANK_TRANSFER_API_KEY'),
    providerId: requireEnv(env, 'BANK_TRANSFER_PROVIDER_ID'),
  });
  const quote = makeQuoteFn({
    spotOracle,
    history,
    policy: {
      commission: {
        valorDays: intEnv(env, 'BANK_TRANSFER_VALOR_DAYS', 1, 1, 365),
        z: 1.65,
        marginBps: intEnv(env, 'BANK_TRANSFER_MARGIN_BPS', 0, 0, 10_000),
      },
      psp: {
        rateBps: intEnv(env, 'BANK_TRANSFER_FEE_BPS', 0, 0, 9999),
        fixedKurus: BigInt(intEnv(env, 'BANK_TRANSFER_FIXED_KURUS', 0, 0, 1_000_000_000)),
      },
    },
  });
  return { provider, quote };
}
