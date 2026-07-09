// Convert a decimal USDC amount (as it appears in a SEP-7 `amount`, e.g. "62.00") to i128 stroops. USDC on
// Stellar has 7 decimals, so 1 USDC = 10_000_000 stroops. Uses only string + BigInt math — never Number — so a
// money value never picks up a float rounding error. Fail-closed: anything that is not a clean, positive
// decimal with at most 7 fractional digits returns null (the caller then refuses to build an intent).

const USDC_DECIMALS = 7;

export function toStroops(amount: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(amount)) return null; // non-negative decimal only; rejects "", "-5", "1e3", "abc"
  const [intPart, fracPart = ''] = amount.split('.');
  if (fracPart.length > USDC_DECIMALS) return null; // more precision than USDC can represent
  const fracPadded = fracPart.padEnd(USDC_DECIMALS, '0');
  const stroops =
    BigInt(intPart) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded === '' ? '0' : fracPadded);
  return stroops > 0n ? stroops : null; // amount must be strictly positive
}
