// The message protocol between the content script and the background service worker. The content script owns
// no network access; it asks the background to perform POST /intent and GET /status, and the background replies
// with typed outcomes.

import type { IntentBody } from './intent';
import type { IntentOutcome, StatusOutcome, ReceiptOutcome } from './backend';

export interface IntentRequestMessage {
  readonly type: 'TROIA_INTENT';
  readonly body: IntentBody;
}

export interface StatusRequestMessage {
  readonly type: 'TROIA_STATUS';
  readonly orderId: string;
}

export interface ReceiptRequestMessage {
  readonly type: 'TROIA_RECEIPT';
  readonly orderId: string;
}

export type ExtensionMessage = IntentRequestMessage | StatusRequestMessage | ReceiptRequestMessage;

export type { IntentOutcome, StatusOutcome, ReceiptOutcome };

// A separate, read-only channel: the popup → the content script. The popup asks for the checkout the content
// script has ALREADY detected on this tab; the content script replies from state it holds and does nothing else.
// It never triggers a payment — that stays on the page's banner.
export interface GetStateMessage {
  readonly type: 'troia:getState';
}

/** The content script's reply. `found` is true ONLY for a fully verified (payable) checkout; anything else
 *  (still verifying, rejected, none) is `{ found: false }`, which the popup renders as idle. */
export interface PopupState {
  readonly found: boolean;
  readonly amount?: string;
  readonly assetCode?: string;
  readonly destination?: string;
  readonly orderId?: string;
}
