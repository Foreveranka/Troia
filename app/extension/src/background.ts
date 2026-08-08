// Troia extension — background service worker.
//
// The ONLY component that talks to the Troia backend: it alone holds the backend host permission, so a fetch
// from here is not subject to page CORS and stays isolated from the merchant origin. On a successful intent it
// opens iyzico's hosted card page in a new tab; it also proxies status polls. It holds no keys and signs nothing.

import { postIntent, getStatus, getReceipt, getQuote } from './lib/backend';
import { ALLOWED_ORIGINS } from './lib/config';
import type { ExtensionMessage } from './lib/messages';

export {}; // make this a module service worker

chrome.runtime.onInstalled.addListener(() => {
  console.info('[troia] background service worker installed');
});

// The hosted-form tab currently open for each storefront tab (keyed by the storefront tab's own id). When a fresh
// attempt opens a new form for a given storefront tab (a retry after a decline), we close THAT storefront tab's
// previous form first — never another tab's live form — so a single storefront checkout never has two card forms
// open at once. (tabs.remove needs no extra permission.)
const formTabByStorefront = new Map<number, number>();

/**
 * The manifest's match pattern carries no port, so `http://localhost/*` lets the content script run on ANY local
 * port — any other dev server on this machine could serve a page that looks like the storefront. The exact-origin
 * allowlist is what makes that not enough. A sender with no origin is not a content script at all.
 *
 * The extension's OWN pages (the manual-payment wizard) are also allowed: their origin is our own
 * chrome-extension:// origin AND the sender id is our own id — both checked, so neither a web page nor another
 * extension can imitate them.
 */
function isAllowedSender(sender: chrome.runtime.MessageSender): boolean {
  const origin = sender.origin ?? (sender.url === undefined ? undefined : safeOrigin(sender.url));
  if (origin === undefined) return false;
  // Own-page check: BOTH the sender id and the origin must name this very extension, and the id must actually
  // exist — comparing two undefineds must never pass.
  const ownId = chrome.runtime.id;
  if (
    typeof ownId === 'string' &&
    ownId.length > 0 &&
    sender.id === ownId &&
    origin === `chrome-extension://${ownId}`
  ) {
    return true; // our own wizard/popup pages
  }
  return (ALLOWED_ORIGINS as readonly string[]).includes(origin);
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const msg = message as Partial<ExtensionMessage> | null;

  if (!isAllowedSender(sender)) {
    // Shape the refusal like the message it answers, so the banner reports a failure rather than hanging.
    sendResponse(
      msg?.type === 'TROIA_INTENT'
        ? { ok: false, status: null, error: 'forbidden_origin' }
        : { ok: false, error: 'forbidden_origin' },
    );
    return false;
  }

  if (msg?.type === 'TROIA_INTENT' && msg.body !== undefined) {
    postIntent(msg.body).then(
      (outcome) => {
        // On success, open iyzico's hosted card page in a new tab. Opening from the background needs no user
        // gesture (a content-script window.open could be popup-blocked after the async round-trip). If the tab
        // fails to open, surface it as a failure so the banner says so and does NOT poll — no form opened means
        // the buyer never reached the card page, so nothing was charged.
        if (outcome.ok && typeof outcome.response.paymentPageUrl === 'string') {
          // Close only THIS storefront tab's own previous form (a retry after a decline), never another tab's.
          const storefrontTabId = sender.tab?.id;
          if (storefrontTabId !== undefined) {
            const stale = formTabByStorefront.get(storefrontTabId);
            if (stale !== undefined) {
              formTabByStorefront.delete(storefrontTabId);
              void chrome.tabs.remove(stale).catch(() => {}); // already closed / gone — fine
            }
          }
          chrome.tabs.create({ url: outcome.response.paymentPageUrl }).then(
            (tab) => {
              if (storefrontTabId !== undefined && tab.id !== undefined) {
                formTabByStorefront.set(storefrontTabId, tab.id);
              }
              sendResponse(outcome);
            },
            () => sendResponse({ ok: false, status: null, error: 'tab_open_failed' }),
          );
          return;
        }
        sendResponse(outcome);
      },
      () => sendResponse({ ok: false, status: null, error: 'internal' }),
    );
    return true; // keep the message channel open for the async reply
  }

  if (msg?.type === 'TROIA_STATUS' && typeof msg.orderId === 'string') {
    getStatus(msg.orderId).then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }

  if (msg?.type === 'TROIA_RECEIPT' && typeof msg.orderId === 'string') {
    getReceipt(msg.orderId).then(sendResponse, () =>
      sendResponse({ ok: false, error: 'internal' }),
    );
    return true;
  }

  // Read-only price preview — the background is the only host-permission holder, so the content script routes the
  // quote fetch through here. It reserves nothing and opens no tab; a failure just means the banner shows no ≈₺.
  if (msg?.type === 'TROIA_QUOTE' && typeof msg.amountStroops === 'string') {
    getQuote(msg.amountStroops).then(sendResponse, () =>
      sendResponse({ ok: false, error: 'internal' }),
    );
    return true;
  }

  return false; // unknown message: ignore
});
