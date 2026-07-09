# Troia extension

A Chrome MV3 extension that detects a **USDC-on-Stellar (SEP-7)** checkout on a supported store and offers to
settle it with a **Troy card** instead — no crypto needed. It holds no keys and signs nothing: it reads the
page's `web+stellar:pay` request, relays an intent to the Troia backend, which opens iyzico's hosted card form in
a new browser tab. It then polls coarse status (via the background) and, on completion, fetches the settlement
receipt (on-chain tx hash + TRY charged) and posts `TROIA_PAID` to the storefront so the order is placed at the
on-chain-settled amount.

Standalone package (not part of the pnpm workspace), built with Vite + React + [`@crxjs/vite-plugin`].

## Develop

```bash
npm install
npm run dev      # HMR dev build on port 5174
npm run build    # production build into dist/
npm test         # vitest run — 105 tests across 10 spec files
```

Load the unpacked extension: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
and select the `dist/` directory (after `npm run build`).

## Paying in the demo (iyzico sandbox test cards)

The "Pay with Troy card" flow opens iyzico's **sandbox** hosted form in a new browser tab — valueless test cards, no real money.

**Troy cards (all succeed):**

| Bank | Number | Type |
| --- | --- | --- |
| Akbank | `9792072000017956` | credit |
| QNB | `9792023757123604` | debit |
| QNB | `9792020000000001` | debit |
| QNB | `9792030000000000` | credit |
| Vakıfbank | `6500528865390837` | debit |
| Vakıfbank | `6501700194147183` | credit |

**Decline (to show the fail-closed path):** Visa `4111111111111129` (insufficient funds).

- **Expiry:** any future date in a valid format (e.g. `12/30`)
- **CVC:** any 3 digits (e.g. `123`)
- **3DS OTP:** the sandbox 3DS screen **shows the code in parentheses** — type what it displays.

The full list (more decline reasons) is at
[docs.iyzico.com/en/add-ons/test-cards](https://docs.iyzico.com/en/add-ons/test-cards).

## Trust boundary

- The **content script** runs only on **localhost / 127.0.0.1 (any port)** and only reads the DOM.
- The **background service worker** is the only component that talks to the backend (holds the backend host
  permission; keeps the merchant origin isolated and avoids CORS).
- The extension never holds a key and never signs a transaction. Everything is fail-closed: if the payment
  request cannot be validated with confidence, no banner is shown and nothing is sent.

## Robustness (money-path)

The payment path is hardened and covered by tests: per-request fetch timeouts (15s intent / 8s poll), a
phase-aware poll budget with an honest give-up (a pre-payment timeout says "you were not charged"; a post-payment
delay says settlement is taking longer — it never falsely claims no charge), tab-open-failure handling, a
double-submit guard, memo parity pinned byte-for-byte to `@troia/core`'s golden vectors (malformed order ids fail
closed), and an amount gate aligned with the money parser (`toStroops`).

[`@crxjs/vite-plugin`]: https://crxjs.dev
