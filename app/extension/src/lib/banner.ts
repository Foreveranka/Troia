// The fail-closed "Pay with Troy card" banner. Injected at the bottom of the page only when a payable
// USDC-on-Stellar request is detected. It lives in a shadow root so the merchant's CSS can neither style it
// nor be affected by it, and all interpolated values are HTML-escaped (a page-supplied SEP-7 is untrusted).
//
// showBanner returns a handle so the content script can reflect the POST /intent lifecycle on it (busy while
// in flight, then a coarse status line) without re-rendering.

const HOST_ID = 'troia-pay-banner-host';
const PAY_LABEL = 'Troy kartınla öde';
const RETRY_LABEL = 'Tekrar dene';
const BUSY_LABEL = 'İşleniyor…';

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
  /** Show/hide the indicative ≈₺ amount beside the USDC total, set once the read-only /quote reply lands. The
   *  charged price is still locked server-side at Pay; this is a preview only and never triggers a payment. Pass
   *  null/empty to hide it. */
  setApproxTry(text: string | null): void;
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
      .bar { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
             background:#0C1B30; color:#F4EFE4; display:flex; align-items:center; gap:14px;
             padding:12px 18px; border-top:2px solid #B08A50; box-shadow:0 -2px 16px rgba(12,27,48,.35); }
      .brand { display:flex; align-items:center; gap:9px; flex:none; padding-right:14px;
               border-right:1px solid rgba(244,239,228,.18); }
      .brand .mark { width:18px; height:18px; display:block; color:#C7A468; }
      .brand .bname { font-family:'Hoefler Text','Palatino Linotype',Palatino,Georgia,serif;
                      font-size:14px; font-weight:500; letter-spacing:.14em; color:#F4EFE4; }
      .txt { font-size:13px; line-height:1.45; flex:1; }
      .txt b { font-weight:600; }
      .note { display:block; margin-top:3px; font-size:11px; color:#9CA9BC; }
      .note b { color:#C7A468; font-weight:600; }
      .approx { font-size:12px; color:#C7A468; white-space:nowrap; flex:none; }
      .status { font-size:12px; letter-spacing:.01em; white-space:normal; max-width:260px; }
      .status[data-kind="error"] { color:#E8A49B; }
      .status[data-kind="info"] { color:#C7A468; }
      .pay { background:#B08A50; color:#0C1B30; border:0; border-radius:0; font-weight:700; font-size:12px;
             text-transform:uppercase; letter-spacing:.08em; padding:12px 18px; cursor:pointer; white-space:nowrap; }
      .pay:disabled { opacity:.55; cursor:default; }
      .pay:hover:not(:disabled) { background:#C7A468; }
      .pay:focus-visible { outline:2px solid #C7A468; outline-offset:2px; }
      .x { background:transparent; border:0; color:#9CA9BC; font-size:18px; line-height:1; cursor:pointer; padding:6px; }
      .x:hover { color:#F4EFE4; }
      .x:focus-visible { outline:2px solid #C7A468; outline-offset:2px; }
    </style>
    <div class="bar">
      <div class="brand">
        <svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 15h16M6 15c0-4 3-7 6-7s6 3 6 7"/></svg>
        <span class="bname">TROIA</span>
      </div>
      <div class="txt"><b>${escapeHtml(model.amount)} ${escapeHtml(model.assetCode)}</b> tutarını Troy kartınızla ödeyin, kripto gerekmez.<span class="note">Güvenli kart formu <b>iyzico</b> üzerinde açılır, Troia kart numaranızı hiçbir zaman görmez.</span></div>
      <span class="approx" hidden></span>
      <div class="status" role="status" aria-live="polite" aria-atomic="true" hidden></div>
      <button class="pay" type="button">${PAY_LABEL}</button>
      <button class="x" type="button" aria-label="Kapat">&times;</button>
    </div>`;

  const payBtn = shadow.querySelector('.pay') as HTMLButtonElement;
  const statusEl = shadow.querySelector('.status') as HTMLElement;
  const approxEl = shadow.querySelector('.approx') as HTMLElement;
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
      payBtn.textContent = busy ? BUSY_LABEL : PAY_LABEL;
    },
    setStatus(text: string, kind: 'info' | 'error'): void {
      statusEl.hidden = false;
      // Errors interrupt (assertive) so a "not charged" / "under review" message is heard; info stays polite. Set
      // text LAST, while the region is already un-hidden and live, so the screen reader actually announces it.
      statusEl.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
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
    setApproxTry(text: string | null): void {
      if (text === null || text.length === 0) {
        approxEl.hidden = true;
        approxEl.textContent = '';
        return;
      }
      approxEl.hidden = false;
      approxEl.textContent = text; // textContent, never innerHTML — the TL string is treated as untrusted data
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
