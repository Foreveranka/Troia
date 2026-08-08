// The manual-payment wizard's pure core (B-11): input validation, the per-transaction cap, the manual order
// identity, and the intent body — everything the wizard page does that is not DOM. Kept DOM-free so the whole
// decision surface is unit-testable; wizard.ts renders and relays, this file decides.
//
// The wizard exists for stores that accept USDC-on-Stellar but publish no SEP-7: the user pastes the store's
// deposit address themselves. Every input is re-validated fail-closed by the backend (PayoutIntent.build) —
// including the SEP-29 memo-required rejection, which needs a chain read only the backend can do — so the
// checks here are the fast, offline first line, not the authority.

import { deriveMemoHex } from './derive-memo';
import { isValidStellarPublicKey } from './strkey';
import { toStroops } from './amount';
import { USDC_ISSUER_ALLOWLIST } from './config';
import type { IntentBody } from './intent';

/**
 * Per-transaction ceiling for MANUAL payments (the C-14 remnant folded into the wizard): a pasted address has
 * no storefront context vouching for it, so one fat-finger or one scam link must not be able to move more
 * than this. SEP-7 flows on our own storefront are not capped here — their amount comes from the store.
 */
export const MANUAL_MAX_USDC = '500';
export const MANUAL_MAX_STROOPS = 5_000_000_000n; // 500 USDC @ 1e7

export type WizardInputError =
  | 'bad-address' // not a checksum-valid G... public key
  | 'bad-amount' // unparseable / non-positive / more than 7 decimals
  | 'over-cap'; // exceeds MANUAL_MAX_STROOPS

export type WizardInputResult =
  | { readonly ok: true; readonly destination: string; readonly amountStroops: bigint }
  | { readonly ok: false; readonly reason: WizardInputError };

/** Validate the two things the user typed. Whitespace is forgiven (addresses get pasted with it); nothing
 *  else is. Contract (C...) destinations are deliberately out of the manual flow for now — the backend would
 *  accept them, but a pasted C-address is far more likely to be a mistake than a merchant wallet. */
export function validateWizardInput(destinationRaw: string, amountRaw: string): WizardInputResult {
  const destination = destinationRaw.trim();
  if (!isValidStellarPublicKey(destination)) return { ok: false, reason: 'bad-address' };
  const amountStroops = toStroops(amountRaw.trim());
  if (amountStroops === null || amountStroops <= 0n) return { ok: false, reason: 'bad-amount' };
  if (amountStroops > MANUAL_MAX_STROOPS) return { ok: false, reason: 'over-cap' };
  return { ok: true, destination, amountStroops };
}

/** A fresh manual order id: `manual-<unix-secs base36>-<8 random base36 chars>`. Unique per attempt (a retry
 *  after a decline is a NEW order — same rule as the storefront flow), recognizably manual in every log and
 *  ledger row, and well within the backend's canonical-order-id rules. */
export function newManualOrderId(nowMs: number, randomByte: () => number): string {
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += (randomByte() % 36).toString(36);
  return `manual-${Math.floor(nowMs / 1000).toString(36)}-${suffix}`;
}

/** Assemble the POST /intent body. Identical shape to the SEP-7 path — the backend cannot tell a wizard
 *  payment from a storefront one, which is the point: one money path, one set of guards. */
export async function buildManualIntentBody(
  orderId: string,
  destination: string,
  amountStroops: bigint,
): Promise<IntentBody> {
  return {
    orderId,
    destination,
    amountStroops: amountStroops.toString(),
    assetIssuer: USDC_ISSUER_ALLOWLIST[0] as string,
    memoHex: await deriveMemoHex(orderId),
  };
}

/** User-facing copy for everything the flow can refuse, keyed on the backend's fail-closed error codes plus
 *  the wizard's own input errors. One place, so no raw code ever reaches the screen. */
export function wizardErrorCopy(code: string): string {
  switch (code) {
    case 'bad-address':
      return 'That doesn’t look like a Stellar address. It starts with G and has 56 characters.';
    case 'bad-amount':
      return 'Enter a USDC amount like 25 or 25.50 (up to 7 decimal places).';
    case 'over-cap':
      return `Manual payments are limited to ${MANUAL_MAX_USDC} USDC per transaction.`;
    // SEP-29 — the reason this wizard refuses exchange deposit addresses, stated plainly.
    case 'DestinationMemoRequired':
      return 'This address requires a deposit memo (it looks like an exchange deposit address). Troia payments can’t carry a memo, so the exchange could not credit it — this address can’t be paid. Use a personal or merchant wallet address instead.';
    case 'TrustlineMissing':
      return 'This address can’t receive USDC yet (it has no USDC trustline). Ask the recipient to add the USDC trustline, then try again.';
    case 'AddressInvalidChecksum':
      return 'That doesn’t look like a valid Stellar address — check it and try again.';
    case 'PoolInsufficient':
      return 'Troia’s payout pool can’t cover this amount right now. Try a smaller amount or try again later.';
    case 'SessionBudgetExceeded':
      return 'Too many payment attempts in a short time. Wait a few minutes and try again.';
    case 'PriceUnavailable':
      return 'The live exchange rate is unavailable right now, so no price can be quoted. Try again shortly.';
    case 'session_unavailable':
    case 'network':
      return 'Couldn’t reach the Troia server. Check your connection and try again.';
    case 'timeout':
      return 'The Troia server took too long to answer. Nothing was charged — try again.';
    default:
      return 'The payment couldn’t be started. Nothing was charged — try again.';
  }
}
