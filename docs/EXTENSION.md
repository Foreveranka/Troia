# Troia browser extension — install & use

The **"Pay with Troy card"** extension is a Chrome MV3 add-on that spots a USDC-on-Stellar (SEP-7) checkout on a
Troia storefront and offers to settle it with a Turkish **Troy card** instead — no wallet, no seed phrase. It holds
no keys and signs nothing (the design lives in [`ARCHITECTURE.md`](ARCHITECTURE.md) ADR-8; the live proof is in
[`DEPLOYMENTS.md`](DEPLOYMENTS.md)). This page is the practical guide to **loading it from this repo onto your own
machine** and driving it.

## Install it from this repo

**You need:** Node 22 (the repo pins `nodejs 22.18.0`), a Chromium-based browser (Chrome — Edge and Brave load
unpacked MV3 the same way), and this repo cloned.

The extension is a **standalone package** — it is _not_ part of the pnpm workspace, so it has its own `npm` install
and build:

```bash
cd app/extension
npm install
npm run build      # tsc -b && vite build → app/extension/dist
```

Then load the built folder as an unpacked extension:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select **`app/extension/dist`**.

The Troia icon appears in the toolbar. That is the whole install — there is nothing to configure by hand; the
deployment identifiers are compiled into the build (next section).

## What the build is pointed at

The build bakes in the **public** identifiers of one deployment from `app/extension/src/lib/deployment.generated.ts`
— the allowlisted USDC issuer, the backend URL, and the storefront origins the content script may act on. **That
file is the source of truth for what a build targets** — open it to see the current values. In local dev they are
backend `http://localhost:3000` and storefront `http://localhost:5173` / `http://127.0.0.1:5173`; a public
deployment (the backend on its own host, the storefront on its own origin) carries those URLs instead, and a freshly
built extension acts on them with no change to this guide.

It is **generated, not hand-edited**: `just fund` (or `just wire`) rewrites it from `deployment.testnet.json` via
`scripts/wire-apps.mjs`. So if you re-point Troia at a different deployment, **rebuild and reload the extension** —
its config is compiled in, and a stale build would reject the new deployment's own USDC and never show the banner:

```bash
just fund                          # re-points the storefront + extension at the current deployment
cd app/extension && npm run build  # then reload app/extension/dist in chrome://extensions
```

The addresses for the current deployment are in [`DEPLOYMENTS.md`](DEPLOYMENTS.md).

## Use it end-to-end

Loading the extension is not enough on its own — it acts on a **running** storefront and backend. Locally, standing
up that full stack (the operator's `just serve` + storefront + this extension) is the
[`LIVE_SMOKE.md`](LIVE_SMOKE.md) runbook. Against a public deployment the storefront and backend are already hosted,
so you just open the deployed storefront with the extension loaded. Either way:

1. Open the storefront and start a checkout. A **"Pay with Troy card"** banner appears — the extension read the
   page's SEP-7 request, validated it fail-closed, and only then offered to pay.
2. Click it → iyzico's **hosted** card form opens in a **new browser tab** (the card number never touches the
   extension or our servers).
3. Pay with a **Troy sandbox test card** — the six cards that succeed, the decline card, and the 3DS-OTP-in-
   parentheses detail are listed in the root [`README.md`](../README.md) ("Paying in the demo") and in
   `app/extension/README.md`. No real money moves.
4. On completion the extension shows the on-chain settlement receipt (transaction hash + TRY charged) and the order
   is placed at the settled amount.

## Good to know

- It is **scoped to the deployment's own storefront origin(s)**, never `<all_urls>`: the content script runs only on
  the origins recorded in `deployment.generated.ts` (in local dev, `localhost` / `127.0.0.1` on any port). Loading it
  does not give it access to any other site. The exact scope and its rationale are in
  [`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md).
- It **holds no keys and signs nothing** — it relays an intent to the backend, which drives the on-chain `pay()`. So
  anyone can load and watch it, but a live `pay()` only lands with the operator's keys behind the backend (see
  [`README.md`](../README.md)).
- For a browserless run, `scripts/intent.mjs` is the headless CLI alternative (see [`LIVE_SMOKE.md`](LIVE_SMOKE.md)).
- Development details — the HMR dev build on port 5174 and the extension's own test suite — are in
  `app/extension/README.md`.
