import { WALLET_BRIDGE_URL } from '../lib/config';
export type WalletRequest =
  { action: 'connect' } | { action: 'sign'; address: string; xdr: string };
export interface WalletResult {
  address?: string;
  signedTxXdr?: string;
  error?: string;
}
export function trustedWalletSender(
  sender: chrome.runtime.MessageSender,
  tabId: number | undefined,
  requestId: string,
  message: { id?: unknown },
): boolean {
  if (
    tabId === undefined ||
    sender.tab?.id !== tabId ||
    sender.frameId !== 0 ||
    sender.id !== chrome.runtime.id ||
    message.id !== requestId
  )
    return false;
  try {
    const url = new URL(sender.url!);
    const expected = new URL(WALLET_BRIDGE_URL);
    return url.origin === expected.origin && url.pathname === expected.pathname;
  } catch {
    return false;
  }
}
let pending = false;
export async function walletRequest(request: WalletRequest): Promise<WalletResult> {
  if (pending) throw new Error('Finish the open wallet approval first.');
  pending = true;
  try {
    return await new Promise<WalletResult>((resolve, reject) => {
      const id = crypto.randomUUID();
      let tabId: number | undefined;
      let delivered = false;
      let finished = false;
      const finish = (error?: string, result?: WalletResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        chrome.tabs.onRemoved.removeListener(removed);
        if (tabId !== undefined) void chrome.tabs.remove(tabId).catch(() => {});
        if (error) reject(new Error(error));
        else resolve(result ?? {});
      };
      const listener = (
        message: { type?: string; id?: string; result?: WalletResult },
        sender: chrome.runtime.MessageSender,
      ) => {
        if (!message || !trustedWalletSender(sender, tabId, id, message)) return;
        if (message.type === 'TROIA_WALLET_READY' && !delivered) {
          delivered = true;
          void chrome.tabs
            .sendMessage(tabId!, { type: 'TROIA_WALLET_REQUEST', id, request })
            .catch(() => {
              delivered = false;
            });
        }
        if (message.type === 'TROIA_WALLET_RESULT' && delivered)
          finish(message.result?.error, message.result);
      };
      const removed = (closedId: number) => {
        if (closedId === tabId) finish('Wallet approval was closed. You can try again.');
      };
      const timer = setTimeout(
        () =>
          finish(
            'Wallet approval timed out. Check that the Troia wallet helper is running and Freighter is installed.',
          ),
        180000,
      );
      chrome.runtime.onMessage.addListener(listener);
      chrome.tabs.onRemoved.addListener(removed);
      void chrome.tabs.create({ url: `${WALLET_BRIDGE_URL}#${id}`, active: true }).then(
        (tab) => {
          tabId = tab.id;
          if (finished && tabId !== undefined) void chrome.tabs.remove(tabId).catch(() => {});
        },
        () => finish('Could not open the wallet approval tab.'),
      );
    });
  } finally {
    pending = false;
  }
}
