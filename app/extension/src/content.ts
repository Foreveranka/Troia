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
import type { PopupState } from './lib/messages';

console.info('[troia] content script active on', location.origin);

const NOT_CHARGED = ' — you were not charged.';
const POLL_INTERVAL_MS = 3000;
// Poll budgets are phase-aware: while the buyer is still on iyzico's hosted card form the order sits at
// 'pending', so that phase gets a generous window; once payment is received ('processing') a fresh, tighter
// window covers the on-chain settlement confirm. Giving up is never silent and never falsely claims "not
// charged" (once payment is received, the charge may already have gone through).
const PENDING_MAX_POLLS = 400; // ~20 min at 3s — awaiting the card payment
const CONFIRM_MAX_POLLS = 80; // ~4 min at 3s — after payment received, awaiting settlement confirmation

const RETRY_TIMEOUT_MS = 6000; // how long we wait for the storefront to mint a fresh order before giving up

let currentUri: string | null = null;
let handle: BannerHandle | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false; // a payment intent is being started / is in progress — blocks repeat clicks
// A retry is in flight: the shopper clicked "Try again", we asked the storefront for a FRESH order id, and we are
// waiting for its new SEP-7 to appear so we can pay it automatically. Consumed by scan() on the next detection.
let pendingRetry = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null; // the safety-net timer for the wait above

/** End the retry wait: drop the flag and cancel the safety-net timer so a stale one can never fire later. */
function clearPendingRetry(): void {
  pendingRetry = false;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}
// The last fully-verified (payable) detection, mirrored for the read-only popup. It tracks the banner exactly:
// set when the banner is shown, cleared when it is not. The popup reads this and never re-parses the page.
let lastDetection: Detection | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function clearBanner(): void {
  stopPolling();
  inFlight = false;
  handle?.remove();
  handle = null;
}

function startPolling(orderId: string, h: BannerHandle, amount: string): void {
  stopPolling();
  let polls = 0;
  let sawProcessing = false;
  pollTimer = setInterval(() => {
    if (h !== handle) {
      stopPolling(); // the banner was dismissed or replaced
      return;
    }
    polls += 1;
    const cap = sawProcessing ? CONFIRM_MAX_POLLS : PENDING_MAX_POLLS;
    if (polls > cap) {
      // Give up — but never silently, and never with a false "not charged". If payment was already received
      // (processing seen) the charge may have gone through, so say settlement is just slow; otherwise the buyer
      // never paid, so it is safe to say no charge was made. Either way do NOT auto-retry: this order is still
      // live on the backend and its card form may still be open, so minting a second order could double-charge.
      h.setStatus(
        sawProcessing
          ? 'Payment received — settlement is taking a little longer and will complete shortly. You can safely close this.'
          : `Payment session timed out${NOT_CHARGED} Refresh to try again.`,
        sawProcessing ? 'info' : 'error',
      );
      h.hidePay();
      stopPolling();
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'TROIA_STATUS', orderId },
      (res: StatusOutcome | undefined) => {
        if (chrome.runtime.lastError || res === undefined || !res.ok) return; // transient — keep polling
        if (res.status === 'processing' && !sawProcessing) {
          // payment received — reset the budget so the settlement-confirm window is fresh, not consumed by the
          // time the buyer spent on the card form.
          sawProcessing = true;
          polls = 0;
        }
        const { text, kind, terminal } = statusCopy(res.status);
        if (res.status === 'failed' && !sawProcessing) {
          // A clean pre-payment decline: the card was never charged (we never saw 'processing') and the order is
          // finished on the backend with its reservation released — so a fresh attempt is safe.
          h.setStatus(text, kind);
          h.setRetry();
        } else if (res.status === 'failed') {
          // We DID see 'processing' first: the card was charged, and this 'failed' is a settlement reversal in
          // flight (public 'failed' also covers ChargeReversing/ChargeReversed). Retrying would charge the same
          // cart a second time, so offer no retry — the shopper must start a new order.
          h.setStatus(
            'Payment could not be completed — if your card was charged it will be reversed. Start a new order to try again.',
            'error',
          );
          h.hidePay();
        } else {
          h.setStatus(text, kind);
          if (terminal) h.hidePay(); // 'completed' / 'review' — the banner is informational from here, no retry
        }
        if (res.status === 'completed') {
          // fetch the settlement proof (on-chain tx hash + the TRY charged), then tell the storefront to place
          // the order — so the confirmation + order details can show a "verify the tx yourself" link.
          chrome.runtime.sendMessage(
            { type: 'TROIA_RECEIPT', orderId },
            (receipt: ReceiptOutcome | undefined) => {
              const txHash = receipt !== undefined && receipt.ok ? receipt.txHash : null;
              const paidPriceTry =
                receipt !== undefined && receipt.ok ? receipt.paidPriceTry : null;
              window.postMessage(
                {
                  source: 'troia-extension',
                  type: 'TROIA_PAID',
                  orderId,
                  amount,
                  txHash,
                  paidPriceTry,
                },
                location.origin,
              );
            },
          );
        }
        if (terminal) stopPolling();
      },
    );
  }, POLL_INTERVAL_MS);
}

function pay(detection: Detection): void {
  const h = handle;
  if (h === null || inFlight) return; // ignore repeat clicks: a payment is already being started / in progress
  inFlight = true;
  h.setBusy(true);
  // Re-enable the banner for a retry ONLY on a clean failure (nothing charged). On success we keep it disabled
  // and hand off to polling, so a second click can never fire a second intent.
  const fail = (text: string): void => {
    inFlight = false;
    h.setBusy(false);
    h.setStatus(text, 'error');
  };
  void buildIntentBody(detection).then((built) => {
    if (!built.ok) {
      fail(`Couldn't start the payment${NOT_CHARGED}`);
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'TROIA_INTENT', body: built.body },
      (outcome: IntentOutcome | undefined) => {
        if (chrome.runtime.lastError || outcome === undefined) {
          fail(`Couldn't reach the payment service${NOT_CHARGED}`);
          return;
        }
        if (!outcome.ok) {
          // A failed tab-open (the background could not open the card page) means the buyer never reached it, so
          // nothing was charged — say that specifically; otherwise the generic start failure.
          fail(
            outcome.error === 'tab_open_failed'
              ? `Couldn't open the card form${NOT_CHARGED}`
              : `Couldn't start the payment${NOT_CHARGED}`,
          );
          console.info('[troia] intent rejected', { status: outcome.status, error: outcome.error });
          return;
        }
        // Success. Only claim the card form is opening when the background actually opened one (paymentPageUrl
        // present, i.e. action.poll). Keep the button disabled and reflect the coarse status via polling.
        const action = intentUiAction(outcome.response);
        h.setStatus(action.text, action.kind === 'error' ? 'error' : 'info');
        if (action.poll) {
          startPolling(outcome.response.orderId, h, detection.sep7.amount);
        } else {
          // no polling path (success but no form to open) — re-enable so the buyer can retry
          inFlight = false;
          h.setBusy(false);
        }
        console.info('[troia] intent outcome', {
          orderId: outcome.response.orderId,
          action: action.kind,
        });
      },
    );
  });
}

// "Try again": the failed order is spent (the backend treats it as done), so a real retry needs a FRESH order id.
// Only the storefront can mint one (it owns the SEP-7 memo), so we ask it to, and pay the new order automatically
// when its request appears (scan() below). Nothing money-moving happens here — no charge, no new intent yet.
function requestRetry(orderId: string): void {
  const h = handle;
  if (h === null || pendingRetry) return;
  pendingRetry = true;
  h.setBusy(true); // "Processing…" while the storefront mints a fresh order
  h.setStatus('Starting a new attempt…', 'info');
  window.postMessage({ source: 'troia-extension', type: 'TROIA_RETRY', orderId }, location.origin);
  // Safety net: if no fresh order ever appears, don't leave the button stuck — re-offer the retry. The handle is
  // stored so a completed retry cancels it (clearPendingRetry), and a re-request cancels a prior one.
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!pendingRetry) return; // the retry already completed (a fresh banner replaced this one)
    pendingRetry = false;
    handle?.setStatus(`Couldn't start a new attempt${NOT_CHARGED} Refresh to try again.`, 'error');
    handle?.setRetry();
  }, RETRY_TIMEOUT_MS);
}

function scan(): void {
  const uri = findSep7Uri();
  if (uri === currentUri) return; // nothing changed since the last scan
  currentUri = uri;

  if (uri === null) {
    lastDetection = null;
    clearPendingRetry();
    clearBanner();
    return;
  }

  const detection = evaluate(uri);
  if (detection === null || !detection.payable) {
    // Fail-closed: an unrecognized or unverifiable request never gets a banner (nor a popup "found" state).
    lastDetection = null;
    clearPendingRetry();
    clearBanner();
    if (detection !== null) {
      console.info(
        '[troia] SEP-7 found but not payable',
        detection.checks.filter((c) => !c.pass).map((c) => c.id),
      );
    }
    return;
  }

  console.info('[troia] payable USDC-on-Stellar request detected', {
    confidence: detection.confidence,
  });
  lastDetection = detection;
  clearBanner();
  handle = showBanner({
    amount: detection.sep7.amount,
    assetCode: detection.sep7.assetCode ?? 'USDC',
    onPay: () => pay(detection),
    onRetry: () => requestRetry(detection.sep7.memo ?? ''),
    onClose: () => {
      stopPolling();
      inFlight = false;
      clearPendingRetry();
      handle = null;
    },
  });

  // If this fresh SEP-7 is the fresh order we requested for a retry, continue the payment automatically —
  // one click on "Try again" then leads straight into the new card form.
  if (pendingRetry) {
    clearPendingRetry();
    pay(detection);
  }
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
// childList catches a SEP-7 anchor being added/removed; attributeFilter:['href'] catches its href being updated
// in place (e.g. the storefront minting a fresh order id for a retry) — a change the childList observer misses.
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['href'],
});

scan(); // initial pass

// Read-only channel for the toolbar popup: reply with the checkout we have already verified on this tab (or
// `found: false`). It reads `lastDetection` and does nothing else — no re-parse, no payment. Registered only when
// the extension messaging API is present, so the unit tests (which import this module without a chrome stub in
// the initial-scan cases) are untouched.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((message as { type?: string } | null)?.type !== 'troia:getState') return;
    const d = lastDetection;
    const reply: PopupState =
      d !== null && d.payable
        ? {
            found: true,
            amount: d.sep7.amount,
            assetCode: d.sep7.assetCode ?? 'USDC',
            destination: d.sep7.destination,
            orderId: d.sep7.memo ?? '',
          }
        : { found: false };
    sendResponse(reply);
  });
}
