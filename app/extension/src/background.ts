// Troia extension — background service worker.
//
// The ONLY component that talks to the Troia backend: it alone holds the backend host permission, so a fetch
// from here is not subject to page CORS and stays isolated from the merchant origin. On a successful intent it
// opens iyzico's hosted card page in a new tab; it also proxies status polls. It holds no keys and signs nothing.

import { postIntent, getStatus, getReceipt } from './lib/backend';
import type { ExtensionMessage } from './lib/messages';

export {}; // make this a module service worker

chrome.runtime.onInstalled.addListener(() => {
  console.info('[troia] background service worker installed');
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as Partial<ExtensionMessage> | null;

  if (msg?.type === 'TROIA_INTENT' && msg.body !== undefined) {
    postIntent(msg.body).then((outcome) => {
      // On success, open iyzico's hosted card page in a new tab. Opening from the background needs no user
      // gesture (a content-script window.open could be popup-blocked after the async round-trip).
      if (outcome.ok && typeof outcome.response.paymentPageUrl === 'string') {
        void chrome.tabs.create({ url: outcome.response.paymentPageUrl });
      }
      sendResponse(outcome);
    }, () => sendResponse({ ok: false, status: null, error: 'internal' }));
    return true; // keep the message channel open for the async reply
  }

  if (msg?.type === 'TROIA_STATUS' && typeof msg.orderId === 'string') {
    getStatus(msg.orderId).then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }

  if (msg?.type === 'TROIA_RECEIPT' && typeof msg.orderId === 'string') {
    getReceipt(msg.orderId).then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }

  return false; // unknown message: ignore
});
