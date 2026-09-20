import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WALLET_BRIDGE_URL } from '../src/lib/config';
import { trustedWalletSender, walletRequest } from '../src/anchor/wallet';
const listeners = new Set<(m: unknown, s: chrome.runtime.MessageSender) => void>();
const removed = new Set<(id: number) => void>();
const create = vi.fn();
const send = vi.fn();
const remove = vi.fn();
const sender = {
  id: 'troia-test',
  frameId: 0,
  tab: { id: 12 },
  url: WALLET_BRIDGE_URL,
} as chrome.runtime.MessageSender;
beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  removed.clear();
  create.mockReset().mockResolvedValue({ id: 12 });
  send.mockReset().mockResolvedValue(undefined);
  remove.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'troia-test',
      onMessage: {
        addListener: (f: never) => listeners.add(f),
        removeListener: (f: never) => listeners.delete(f),
      },
    },
    tabs: {
      create,
      sendMessage: send,
      remove,
      onRemoved: {
        addListener: (f: never) => removed.add(f),
        removeListener: (f: never) => removed.delete(f),
      },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function emit(message: unknown, from = sender) {
  for (const listener of [...listeners]) listener(message, from);
}
function id() {
  return new URL(create.mock.calls.at(-1)![0].url).hash.slice(1);
}
describe('wallet helper boundary', () => {
  it('rejects other tabs, frames, origins, extensions, paths and request ids', () => {
    expect(trustedWalletSender(sender, 12, 'one', { id: 'one' })).toBe(true);
    for (const s of [
      { ...sender, tab: { id: 13 } },
      { ...sender, frameId: 1 },
      { ...sender, id: 'other' },
      { ...sender, url: 'https://evil.example/wallet' },
      { ...sender, url: WALLET_BRIDGE_URL + '/other' },
    ])
      expect(trustedWalletSender(s as chrome.runtime.MessageSender, 12, 'one', { id: 'one' })).toBe(
        false,
      );
    expect(trustedWalletSender(sender, 12, 'one', { id: 'two' })).toBe(false);
  });
  it('delivers once only to the helper and resolves only its matching result', async () => {
    const result = walletRequest({ action: 'connect' });
    await Promise.resolve();
    emit({ type: 'TROIA_WALLET_READY', id: id() }, { ...sender, frameId: 1 });
    expect(send).not.toHaveBeenCalled();
    emit({ type: 'TROIA_WALLET_READY', id: id() });
    emit({ type: 'TROIA_WALLET_READY', id: id() });
    expect(send).toHaveBeenCalledTimes(1);
    emit({ type: 'TROIA_WALLET_RESULT', id: id(), result: { address: 'account' } });
    await expect(result).resolves.toEqual({ address: 'account' });
    expect(listeners.size).toBe(0);
    expect(remove).toHaveBeenCalledWith(12);
  });
  it('rejects a closed helper and allows a fresh attempt', async () => {
    const result = walletRequest({ action: 'connect' });
    const failure = expect(result).rejects.toThrow('closed');
    await Promise.resolve();
    for (const f of [...removed]) f(12);
    await failure;
    const retry = walletRequest({ action: 'connect' });
    const cancelled = expect(retry).rejects.toThrow('cancelled');
    await Promise.resolve();
    emit({ type: 'TROIA_WALLET_READY', id: id() });
    emit({ type: 'TROIA_WALLET_RESULT', id: id(), result: { error: 'cancelled' } });
    await cancelled;
  });
  it('times out without leaving listeners or an orphan approval tab', async () => {
    const result = walletRequest({ action: 'connect' });
    const failure = expect(result).rejects.toThrow('timed out');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(180000);
    await failure;
    expect(listeners.size).toBe(0);
    expect(remove).toHaveBeenCalledWith(12);
  });
});
