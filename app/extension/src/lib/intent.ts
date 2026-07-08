// Build the POST /intent request body from a payable detection. The body carries only the "what to pay"
// fields the backend needs; the buyer IP is attached by the background worker at fetch time (see the backend
// integration note). Everything here is derived deterministically from the on-page SEP-7 — the backend still
// re-validates every field fail-closed (PayoutIntent.build), so this is a well-formed request, not a trust.

import type { Detection } from './adapter';
import { deriveMemoHex } from './derive-memo';
import { toStroops } from './amount';

export interface IntentBody {
  readonly orderId: string;
  readonly destination: string;
  readonly amountStroops: string;
  readonly assetIssuer: string;
  readonly memoHex: string;
}

export type BuildIntentResult =
  | { readonly ok: true; readonly body: IntentBody }
  | { readonly ok: false; readonly reason: 'not-payable' | 'no-order-ref' | 'bad-order-ref' | 'no-issuer' | 'bad-amount' };

/** The coarse public status the backend exposes on GET /status/:orderId (never the internal crypto state). */
export type PublicStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'review';

/** The successful POST /intent response. The extension opens paymentPageUrl (iyzico's hosted card page) in a
 *  new tab and then polls GET /status. */
export interface IntentResponse {
  readonly orderId: string;
  readonly token: string;
  readonly paymentPageUrl?: string;
  readonly checkoutFormContent?: string;
  readonly paidPriceTry: string;
  readonly spreadBps?: number;
  readonly poolLow?: boolean;
  readonly alreadyStarted?: boolean;
}

/** How the banner should react to a successful /intent. The background opens a hosted-form tab ONLY when the
 *  response carries paymentPageUrl, so the content script must not claim "opening the form" when it is absent
 *  (e.g. an alreadyStarted duplicate returns a token but no URL). */
export type IntentUiAction = {
  readonly kind: 'open' | 'already' | 'error';
  readonly text: string;
  readonly poll: boolean;
};

export function intentUiAction(response: IntentResponse): IntentUiAction {
  if (typeof response.paymentPageUrl === 'string' && response.paymentPageUrl.length > 0) {
    // the background opened iyzico's hosted card page in a new tab
    return { kind: 'open', text: 'Opening the secure card form…', poll: true };
  }
  if (response.alreadyStarted === true) {
    // a duplicate intent for an order already in progress — no new form opens; the first tab holds it
    return { kind: 'already', text: 'This order is already in progress — continue in your card form tab.', poll: true };
  }
  // success but no hosted page to open — never claim a form is opening
  return { kind: 'error', text: "Couldn't open the card form — you were not charged.", poll: false };
}

/** User-facing copy for a coarse public status, plus whether polling should stop (terminal state). */
export function statusCopy(status: PublicStatus): { text: string; kind: 'info' | 'error'; terminal: boolean } {
  switch (status) {
    case 'pending':
      return { text: 'Waiting for your card payment…', kind: 'info', terminal: false };
    case 'processing':
      return { text: 'Payment received — confirming…', kind: 'info', terminal: false };
    case 'completed':
      return { text: 'Payment complete.', kind: 'info', terminal: true };
    case 'failed':
      return { text: 'Payment was not completed.', kind: 'error', terminal: true };
    case 'review':
      return { text: 'Payment is under review.', kind: 'info', terminal: true };
  }
}

export async function buildIntentBody(detection: Detection): Promise<BuildIntentResult> {
  if (!detection.payable) return { ok: false, reason: 'not-payable' };
  const { sep7 } = detection;

  // The storefront's order reference (the SEP-7 memo) is the orderId; the on-chain settlement memo is derived
  // from it, so the extension sends both and the backend's memoHex == deriveMemo(orderId) check passes.
  const orderId = sep7.memo;
  if (orderId === null || orderId.length === 0) return { ok: false, reason: 'no-order-ref' };
  if (sep7.assetIssuer === null) return { ok: false, reason: 'no-issuer' };

  const stroops = toStroops(sep7.amount);
  if (stroops === null) return { ok: false, reason: 'bad-amount' };

  // Reject a malformed order_id (lone surrogate) up front, exactly as the backend's canonicalizeOrderId does,
  // so we fail closed instead of sending a memo the backend would never accept.
  let memoHex: string;
  try {
    memoHex = await deriveMemoHex(orderId);
  } catch {
    return { ok: false, reason: 'bad-order-ref' };
  }
  return {
    ok: true,
    body: {
      orderId,
      destination: sep7.destination,
      amountStroops: stroops.toString(),
      assetIssuer: sep7.assetIssuer,
      memoHex,
    },
  };
}
