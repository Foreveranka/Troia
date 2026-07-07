// Troia extension — content script.
//
// Runs in the storefront page (allowlisted origins only, per the manifest). It ONLY reads the DOM. When it
// finds a SEP-7 (`web+stellar:pay`) USDC-on-Stellar request that passes every required check, it offers a
// fail-closed "Pay with Troy card" banner; otherwise it shows nothing. It never holds keys and never signs.
//
// The storefront reaches the pay step via in-page React state (no navigation), so the script observes DOM
// mutations and rescans, rather than running once at load.
//
// Clicking the banner builds the intent body from the on-page SEP-7 and hands it to the background worker,
// which performs POST /intent and opens iyzico's hosted card page in a new tab. The content script then polls
// GET /status (via the background) and reflects the coarse status on the banner until a terminal state.

import { findSep7Uri, evaluate, type Detection } from './lib/adapter';
import { showBanner, type BannerHandle } from './lib/banner';
import { buildIntentBody, intentUiAction, statusCopy } from './lib/intent';
import type { IntentOutcome, StatusOutcome, ReceiptOutcome } from './lib/backend';

console.info('[troia] content script active on', location.origin);

const NOT_CHARGED = ' — you were not charged.';
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 200; // ~10 minutes at 3s, then give up polling

let currentUri: string | null = null;
let handle: BannerHandle | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function clearBanner(): void {
  stopPolling();
  handle?.remove();
  handle = null;
}

function startPolling(orderId: string, h: BannerHandle, amount: string): void {
  stopPolling();
  let polls = 0;
  pollTimer = setInterval(() => {
    if (h !== handle) {
      stopPolling(); // the banner was dismissed or replaced
      return;
    }
    polls += 1;
    if (polls > MAX_POLLS) {
      stopPolling();
      return;
    }
    chrome.runtime.sendMessage({ type: 'TROIA_STATUS', orderId }, (res: StatusOutcome | undefined) => {
      if (chrome.runtime.lastError || res === undefined || !res.ok) return; // transient — keep polling
      const { text, kind, terminal } = statusCopy(res.status);
      h.setStatus(text, kind);
      if (res.status === 'completed') {
        // fetch the settlement proof (on-chain tx hash + the TRY charged), then tell the storefront to place
        // the order — so the confirmation + order details can show a "verify the tx yourself" link.
        chrome.runtime.sendMessage({ type: 'TROIA_RECEIPT', orderId }, (receipt: ReceiptOutcome | undefined) => {
          const txHash = receipt !== undefined && receipt.ok ? receipt.txHash : null;
          const paidPriceTry = receipt !== undefined && receipt.ok ? receipt.paidPriceTry : null;
          window.postMessage({ source: 'troia-extension', type: 'TROIA_PAID', orderId, amount, txHash, paidPriceTry }, location.origin);
        });
      }
      if (terminal) stopPolling();
    });
  }, POLL_INTERVAL_MS);
}

function pay(detection: Detection): void {
  const h = handle;
  if (h === null) return;
  h.setBusy(true);
  void buildIntentBody(detection).then((built) => {
    if (!built.ok) {
      h.setBusy(false);
      h.setStatus(`Couldn't start the payment${NOT_CHARGED}`, 'error');
      return;
    }
    chrome.runtime.sendMessage({ type: 'TROIA_INTENT', body: built.body }, (outcome: IntentOutcome | undefined) => {
      h.setBusy(false);
      if (chrome.runtime.lastError || outcome === undefined) {
        h.setStatus(`Couldn't reach the payment service${NOT_CHARGED}`, 'error');
        return;
      }
      if (outcome.ok) {
        // Only claim the card form is opening when the background actually opened one (paymentPageUrl present).
        const action = intentUiAction(outcome.response);
        h.setStatus(action.text, action.kind === 'error' ? 'error' : 'info');
        if (action.poll) startPolling(outcome.response.orderId, h, detection.sep7.amount);
        console.info('[troia] intent outcome', { orderId: outcome.response.orderId, action: action.kind });
      } else {
        h.setStatus(`Couldn't start the payment${NOT_CHARGED}`, 'error');
        console.info('[troia] intent rejected', { status: outcome.status, error: outcome.error });
      }
    });
  });
}

function scan(): void {
  const uri = findSep7Uri();
  if (uri === currentUri) return; // nothing changed since the last scan
  currentUri = uri;

  if (uri === null) {
    clearBanner();
    return;
  }

  const detection = evaluate(uri);
  if (detection === null || !detection.payable) {
    // Fail-closed: an unrecognized or unverifiable request never gets a banner.
    clearBanner();
    if (detection !== null) {
      console.info('[troia] SEP-7 found but not payable', detection.checks.filter((c) => !c.pass).map((c) => c.id));
    }
    return;
  }

  console.info('[troia] payable USDC-on-Stellar request detected', { confidence: detection.confidence });
  clearBanner();
  handle = showBanner({
    amount: detection.sep7.amount,
    assetCode: detection.sep7.assetCode ?? 'USDC',
    onPay: () => pay(detection),
    onClose: () => {
      stopPolling();
      handle = null;
    },
  });
}

// Debounce a burst of mutations into a single scan per animation frame.
let scheduled = false;
const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    scan();
  });
});
observer.observe(document.documentElement, { childList: true, subtree: true });

scan(); // initial pass
