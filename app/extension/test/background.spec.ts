import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStub, type ChromeStub } from './fakes/chrome';

// background.ts is the only backend-talking + tab-opening component. Mock the backend calls so the router is
// tested in isolation (no real fetch), and drive its captured onMessage handler directly.
const { postIntent, getStatus, getReceipt } = vi.hoisted(() => ({
  postIntent: vi.fn(),
  getStatus: vi.fn(),
  getReceipt: vi.fn(),
}));
vi.mock('../src/lib/backend', () => ({ postIntent, getStatus, getReceipt }));

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

    const kept = handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, {}, sendResponse);
    expect(kept).toBe(true); // async reply — channel kept open
    await flush();

    expect(postIntent).toHaveBeenCalledWith({ orderId: 'o1' });
    expect(stub.tabsCreate).toHaveBeenCalledTimes(1);
    expect(stub.tabsCreate).toHaveBeenCalledWith({ url: 'https://iyzico.test/form' });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, response });
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

    handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, {}, sendResponse);
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

    handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, {}, sendResponse);
    await flush();

    expect(stub.tabsCreate).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, response });
  });

  it('does NOT open a tab and forwards the failure when POST /intent is rejected', async () => {
    const outcome = { ok: false, status: 409, error: 'PoolInsufficient' };
    postIntent.mockResolvedValue(outcome);
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, {}, sendResponse);
    await flush();

    expect(stub.tabsCreate).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(outcome);
  });

  it('replies with an internal error and opens no tab when postIntent throws', async () => {
    postIntent.mockRejectedValue(new Error('boom'));
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_INTENT', body: { orderId: 'o1' } }, {}, sendResponse);
    await flush();

    expect(stub.tabsCreate).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, status: null, error: 'internal' });
  });

  it('routes TROIA_STATUS to getStatus and forwards its outcome', async () => {
    getStatus.mockResolvedValue({ ok: true, status: 'processing' });
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    const kept = handler({ type: 'TROIA_STATUS', orderId: 'o1' }, {}, sendResponse);
    expect(kept).toBe(true);
    await flush();

    expect(getStatus).toHaveBeenCalledWith('o1');
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'processing' });
  });

  it('replies with an internal error when getStatus throws', async () => {
    getStatus.mockRejectedValue(new Error('boom'));
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_STATUS', orderId: 'o1' }, {}, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'internal' });
  });

  it('routes TROIA_RECEIPT to getReceipt and forwards its outcome', async () => {
    getReceipt.mockResolvedValue({ ok: true, txHash: 'h', paidPriceTry: '10.00' });
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    handler({ type: 'TROIA_RECEIPT', orderId: 'o1' }, {}, sendResponse);
    await flush();

    expect(getReceipt).toHaveBeenCalledWith('o1');
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, txHash: 'h', paidPriceTry: '10.00' });
  });

  it('ignores an unknown message and an intent with no body (returns false, no reply)', async () => {
    const handler = await loadRouter();
    const sendResponse = vi.fn();

    expect(handler({ type: 'NOPE' }, {}, sendResponse)).toBe(false);
    expect(handler({ type: 'TROIA_INTENT' }, {}, sendResponse)).toBe(false); // missing body
    expect(sendResponse).not.toHaveBeenCalled();
    expect(postIntent).not.toHaveBeenCalled();
    expect(stub.tabsCreate).not.toHaveBeenCalled();
  });
});
