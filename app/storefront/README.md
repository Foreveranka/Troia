# Troia demo storefront

A self-contained demo streetwear store (**React 19 + Vite**, no backend of its own) that **accepts USDC natively
on Stellar testnet**. It deliberately **knows nothing about the Troia bridge** — it just emits a standard payment
request and reacts to a browser message. The bridge (the "Pay with Troy card" extension + the Troia backend) is
what turns a Turkish card payment into that USDC settlement; the store is only the merchant side.

## Run

```bash
npm install
npm run dev       # Vite dev server
npm run build     # tsc -b && vite build
npm run lint      # oxlint
npm run preview   # preview the production build
```

There is **no test suite** here — this is the showcase surface, not a money-safety component. (The tested logic
lives in the workspace packages and the extension.)

## What it does

- **A realistic crypto-gateway checkout.** The shopper picks a coin → a network → pays to an address, like a real
  gateway. When they pick **USDC on Stellar**, the store renders a **SEP-7** request (`buildSep7` in
  `src/config.ts` → `web+stellar:pay?destination=…&amount=…&memo=…&memo_type=text&asset_code=USDC&asset_issuer=…`).
  The destination is the hardcoded testnet merchant (`GBCUCFGE…MNYAE`) and the asset is our testnet USDC issuer
  (`GCRAO5VCC…4N5W`); each order gets a short `ST-XXXXXXXX` reference used as the on-chain memo. The SEP-7 is
  rendered as a hidden anchor the moment the payment step opens, so the extension can read it off the DOM.
- **Two checkout paths.** _Pay with Troy card_ (handled by the extension → Troia backend → USDC settlement) or a
  plain **mock card** path (a local demo, no settlement) so the store is usable without the extension.
- **The `TROIA_PAID` handshake.** When the extension finishes, it posts
  `{ source: 'troia-extension', type: 'TROIA_PAID', orderId, amount, txHash, paidPriceTry }` to the page. The
  store accepts it **only from its own origin**, places the order at the **on-chain-settled amount** (not a
  re-estimate), ignores late/duplicate signals, and renders a **stellar.expert testnet tx link** on the
  confirmation + "My Orders" views so the settlement is verifiable.
- **Demo auth + orders.** Sign-in and "My Orders" are **localStorage only** — a demo convenience, **not real
  security**. Orders persist per browser.

## Boundary

The store never sees a private key, never signs anything, and never talks to Stellar directly — it emits a SEP-7
request and trusts a same-origin `TROIA_PAID` message. Everything money-related happens in the extension and the
backend; on-chain truth is the linked settlement tx.
