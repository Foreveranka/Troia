import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, type ChromeStub } from './fakes/chrome';
import type { IntentOutcome, ReceiptOutcome } from '../src/lib/backend';

// The memo derivation is exercised by derive-memo.spec; here it is mocked so buildIntentBody resolves
// deterministically (no native crypto timing) and the tests focus on the pay → poll → order-placement wiring.
vi.mock('../src/lib/derive-memo', () => ({ deriveMemoHex: vi.fn(async () => 'a'.repeat(64)) }));

const MERCHANT = 'GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX';
const ISSUER = 'GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W';
const HOST_ID = 'troia-pay-banner-host';
const PAYABLE = `web+stellar:pay?destination=${MERCHANT}&amount=62.00&memo=ST-AB12CD&memo_type=text&asset_code=USDC&asset_issuer=${ISSUER}`;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  document.getElementById(HOST_ID)?.remove();
});

afterEach(() => {
  document.getElementById(HOST_ID)?.remove();
});

describe('content script pipeline (initial scan)', () => {
  it('injects the banner when a payable request is already on the page at load', async () => {
    document.body.innerHTML = `<a href="${PAYABLE}">Open in wallet</a>`;
    await import('../src/content');
    const h = document.getElementById(HOST_ID);
    expect(h).not.toBeNull();
    expect(h!.shadowRoot!.textContent).toContain('62.00');
  });

  it('shows no banner when the on-page request is not payable (native XLM)', async () => {
    document.body.innerHTML = `<a href="web+stellar:pay?destination=${MERCHANT}&amount=1&memo=X&memo_type=text">Open in wallet</a>`;
    await import('../src/content');
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it('shows no banner on a page with no SEP-7 at all', async () => {
    document.body.innerHTML = `<a href="https://example.com">x</a>`;
    await import('../src/content');
    expect(document.getElementById(HOST_ID)).toBeNull();
  });
});

describe('content script lifecycle (pay → poll → order placement)', () => {
  let stub: ChromeStub;

  const OPEN_INTENT: IntentOutcome = {
    ok: true,
    response: {
      orderId: 'ST-AB12CD',
      token: 'tok',
      paymentPageUrl: 'https://iyzico.test/form',
      paidPriceTry: '2000.00',
    },
  };
  const RECEIPT: ReceiptOutcome = { ok: true, txHash: 'abc123', paidPriceTry: '2000.00' };

  // buildIntentBody is async (a mocked memo microtask); flush the microtask queue without touching fake timers.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const shadow = (): ShadowRoot => document.getElementById(HOST_ID)!.shadowRoot!;
  const statusText = (): string | null => shadow().querySelector('.status')?.textContent ?? null;
  const statusPolls = (): number =>
    stub.sendMessage.mock.calls.filter((c) => (c[0] as { type?: string }).type === 'TROIA_STATUS')
      .length;

  const loadWithBanner = async (): Promise<void> => {
    document.body.innerHTML = `<a href="${PAYABLE}">Open in wallet</a>`;
    await import('../src/content');
  };
  const clickPay = async (): Promise<void> => {
    (shadow().querySelector('.pay') as HTMLButtonElement).click();
    await flush(); // buildIntentBody resolves → TROIA_INTENT is sent
  };

  beforeEach(() => {
    vi.useFakeTimers();
    stub = installChromeStub();
  });

  afterEach(() => {
    stub.uninstall();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('happy path: pay opens the form, statuses advance, and TROIA_PAID is posted exactly once on completed', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    stub.script.intent = OPEN_INTENT;
    stub.script.statuses = ['pending', 'processing', 'completed'];
    stub.script.receipt = RECEIPT;

    await loadWithBanner();
    await clickPay();

    expect(stub.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TROIA_INTENT' }),
      expect.any(Function),
    );
    expect(statusText()).toBe('Opening the secure card form…');

    await vi.advanceTimersByTimeAsync(3000); // pending
    await vi.advanceTimersByTimeAsync(3000); // processing
    await vi.advanceTimersByTimeAsync(3000); // completed → receipt → TROIA_PAID

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      {
        source: 'troia-extension',
        type: 'TROIA_PAID',
        orderId: 'ST-AB12CD',
        amount: '62.00',
        txHash: 'abc123',
        paidPriceTry: '2000.00',
      },
      location.origin,
    );

    // polling stopped at the terminal 'completed' — no further status polls
    const settled = statusPolls();
    await vi.advanceTimersByTimeAsync(9000);
    expect(statusPolls()).toBe(settled);
  });

  it('carries a null tx hash into TROIA_PAID when the receipt is not available', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    stub.script.intent = OPEN_INTENT;
    stub.script.statuses = ['completed'];
    stub.script.receipt = { ok: false, error: 'not-ready' };

    await loadWithBanner();
    await clickPay();
    await vi.advanceTimersByTimeAsync(3000);

    expect(post).toHaveBeenCalledWith(
      {
        source: 'troia-extension',
        type: 'TROIA_PAID',
        orderId: 'ST-AB12CD',
        amount: '62.00',
        txHash: null,
        paidPriceTry: null,
      },
      location.origin,
    );
  });

  it('an already-in-progress duplicate (no form URL) shows the resume copy and still polls', async () => {
    stub.script.intent = {
      ok: true,
      response: {
        orderId: 'ST-AB12CD',
        token: 'tok',
        paidPriceTry: '2000.00',
        alreadyStarted: true,
      },
    };
    stub.script.defaultStatus = 'pending';

    await loadWithBanner();
    await clickPay();

    expect(stub.tabsCreate).not.toHaveBeenCalled(); // (tab opening is background's job; here just no claim of a new form)
    expect(statusText()).toBe(
      'This order is already in progress — continue in your card form tab.',
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(statusPolls()).toBe(1);
  });

  it('shows a not-charged error and does not poll when the service reply is dropped', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    stub.script.intent = undefined; // callback invoked with undefined

    await loadWithBanner();
    await clickPay();

    expect(statusText()).toBe("Couldn't reach the payment service — you were not charged.");
    await vi.advanceTimersByTimeAsync(9000);
    expect(statusPolls()).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('shows a not-charged error and does not poll when the intent is rejected', async () => {
    stub.script.intent = { ok: false, status: 409, error: 'PoolInsufficient' };

    await loadWithBanner();
    await clickPay();

    expect(statusText()).toBe("Couldn't start the payment — you were not charged.");
    await vi.advanceTimersByTimeAsync(9000);
    expect(statusPolls()).toBe(0);
  });

  it('stops polling on a terminal failed status without placing an order', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    stub.script.intent = OPEN_INTENT;
    stub.script.statuses = ['failed'];

    await loadWithBanner();
    await clickPay();
    await vi.advanceTimersByTimeAsync(3000);

    expect(statusText()).toBe('Payment was not completed.');
    expect(post).not.toHaveBeenCalled();
    const settled = statusPolls();
    await vi.advanceTimersByTimeAsync(9000);
    expect(statusPolls()).toBe(settled);
  });

  it('polls through the generous pending window, then gives up with a not-charged message (never silent)', async () => {
    stub.script.intent = OPEN_INTENT;
    stub.script.defaultStatus = 'pending'; // buyer never completes the card payment

    await loadWithBanner();
    await clickPay();
    await vi.advanceTimersByTimeAsync(3000 * 402);

    expect(statusPolls()).toBe(400); // PENDING_MAX_POLLS — not the old silent 200 cap
    expect(statusText()).toBe(
      'Payment session timed out — you were not charged. Refresh to try again.',
    );
    const settled = statusPolls();
    await vi.advanceTimersByTimeAsync(3000 * 10);
    expect(statusPolls()).toBe(settled); // stopped
  });

  it('resets the budget once payment is received, then gives up with a settlement-pending message', async () => {
    stub.script.intent = OPEN_INTENT;
    stub.script.statuses = ['processing']; // first poll: payment received
    stub.script.defaultStatus = 'processing'; // stays processing, never completes

    await loadWithBanner();
    await clickPay();
    await vi.advanceTimersByTimeAsync(3000 * 85); // first tick sees processing (reset), then ~CONFIRM_MAX_POLLS more

    expect(statusText()).toBe(
      'Payment received — settlement is taking a little longer and will complete shortly. You can safely close this.',
    );
    const settled = statusPolls();
    expect(settled).toBeGreaterThan(1); // polled well past the first processing tick (budget was reset)
    await vi.advanceTimersByTimeAsync(3000 * 10);
    expect(statusPolls()).toBe(settled); // stopped
  });

  it('does not fire a second intent when Pay is clicked again while a payment is in progress', async () => {
    stub.script.intent = OPEN_INTENT;
    stub.script.defaultStatus = 'pending';

    await loadWithBanner();
    await clickPay(); // first intent; polling started; button disabled + in-flight

    (shadow().querySelector('.pay') as HTMLButtonElement).click(); // repeat click must be a no-op
    await flush();

    const intents = stub.sendMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'TROIA_INTENT',
    ).length;
    expect(intents).toBe(1);
  });

  it('re-enables Pay after a clean failure so the buyer can retry (a retry fires a fresh intent)', async () => {
    stub.script.intent = { ok: false, status: 409, error: 'PoolInsufficient' };

    await loadWithBanner();
    await clickPay(); // first intent → rejected → banner re-enabled
    await clickPay(); // retry → second intent

    const intents = stub.sendMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'TROIA_INTENT',
    ).length;
    expect(intents).toBe(2);
  });

  it('shows a card-form error and does not poll when the tab could not be opened', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    stub.script.intent = { ok: false, status: null, error: 'tab_open_failed' };

    await loadWithBanner();
    await clickPay();

    expect(statusText()).toBe("Couldn't open the card form — you were not charged.");
    await vi.advanceTimersByTimeAsync(9000);
    expect(statusPolls()).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('stops polling when the shopper dismisses the banner', async () => {
    stub.script.intent = OPEN_INTENT;
    stub.script.defaultStatus = 'pending';

    await loadWithBanner();
    await clickPay();
    await vi.advanceTimersByTimeAsync(3000); // one poll

    (shadow().querySelector('.x') as HTMLButtonElement).click(); // dismiss → onClose → stopPolling
    expect(document.getElementById(HOST_ID)).toBeNull();

    const settled = statusPolls();
    await vi.advanceTimersByTimeAsync(9000);
    expect(statusPolls()).toBe(settled);
  });

  it('adds the banner when a payable request appears after load, and clears it when it disappears', async () => {
    document.body.innerHTML = '';
    await import('../src/content');
    expect(document.getElementById(HOST_ID)).toBeNull();

    document.body.innerHTML = `<a href="${PAYABLE}">Open in wallet</a>`;
    await flush();
    await vi.advanceTimersByTimeAsync(50); // MutationObserver → requestAnimationFrame-debounced rescan
    expect(document.getElementById(HOST_ID)).not.toBeNull();

    document.body.innerHTML = '';
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });
});
