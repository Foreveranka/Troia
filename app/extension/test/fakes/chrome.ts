// A minimal, scriptable stub of the `chrome.*` surface the extension actually touches, so the money-moving
// paths (content.ts pay → poll → TROIA_PAID, and background.ts's message router + tab open) can run under
// vitest without a real browser. It mirrors ONLY what the code uses:
//   - runtime.sendMessage(msg, cb)   — content script: dispatches by msg.type and invokes the callback with a
//     scripted outcome (intent, a queue of statuses, receipt).
//   - runtime.lastError              — settable, so the "couldn't reach the service" branch is reachable.
//   - runtime.onMessage.addListener  — background: captures the handler so a test can call it directly.
//   - runtime.onInstalled.addListener— background: no-op capture.
//   - tabs.create(opts)              — background: a spy resolving like the real API.
// installChromeStub swaps globalThis.chrome and returns spies + a mutable `script`; uninstall() restores it.

import { vi, type Mock } from 'vitest';
import type { PublicStatus } from '../../src/lib/intent';
import type { IntentOutcome, ReceiptOutcome, StatusOutcome } from '../../src/lib/backend';

type MessageHandler = (
  message: unknown,
  sender: unknown,
  sendResponse: (r?: unknown) => void,
) => boolean | void;

export interface ChromeStubScript {
  /** the outcome returned to a TROIA_INTENT sendMessage (undefined models a dropped reply). */
  intent?: IntentOutcome;
  /** consumed one-per-TROIA_STATUS poll; when empty, `defaultStatus` is returned forever. */
  statuses: PublicStatus[];
  defaultStatus: PublicStatus;
  /** the outcome returned to a TROIA_RECEIPT sendMessage. */
  receipt?: ReceiptOutcome;
}

export interface ChromeStub {
  readonly sendMessage: Mock;
  readonly tabsCreate: Mock;
  readonly tabsRemove: Mock;
  readonly onInstalled: Mock;
  /** the onMessage handler background registered at import (throws if none). */
  onMessageListener(): MessageHandler;
  /** mutable — set intent/statuses/receipt before driving the flow. */
  readonly script: ChromeStubScript;
  setLastError(err: { message: string } | undefined): void;
  uninstall(): void;
}

export function installChromeStub(script: Partial<ChromeStubScript> = {}): ChromeStub {
  const state: ChromeStubScript = { statuses: [], defaultStatus: 'pending', ...script };
  let messageHandler: MessageHandler | undefined;

  const runtime = {
    lastError: undefined as { message: string } | undefined,
    onInstalled: { addListener: vi.fn() },
    onMessage: {
      addListener: vi.fn((fn: MessageHandler) => {
        messageHandler = fn;
      }),
    },
    sendMessage: vi.fn((message: { type?: string }, cb: (r?: unknown) => void) => {
      switch (message.type) {
        case 'TROIA_INTENT':
          cb(state.intent);
          return;
        case 'TROIA_STATUS': {
          const status =
            state.statuses.length > 0
              ? (state.statuses.shift() as PublicStatus)
              : state.defaultStatus;
          cb({ ok: true, status } satisfies StatusOutcome);
          return;
        }
        case 'TROIA_RECEIPT':
          cb(state.receipt ?? ({ ok: false, error: 'none' } satisfies ReceiptOutcome));
          return;
        default:
          cb(undefined);
      }
    }),
  };

  let nextTabId = 1;
  const tabs = {
    create: vi.fn(() => Promise.resolve({ id: nextTabId++ })),
    remove: vi.fn(() => Promise.resolve()),
  };
  const chrome = { runtime, tabs };

  const globals = globalThis as Record<string, unknown>;
  const prev = globals.chrome;
  globals.chrome = chrome;

  return {
    sendMessage: runtime.sendMessage,
    tabsCreate: tabs.create,
    tabsRemove: tabs.remove,
    onInstalled: runtime.onInstalled.addListener,
    onMessageListener: () => {
      if (messageHandler === undefined)
        throw new Error('background registered no onMessage listener');
      return messageHandler;
    },
    script: state,
    setLastError: (err) => {
      runtime.lastError = err;
    },
    uninstall: () => {
      globals.chrome = prev;
    },
  };
}
