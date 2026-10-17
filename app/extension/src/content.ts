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
import { formatApproxTry, toStroops } from './lib/amount';
import type { IntentOutcome, StatusOutcome, ReceiptOutcome } from './lib/backend';
import type { PopupState, QuoteOutcome } from './lib/messages';
import { bankErrorCopy } from './lib/bank-transfer';
import { BANK_TRANSFER_DEMO } from './lib/config';
import { newDemoBankTransfer } from './lib/bank-transfer-demo';
import type { BankTransferInstructions } from './lib/bank-transfer';

console.info('[troia] content script active on', location.origin);

const NOT_CHARGED = ', kartınızdan tahsilat yapılmadı.';
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
let lastPaymentMethod: 'card' | 'bank_transfer' = 'card';
let demoBank: BankTransferInstructions | null = null;
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
// The indicative ≈₺ display string for the current detection, once the read-only /quote reply lands. Mirrors the
// banner: reset to null on every detection change so a stale order's TL never shows against a new amount.
let lastQuote: string | null = null;
let quoteRequestId = 0;

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

function startPolling(
  orderId: string,
  h: BannerHandle,
  amount: string,
  method: 'card' | 'bank_transfer',
): void {
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
          ? 'Ödeme alındı. Transfer biraz daha uzun sürüyor ve kısa süre içinde tamamlanacak. Bu pencereyi güvenle kapatabilirsiniz.'
          : 'Ödeme durumu doğrulanamadı. Açık ödeme sekmesini kontrol edin; aynı ödemeyi yeniden başlatmayın.',
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
        const copy = statusCopy(res.status);
        const { kind, terminal } = copy;
        const text =
          method === 'bank_transfer' && res.status === 'pending'
            ? 'Banka tahsilatı bekleniyor…'
            : copy.text;
        if (res.status === 'failed' && !sawProcessing) {
          // A clean pre-payment decline: the card was never charged (we never saw 'processing') and the order is
          // finished on the backend with its reservation released — so a fresh attempt is safe.
          h.setStatus(text, kind);
          h.setRetry();
        } else if (res.status === 'failed') {
          // Defense-in-depth, currently UNREACHABLE under the backend contract: public 'failed' is ONLY a clean
          // pre-charge decline (FailedClean), always reached with !sawProcessing — a charged-then-reversed order
          // surfaces as 'review', never 'failed'. So this branch does not fire today. It is kept as a fail-safe:
          // should a future contract ever surface a CHARGED order as 'failed', we must NOT offer retry (that could
          // double-charge), so we show the reversal copy and hide the pay button.
          h.setStatus(
            'Ödeme tamamlanamadı. Kartınızdan tahsilat yapıldıysa iade edilecek. Tekrar denemek için yeni bir sipariş başlatın.',
            'error',
          );
          h.hidePay();
        } else if (res.status === 'review') {
          // A charged order held for review (public 'review' = ChargeReversing / ChargeReversed / LossReview).
          // Never offer retry (that could double-charge) — but never leave a paid shopper button-less and blank
          // either: give an order reference and money reassurance. orderId is safe in setStatus (textContent).
          h.setStatus(
            method === 'bank_transfer'
              ? `Banka transferi incelemede. Sipariş: ${orderId}. Yeniden havale yapmayın; sağlayıcı doğrulaması veya iade takibi gerekiyor.`
              : `Ödeme incelemeye alındı, sipariş ${orderId}. Kartınızdan tahsilat yapıldıysa otomatik olarak iade edilecek, aksi halde size ulaşacağız. Bu numarayı saklayın, şu an yapmanız gereken bir şey yok.`,
            'info',
          );
          h.hidePay();
        } else {
          h.setStatus(text, kind);
          if (terminal) h.hidePay(); // 'completed' — the banner is informational from here, no retry
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
        if (terminal && method === 'bank_transfer') h.showBankTransfer(null);
        if (terminal) stopPolling();
      },
    );
  }, POLL_INTERVAL_MS);
}

function pay(detection: Detection, paymentMethod: 'card' | 'bank_transfer' = 'card'): void {
  const h = handle;
  if (h === null || inFlight) return; // ignore repeat clicks: a payment is already being started / in progress
  if (paymentMethod === 'bank_transfer' && BANK_TRANSFER_DEMO && demoBank !== null) {
    h.showBankTransfer(demoBank, true);
    h.setStatus('Test gösterimi. Para göndermeyin; gerçek ödeme başlatılmadı.', 'info');
    return;
  }
  inFlight = true;
  lastPaymentMethod = paymentMethod;
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
      fail(`Ödeme başlatılamadı${NOT_CHARGED}`);
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'TROIA_INTENT', body: { ...built.body, paymentMethod } },
      (outcome: IntentOutcome | undefined) => {
        if (chrome.runtime.lastError || outcome === undefined) {
          fail(`Ödeme servisine ulaşılamadı${NOT_CHARGED}`);
          return;
        }
        if (!outcome.ok) {
          // A failed tab-open (the background could not open the card page) means the buyer never reached it, so
          // nothing was charged — say that specifically; otherwise the generic start failure.
          fail(
            bankErrorCopy(outcome.error) ??
              (outcome.error === 'tab_open_failed'
                ? `Kart formu açılamadı${NOT_CHARGED}`
                : `Ödeme başlatılamadı${NOT_CHARGED}`),
          );
          console.info('[troia] intent rejected', { status: outcome.status, error: outcome.error });
          return;
        }
        // Success. Only claim the card form is opening when the background actually opened one (paymentPageUrl
        // present, i.e. action.poll). Keep the button disabled and reflect the coarse status via polling.
        const action = intentUiAction(outcome.response);
        if (outcome.response.bankTransfer !== undefined)
          h.showBankTransfer(outcome.response.bankTransfer);
        h.setStatus(action.text, action.kind === 'error' ? 'error' : 'info');
        if (action.poll) {
          startPolling(outcome.response.orderId, h, detection.sep7.amount, paymentMethod);
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
  h.setStatus('Yeni bir deneme başlatılıyor…', 'info');
  window.postMessage({ source: 'troia-extension', type: 'TROIA_RETRY', orderId }, location.origin);
  // Safety net: if no fresh order ever appears, don't leave the button stuck — re-offer the retry. The handle is
  // stored so a completed retry cancels it (clearPendingRetry), and a re-request cancels a prior one.
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!pendingRetry) return; // the retry already completed (a fresh banner replaced this one)
    pendingRetry = false;
    handle?.setStatus(
      `Yeni deneme başlatılamadı${NOT_CHARGED} Sayfayı yenileyip tekrar deneyin.`,
      'error',
    );
    handle?.setRetry();
  }, RETRY_TIMEOUT_MS);
}

// Ask the background (the sole host-permission holder) for a read-only price preview of the detected USDC amount,
// then show the indicative ≈₺ on the banner. Fail-OPEN on display: any failure (unparseable amount, no messaging,
// network, or a stale reply after the banner was replaced) leaves the USDC amount and the enabled Pay button
// untouched — the charged price is locked at /intent regardless. It reserves nothing and never triggers a payment.
function requestQuote(
  detection: Detection,
  h: BannerHandle,
  paymentMethod: 'card' | 'bank_transfer' = 'card',
): void {
  const stroops = toStroops(detection.sep7.amount);
  if (stroops === null) return; // an unparseable amount — /intent would fail-closed on it anyway
  if (typeof chrome === 'undefined' || chrome.runtime?.sendMessage === undefined) return;
  const requestId = ++quoteRequestId;
  chrome.runtime.sendMessage(
    {
      type: 'TROIA_QUOTE',
      amountStroops: stroops.toString(),
      ...(paymentMethod === 'bank_transfer' ? { paymentMethod } : {}),
    },
    (res: QuoteOutcome | undefined) => {
      if (h !== handle || requestId !== quoteRequestId) return; // drop stale order/method quotes
      if (chrome.runtime.lastError || res === undefined || !res.ok) return; // degrade to USDC-only, never block
      lastQuote = formatApproxTry(res.paidPriceTry);
      h.setApproxTry(lastQuote);
    },
  );
}

function scan(): void {
  const uri = findSep7Uri();
  if (uri === currentUri) return; // nothing changed since the last scan
  currentUri = uri;

  if (uri === null) {
    lastDetection = null;
    lastQuote = null;
    clearPendingRetry();
    clearBanner();
    return;
  }

  const detection = evaluate(uri);
  if (detection === null || !detection.payable) {
    // Fail-closed: an unrecognized or unverifiable request never gets a banner (nor a popup "found" state).
    lastDetection = null;
    lastQuote = null;
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
  lastQuote = null; // reset before requesting the fresh preview below
  clearBanner();
  demoBank = BANK_TRANSFER_DEMO
    ? newDemoBankTransfer(toStroops(detection.sep7.amount) ?? 0n)
    : null;
  handle = showBanner({
    amount: detection.sep7.amount,
    assetCode: detection.sep7.assetCode ?? 'USDC',
    onPay: (method) => pay(detection, method),
    onMethodChange: (method) => {
      lastQuote = null;
      handle?.setApproxTry(null);
      if (BANK_TRANSFER_DEMO && method === 'bank_transfer' && demoBank !== null) {
        handle?.showBankTransfer(demoBank, true);
        handle?.setStatus('Test gösterimi · Para göndermeyin.', 'info');
        return;
      }
      handle?.showBankTransfer(null);
      if (handle !== null) requestQuote(detection, handle, method);
    },
    onRetry: () => requestRetry(detection.sep7.memo ?? ''),
    onClose: () => {
      stopPolling();
      inFlight = false;
      clearPendingRetry();
      handle = null;
    },
  });

  requestQuote(detection, handle);

  // If this fresh SEP-7 is the fresh order we requested for a retry, continue the payment automatically —
  // one click on "Try again" then leads straight into the new card form.
  if (pendingRetry) {
    clearPendingRetry();
    pay(detection, lastPaymentMethod);
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
            ...(lastQuote !== null ? { approxTry: lastQuote } : {}),
          }
        : { found: false };
    sendResponse(reply);
  });
}
