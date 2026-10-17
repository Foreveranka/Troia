import type { BankTransferInstructions } from './bank-transfer';

export function newDemoBankTransfer(
  amountStroops = 0n,
  orderId = `demo-${crypto.randomUUID()}`,
): BankTransferInstructions {
  const code = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  // Intentionally invalid check digits and zero bank code: never a real receiving account.
  return {
    providerId: 'troia-ui-demo',
    transferId: orderId,
    orderId,
    reference: `TEST-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`,
    iban: 'TR000000000000000000000000',
    beneficiary: 'Troia Test Hesabı',
    amountTry: demoTryAmount(amountStroops),
    currency: 'TRY',
    expiresAtUnix: Math.floor(Date.now() / 1000) + 900,
  };
}

/** Illustrative UI rate only: 1 test USDC = 45 test TRY. Never sent to a backend/pricing port. */
export function demoTryAmount(amountStroops: bigint): string {
  const kurus = (amountStroops * 4500n + 9_999_999n) / 10_000_000n;
  return `${kurus / 100n}.${String(kurus % 100n).padStart(2, '0')}`;
}
