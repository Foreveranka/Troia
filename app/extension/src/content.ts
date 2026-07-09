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
// Poll budgets are phase-aware: while the buyer is still on iyzico's hosted card form the order sits at
// 'pending', so that phase gets a generous window; once payment is received ('processing') a fresh, tighter
// window covers the on-chain settlement confirm. Giving up is never silent and never falsely claims "not
// charged" (once payment is received, the charge may already have gone through).
const PENDING_MAX_POLLS = 400; // ~20 min at 3s — awaiting the card payment
const CONFIRM_MAX_POLLS = 80; // ~4 min at 3s — after payment received, awaiting settlement confirmation

let currentUri: string | null = null;
let handle: BannerHandle | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false; // a payment intent is being started / is in progress — blocks repeat clicks

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
      // never paid, so it is safe to say no charge was made.
      h.setStatus(
        sawProcessing
          ? 'Payment received — settlement is taking a little longer and will complete shortly. You can safely close this.'
          : `Payment session timed out${NOT_CHARGED} Refresh to try again.`,
        sawProcessing ? 'info' : 'error',
      );
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
        h.setStatus(text, kind);
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
  clearBanner();
  handle = showBanner({
    amount: detection.sep7.amount,
    assetCode: detection.sep7.assetCode ?? 'USDC',
    onPay: () => pay(detection),
    onClose: () => {
      stopPolling();
      inFlight = false;
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
