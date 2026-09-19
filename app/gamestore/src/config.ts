// NOVAKEYS payment config. A digital-goods store: no address, no shipping, keys are delivered instantly.
// It receives USDC natively on Stellar at its own payout address and declares that address in the SEP-7
// request it renders, exactly like the streetwear storefront does. Troia keeps no merchant list.

import { USDC_ISSUER } from './deployment.generated';

export const STORE = {
  name: 'NOVAKEYS',
  /** This shop's own payee. A different account from the other demo store, on purpose. */
  merchant: 'GBR2LOLTXI7QZFQ6FX2H2KC7YBUXUCKPTPTKH2MJRRNZRSKOSJ7JE4N4',
  usdcCode: 'USDC',
  usdcIssuer: USDC_ISSUER,
} as const;

/** Order reference, also used as the SEP-7 memo. NK- prefix so the two demo stores never collide. */
export function orderRef(): string {
  return (
    'NK-' +
    Math.random().toString(36).slice(2, 8).toUpperCase() +
    Math.random().toString(36).slice(2, 4).toUpperCase()
  );
}

/** Build a SEP-7 (`web+stellar:pay`) request. USDC by default; pass 'native' for XLM. */
export function buildSep7(
  amount: string,
  memo: string,
  asset: 'native' | { code: string; issuer: string } = {
    code: STORE.usdcCode,
    issuer: STORE.usdcIssuer,
  },
): string {
  const params = new URLSearchParams({
    destination: STORE.merchant,
    amount,
    memo,
    memo_type: 'text',
  });
  if (asset !== 'native') {
    params.set('asset_code', asset.code);
    params.set('asset_issuer', asset.issuer);
  }
  return `web+stellar:pay?${params.toString()}`;
}

export function shortAddr(a: string): string {
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

/** A plausible-looking product key, generated client side. Demo only: nothing is redeemable. */
export function gameKey(): string {
  const block = (): string => Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');
  return `NOVA-${block()}-${block()}-${block()}`;
}
