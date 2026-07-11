// The fail-closed "Pay with Troy card" banner. Injected at the bottom of the page only when a payable
// USDC-on-Stellar request is detected. It lives in a shadow root so the merchant's CSS can neither style it
// nor be affected by it, and all interpolated values are HTML-escaped (a page-supplied SEP-7 is untrusted).
//
// showBanner returns a handle so the content script can reflect the POST /intent lifecycle on it (busy while
// in flight, then a coarse status line) without re-rendering.

const HOST_ID = 'troia-pay-banner-host';
const PAY_LABEL = 'Pay with Troy card';
const RETRY_LABEL = 'Try again';

export interface BannerModel {
  readonly amount: string;
  readonly assetCode: string;
  readonly onPay: () => void;
  /** Called when the shopper clicks the button after it has been switched to "Try again" (see setRetry). Lets
   *  the caller start a FRESH attempt instead of re-firing the spent order. Falls back to onPay if not given. */
  readonly onRetry?: () => void;
  /** Called when the shopper dismisses the banner (× ) — lets the caller stop any status polling. */
  readonly onClose?: () => void;
}

export interface BannerHandle {
  setBusy(busy: boolean): void;
  setStatus(text: string, kind: 'info' | 'error'): void;
  /** After a failed/timed-out attempt: re-enable the button, relabel it "Try again", and route its next click
   *  to onRetry (a fresh attempt) rather than onPay (the spent order). */
  setRetry(): void;
  /** Remove the action button entirely — for a terminal state where retrying would be unsafe (a payment was
   *  received, or the order is still live) so the banner is now informational only. */
  hidePay(): void;
  remove(): void;
}

export function showBanner(model: BannerModel): BannerHandle {
  removeBanner();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .bar { font-family: system-ui, -apple-system, sans-serif; background:#0b0b0c; color:#fff; display:flex;
             align-items:center; gap:14px; padding:12px 18px; box-shadow:0 -2px 16px rgba(0,0,0,.3); }
      .txt { font-size:13px; line-height:1.4; flex:1; }
      .txt b { font-weight:700; }
      .status { font-size:12px; letter-spacing:.01em; white-space:nowrap; }
      .status[data-kind="error"] { color:#ff8a80; }
      .status[data-kind="info"] { color:#8ff0e4; }
      .pay { background:#35e0d0; color:#03110f; border:0; border-radius:4px; font-weight:800; font-size:13px;
             padding:10px 16px; cursor:pointer; letter-spacing:.02em; white-space:nowrap; }
      .pay:disabled { opacity:.6; cursor:default; }
      .pay:hover:not(:disabled) { filter:brightness(1.05); }
      .x { background:transparent; border:0; color:#9aa0a6; font-size:18px; line-height:1; cursor:pointer; padding:6px; }
    </style>
    <div class="bar">
      <div class="txt">Pay <b>${escapeHtml(model.amount)} ${escapeHtml(model.assetCode)}</b> with your Troy card — no crypto needed.</div>
      <div class="status" hidden></div>
      <button class="pay" type="button">${PAY_LABEL}</button>
      <button class="x" type="button" aria-label="Dismiss">&times;</button>
    </div>`;

  const payBtn = shadow.querySelector('.pay') as HTMLButtonElement;
  const statusEl = shadow.querySelector('.status') as HTMLElement;
  let retryMode = false; // set by setRetry(); a click then means "start a fresh attempt", not "pay this order"
  payBtn.addEventListener('click', () => {
    if (retryMode && model.onRetry !== undefined) model.onRetry();
    else model.onPay();
  });
  shadow.querySelector('.x')?.addEventListener('click', () => {
    removeBanner();
    model.onClose?.();
  });
  document.body.appendChild(host);

  return {
    setBusy(busy: boolean): void {
      // Leaving the busy state returns the button to its normal "Pay" role (a retry has its own explicit setRetry).
      retryMode = false;
      payBtn.disabled = busy;
      payBtn.textContent = busy ? 'Processing…' : PAY_LABEL;
    },
    setStatus(text: string, kind: 'info' | 'error'): void {
      statusEl.hidden = false;
      statusEl.textContent = text;
      statusEl.dataset.kind = kind;
    },
    setRetry(): void {
      retryMode = true;
      payBtn.disabled = false;
      payBtn.textContent = RETRY_LABEL;
    },
    hidePay(): void {
      retryMode = false;
      payBtn.style.display = 'none';
    },
    remove(): void {
      removeBanner();
    },
  };
}

export function removeBanner(): void {
  document.getElementById(HOST_ID)?.remove();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
