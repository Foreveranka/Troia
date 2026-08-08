import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, type ChromeStub } from './fakes/chrome';

// background.ts is the only backend-talking + tab-opening component. Mock the backend calls so the router is
// tested in isolation (no real fetch), and drive its captured onMessage handler directly.
const { postIntent, getStatus, getReceipt, getQuote } = vi.hoisted(() => ({
  postIntent: vi.fn(),
  getStatus: vi.fn(),
  getReceipt: vi.fn(),
  getQuote: vi.fn(),
}));
vi.mock('../src/lib/backend', () => ({ postIntent, getStatus, getReceipt, getQuote }));

// background's handler does its work in a promise .then; flush microtasks before asserting the reply.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

let stub: ChromeStub;

beforeEach(() => {
  vi.resetModules();
  postIntent.mockReset();
  getStatus.mockReset();
  getReceipt.mockReset();
  getQuote.mockReset();
  stub = installChromeStub();
});

afterEach(() => {
  stub.uninstall();
  vi.restoreAllMocks();
});

async function loadRouter() {
  await import('../src/background');
  return stub.onMessageListener();
}

// The background worker is the only component holding the backend host permission, so it is the only one that can
// reach /intent. The manifest's match pattern is port-less — `http://localhost/*` lets the content script run on
// ANY localhost port — so any other local dev server could host a page that looks like the storefront. The exact
// origin allowlist is what makes that not enough, and a `sender` with no origin at all is not a content script.
const SENDER = { origin: 'http://localhost:5173' };
const FOREIGN = { origin: 'http://localhost:9999' };

describe('background message router — who may speak to it', () => {
  it('refuses a message from an origin outside the allowlist, and never reaches the backend', async () => {
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    const kept = handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, FOREIGN, sendResponse);

    expect(postIntent).not.toHaveBeenCalled();
    expect(stub.tabsCreate).not.toHaveBeenCalled();
    expect(kept).toBe(false); // nothing async to wait for
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      status: null,
      error: 'forbidden_origin',
    });
  });

  // Chrome sets `origin` for content scripts, but not every surface does. The fallback derives it from `url`,
  // and `new URL(...).origin` drops the path — so a page deep inside the storefront is still the storefront.
  it('accepts a sender that carries only a url, deriving the origin from it', async () => {
    getStatus.mockResolvedValue({ ok: true, status: 'processing' });
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler(
      { type: 'TROIA_STATUS', orderId: 'o1' },
      { url: 'http://localhost:5173/checkout?x=1' },
      sendResponse,
    );
    await flush();

    expect(getStatus).toHaveBeenCalledWith('o1'); // the path and query are not part of the origin
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'processing' });
  });

  it('refuses a url-only sender from a foreign origin', async () => {
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler(
      { type: 'TROIA_STATUS', orderId: 'o1' },
      { url: 'http://localhost:9999/evil' },
      sendResponse,
    );

    expect(getStatus).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'forbidden_origin' });
  });

  it('refuses a sender whose url is not parseable', async () => {
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_STATUS', orderId: 'o1' }, { url: 'not a url' }, sendResponse);

    expect(getStatus).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'forbidden_origin' });
  });

  it('refuses a sender with no origin — that is not a content script', async () => {
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_STATUS', orderId: 'o1' }, {}, sendResponse);

    expect(getStatus).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'forbidden_origin' });
  });

  // B-11: the manual-payment wizard runs on the extension's OWN page and speaks the same protocol.
  it("accepts the extension's own page (the wizard): own id AND own chrome-extension origin", async () => {
    getStatus.mockResolvedValue({ ok: true, status: 'pending' });
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    const own = {
      id: 'troia-test-extension-id',
      origin: 'chrome-extension://troia-test-extension-id',
    };
    const kept = handler({ type: 'TROIA_STATUS', orderId: 'o1' }, own, sendResponse);
    expect(kept).toBe(true);
    await flush();
    expect(getStatus).toHaveBeenCalledWith('o1');
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'pending' });
  });

  it('refuses ANOTHER extension, even with a chrome-extension origin (id must match too)', async () => {
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    const foreignExt = { id: 'evil-extension-id', origin: 'chrome-extension://evil-extension-id' };
    handler({ type: 'TROIA_STATUS', orderId: 'o1' }, foreignExt, sendResponse);

    expect(getStatus).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'forbidden_origin' });
  });

  it('refuses a spoofed own-origin whose sender id is missing', async () => {
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler(
      { type: 'TROIA_STATUS', orderId: 'o1' },
      { origin: 'chrome-extension://troia-test-extension-id' },
      sendResponse,
    );

    expect(getStatus).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'forbidden_origin' });
  });
});

describe('background message router', () => {
  it('opens the hosted-form tab and replies when POST /intent returns a paymentPageUrl', async () => {
    const response = {
      orderId: 'o1',
      token: 't',
      paymentPageUrl: 'https://iyzico.test/form',
      paidPriceTry: '10.00',
    };
    postIntent.mockResolvedValue({ ok: true, response });
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    const kept = handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, SENDER, sendResponse);
    expect(kept).toBe(true); // async reply — channel kept open
    await flush();

    expect(postIntent).toHaveBeenCalledWith({ orderId: 'o1' });
    expect(stub.tabsCreate).toHaveBeenCalledTimes(1);
    expect(stub.tabsCreate).toHaveBeenCalledWith({ url: 'https://iyzico.test/form' });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, response });
  });

  it('closes the SAME storefront tab’s previous form before opening a new one (a retry never leaves two live forms)', async () => {
    const response = {
      orderId: 'o1',
      token: 't',
      paymentPageUrl: 'https://iyzico.test/form',
      paidPriceTry: '10.00',
    };
    postIntent.mockResolvedValue({ ok: true, response });
    const handler = await loadRouter();
    const tabA = { origin: 'http://localhost:5173', tab: { id: 100 } };

    // first attempt from storefront tab 100 → opens form tab 1, closes nothing
    handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, tabA, vi.fn());
    await flush();
    expect(stub.tabsCreate).toHaveBeenCalledTimes(1);
    expect(stub.tabsRemove).not.toHaveBeenCalled();

    // retry from the SAME storefront tab → closes its stale form tab 1, then opens a new one
    handler({ type: 'TROIA_INTENT', body: { orderId: 'o2' } }, tabA, vi.fn());
    await flush();
    expect(stub.tabsRemove).toHaveBeenCalledWith(1);
    expect(stub.tabsCreate).toHaveBeenCalledTimes(2);
  });

  it('does NOT close another storefront tab’s live form (the close is scoped per storefront tab)', async () => {
    const response = {
      orderId: 'o1',
      token: 't',
      paymentPageUrl: 'https://iyzico.test/form',
      paidPriceTry: '10.00',
    };
    postIntent.mockResolvedValue({ ok: true, response });
    const handler = await loadRouter();
    const tabA = { origin: 'http://localhost:5173', tab: { id: 100 } };
    const tabB = { origin: 'http://localhost:5173', tab: { id: 200 } };

    handler({ type: 'TROIA_INTENT', body: { orderId: 'oa' } }, tabA, vi.fn());
    await flush();
    // a payment started in a DIFFERENT storefront tab must not touch tab A's still-live form
    handler({ type: 'TROIA_INTENT', body: { orderId: 'ob' } }, tabB, vi.fn());
    await flush();

    expect(stub.tabsRemove).not.toHaveBeenCalled();
    expect(stub.tabsCreate).toHaveBeenCalledTimes(2);
  });

  it('replies with tab_open_failed (and does not throw) when the tab cannot be opened', async () => {
    const response = {
      orderId: 'o1',
      token: 't',
      paymentPageUrl: 'https://iyzico.test/form',
      paidPriceTry: '10.00',
    };
    postIntent.mockResolvedValue({ ok: true, response });
    stub.tabsCreate.mockRejectedValueOnce(new Error('no active window'));
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, SENDER, sendResponse);
    await flush();

    expect(stub.tabsCreate).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      status: null,
      error: 'tab_open_failed',
    });
  });

  it('does NOT open a tab for an already-started duplicate (no paymentPageUrl) but still replies', async () => {
    const response = { orderId: 'o1', token: 't', paidPriceTry: '10.00', alreadyStarted: true };
    postIntent.mockResolvedValue({ ok: true, response });
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, SENDER, sendResponse);
    await flush();

    expect(stub.tabsCreate).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, response });
  });

  it('does NOT open a tab and forwards the failure when POST /intent is rejected', async () => {
    const outcome = { ok: false, status: 409, error: 'PoolInsufficient' };
    postIntent.mockResolvedValue(outcome);
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, SENDER, sendResponse);
    await flush();

    expect(stub.tabsCreate).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(outcome);
  });

  it('replies with an internal error and opens no tab when postIntent throws', async () => {
    postIntent.mockRejectedValue(new Error('boom'));
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, SENDER, sendResponse);
    await flush();

    expect(stub.tabsCreate).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, status: null, error: 'internal' });
  });

  it('routes TROIA_STATUS to getStatus and forwards its outcome', async () => {
    getStatus.mockResolvedValue({ ok: true, status: 'processing' });
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    const kept = handler({ type: 'TROIA_STATUS', orderId: 'o1' }, SENDER, sendResponse);
    expect(kept).toBe(true);
    await flush();

    expect(getStatus).toHaveBeenCalledWith('o1');
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'processing' });
  });

  it('replies with an internal error when getStatus throws', async () => {
    getStatus.mockRejectedValue(new Error('boom'));
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_STATUS', orderId: 'o1' }, SENDER, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'internal' });
  });

  it('routes TROIA_RECEIPT to getReceipt and forwards its outcome', async () => {
    getReceipt.mockResolvedValue({ ok: true, txHash: 'h', paidPriceTry: '10.00' });
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_RECEIPT', orderId: 'o1' }, SENDER, sendResponse);
    await flush();

    expect(getReceipt).toHaveBeenCalledWith('o1');
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, txHash: 'h', paidPriceTry: '10.00' });
  });

  it('routes TROIA_QUOTE to getQuote and forwards its outcome (read-only preview)', async () => {
    getQuote.mockResolvedValue({ ok: true, paidPriceTry: '41.42', spreadBps: 229 });
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    const kept = handler({ type: 'TROIA_QUOTE', amountStroops: '10000000' }, SENDER, sendResponse);
    expect(kept).toBe(true);
    await flush();

    expect(getQuote).toHaveBeenCalledWith('10000000');
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, paidPriceTry: '41.42', spreadBps: 229 });
  });

  it('refuses TROIA_QUOTE from a foreign origin and never reaches the backend', async () => {
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_QUOTE', amountStroops: '10000000' }, FOREIGN, sendResponse);

    expect(getQuote).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'forbidden_origin' });
  });

  it('replies with an internal error when getQuote rejects', async () => {
    getQuote.mockRejectedValue(new Error('boom'));
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_QUOTE', amountStroops: '10000000' }, SENDER, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'internal' });
  });

  it('ignores an unknown message and an intent with no body (returns false, no reply)', async () => {
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    expect(handler({ type: 'NOPE' }, SENDER, sendResponse)).toBe(false);
    expect(handler({ type: 'TROIA_INTENT' }, SENDER, sendResponse)).toBe(false); // missing body
    expect(sendResponse).not.toHaveBeenCalled();
    expect(postIntent).not.toHaveBeenCalled();
    expect(stub.tabsCreate).not.toHaveBeenCalled();
  });
});
