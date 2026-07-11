// The toolbar popup: a read-only status window. It asks the active tab's content script for the checkout it has
// ALREADY verified (message `troia:getState`) and renders one of two states — idle (nothing to pay here) or found
// (a fully verified checkout). It never triggers a payment: that happens on the page's "Pay with Troy card"
// banner. A tab with no content script (e.g. chrome:// pages) falls back to idle without throwing.

import type { PopupState } from '../lib/messages';

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`popup: missing #${id}`);
  return node;
}

/** GDXK…R4QT — enough to recognise the address without showing the whole thing. */
function shortAddress(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function showIdle(): void {
  el('found').hidden = true;
  el('idle').hidden = false;
  el('popup').classList.remove('found');
}

function showFound(state: PopupState): void {
  el('amt-v').textContent =
    state.amount !== undefined && state.amount.length > 0 ? state.amount : '—';
  el('amt-u').textContent = ` ${state.assetCode ?? 'USDC'}`;
  el('order-v').textContent =
    state.orderId !== undefined && state.orderId.length > 0 ? state.orderId : '—';
  el('paid-v').textContent =
    state.destination !== undefined && state.destination.length > 0
      ? shortAddress(state.destination)
      : '—';
  el('idle').hidden = true;
  el('found').hidden = false;
  el('popup').classList.add('found');
}

/** Only a fully verified checkout is shown as "found"; anything else renders as idle. */
function render(state: PopupState): void {
  if (state.found) showFound(state);
  else showIdle();
}

// A browser-action popup closes itself.
el('close').addEventListener('click', () => window.close());

// Ask the active tab's content script for its detected checkout. Reading chrome.runtime.lastError in the callback
// keeps a tab without our content script (chrome:// pages, the web store, etc.) from throwing — we just stay idle.
function requestState(): void {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId === undefined) {
        showIdle();
        return;
      }
      chrome.tabs.sendMessage(tabId, { type: 'troia:getState' }, (response?: PopupState) => {
        if (chrome.runtime.lastError || response === undefined) {
          showIdle();
          return;
        }
        render(response);
      });
    });
  } catch {
    showIdle();
  }
}

requestState();
