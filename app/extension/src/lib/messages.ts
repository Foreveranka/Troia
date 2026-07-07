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
