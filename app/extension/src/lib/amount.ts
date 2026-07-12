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

// Format a canonical "N.MM" TRY string (the backend's paidPriceTry from GET /quote) into an INDICATIVE display
// string, e.g. "2650.00" -> "≈ 2,650.00 TL". Pure string work — groups the integer part with thousands separators
// and keeps the fractional part verbatim; never parses to Number, so no float drift. Best-effort: if the input is
// not the expected shape it is passed through un-grouped rather than throwing. It is a PREVIEW label, never a
// promise — the charged price is locked server-side at /intent.
export function formatApproxTry(paidPriceTry: string): string {
  const [intPart = '', fracPart] = paidPriceTry.split('.');
  const grouped = /^\d+$/.test(intPart) ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
  const body = fracPart !== undefined ? `${grouped}.${fracPart}` : grouped;
  return `≈ ${body} TL`;
}
