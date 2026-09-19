import { WALLET_BRIDGE_URL } from '../lib/config';
const expected = new URL(WALLET_BRIDGE_URL);
if (location.origin === expected.origin && location.pathname === expected.pathname) {
  const id = location.hash.slice(1);
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    let request: unknown;
    const ready = setInterval(() => {
      void chrome.runtime.sendMessage({ type: 'TROIA_WALLET_READY', id }).catch(() => {});
      if (request)
        window.postMessage({ type: 'TROIA_WALLET_REQUEST', id, request }, location.origin);
    }, 500);
    setTimeout(() => clearInterval(ready), 180000);
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (
        sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('src/anchor/index.html') ||
        message?.type !== 'TROIA_WALLET_REQUEST' ||
        message.id !== id
      )
        return;
      request = message.request;
      window.postMessage({ type: 'TROIA_WALLET_REQUEST', id, request }, location.origin);
    });
    window.addEventListener('message', (event) => {
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        event.data?.type !== 'TROIA_WALLET_RESULT' ||
        event.data.id !== id ||
        !request
      )
        return;
      clearInterval(ready);
      request = undefined;
      void chrome.runtime
        .sendMessage({ type: 'TROIA_WALLET_RESULT', id, result: event.data.result })
        .catch(() => {});
    });
  }
}
