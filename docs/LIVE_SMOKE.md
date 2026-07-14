# Troia — Live-Smoke Runbook (Phase 4.5 end-to-end)

> **✅ Executed.** This is the operational script for a real iyzico charge automatically driving a real on-chain
> `TroyPool.pay()` on testnet — this doc is how a human drives it. Honest boundary: **`signed ≠ settled`**
> (see [`RECONCILIATION.md`](RECONCILIATION.md)). Nothing here runs in the
> offline gate: it uses the network and the iyzico **sandbox** (valueless test cards); the USDC is our own testnet
> mint. No real money moves.

**Proven runs** (full detail in [`DEPLOYMENTS.md`](DEPLOYMENTS.md)):

| Date       | Order         | Amount  | Tx                                                                                                                         | Additionally proved                                                           |
| ---------- | ------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 2026-07-07 | (storefront)  | 74 USDC | [`cd643d71…`](https://stellar.expert/explorer/testnet/tx/cd643d7178c6d6068aabe236af45e68fba60d9062d1ff71a85c5af75dfb08ded) | storefront + Chrome extension path end-to-end (not just `scripts/intent.mjs`) |
| 2026-07-10 | `ST-7SRI0YDF` | 80 USDC | [`d47f7fb9…`](https://stellar.expert/explorer/testnet/tx/d47f7fb92a149d61a6f576aa7f803d75e6d3b3dcb6b0119e5a12a7387683d1a5) | durable logs, payout tail, live reconciler, and a kill-and-restart            |

`just serve` now also runs the **TRY-driven rebalance bot** (Step 4). Everything the run needs is wired +
offline-tested — see [`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md) §4.

---

## What the live run smokes (that offline cannot)

The network-facing halves are type-checked and exercised by fakes offline, but a live run is the first time they
hit a real RPC / the real sandbox. This run smokes:

1. **The dirty Stellar adapters** — `readSacBalance` (pool balance), the `pay()` submit + poll (`getTransaction`,
   `getLedgerEntries`, `getLatestLedger`), destination trustline load (Horizon), and — new — the **issuer-signed
   USDC SAC mint** (`createSacMintClient` / `sac-mint`) that the rebalance bot uses to refill the pool.
2. **The iyzico HTTP client** — a real hosted-form init and a real signed callback (settlement itself is the poll
   worker's authenticated pull, not a configured server-to-server webhook).
3. **The live oracle inputs** — the CEX spot mid (Binance/Bybit/OKX) and the Yahoo daily-close history, now behind
   per-attempt timeouts + bounded retry (a hung source drops fail-closed, a transient blip retries).
4. **The revert-read shape** — whether a landed-and-reverted `pay()` carries the diagnostic events
   `readContractErrorCode` reads. Confirmed on chain (Step 7); reproducible with `scripts/stage-revert.mjs`.

---

## Who can run this?

This runbook is for the **operator who holds the deployment's keys**. `just serve` boots fail-closed on
`TROIA_OPERATOR_SECRET` and `TROIA_ISSUER_SECRET`, and those must be the **same** keys the deployed `TroyPool`
(`CCVNY6H…`, see [`DEPLOYMENTS.md`](DEPLOYMENTS.md)) was constructed with — any other operator key fails the
operator's on-chain `require_auth()`, so `pay()` can never be authorized. Those secrets live only in a git-ignored
`.env`; they are never shared.

**A reviewer who does not hold them has two honest paths, neither of which needs our secrets:**

- **Reproduce the proof offline** — `just verify` / `just verify-live` / `just verify-tampered` re-derive every
  verdict from embedded evidence with no keys, no network, and no live services (see
  [`RECONCILIATION.md`](RECONCILIATION.md)). This is the reviewer-verifiable centerpiece, and it is why it exists.
  The live runs are then **watched**, not re-run: the explorer links in [`DEPLOYMENTS.md`](DEPLOYMENTS.md) and the
  proof video.
- **Or stand up an entirely fresh deployment of your own** — a free iyzico sandbox account
  (`sandbox-merchant.iyzipay.com`) for the fiat leg, plus your own testnet pool via `just bootstrap`. Note that
  `just bootstrap` refuses while the committed `deployment.testnet.json` names a live pool (the one-pool guard), so
  this means pointing that record at your own fresh deployment first — a deliberate act, not a clone-and-run.

## Prerequisites

- Toolchain per [`README.md`](../README.md): Node 22, pnpm, Rust + `wasm32v1-none`, stellar CLI 26.0.0, `just`.
- **iyzico sandbox account** — register free at `sandbox-merchant.iyzipay.com`, copy `apiKey` + `secretKey` into
  `.env`. (The signed server-to-server notification webhook is deferred — settlement is driven by the poll worker's
  authenticated pull, so no dashboard webhook config is needed for this run.)
- **A public tunnel — only if the browser and the backend are on different machines.** See Step 3 for what
  `TROIA_CALLBACK_URL` is and how to set it; a same-machine run needs no tunnel.
- `.env` filled from `.env.example` (see the secret list there). `.env` is git-ignored; `deployment.testnet.json`
  is **committed** — it holds only public identifiers, and it is the one deployment everything settles against.
- **`just serve` also requires `TROIA_ISSUER_SECRET`** — the USDC-SAC admin key that signs the rebalance mint,
  **separate from the operator payout key**; boot fails **closed** without it. `just preflight` (Step 2) checks
  this key and its XLM balance up front, so a missing/wrong issuer key is caught before the run, not mid-demo.

---

## Step 1 — Point at the deployed rails

Troia settles against ONE deployed `TroyPool` (see [`DEPLOYMENTS.md`](DEPLOYMENTS.md)). With its
`deployment.testnet.json` and the matching secrets in `.env`:

```bash
just fund     # asserts the pool is still on chain, tops up fee XLM, and points the storefront + the extension
              # at it (`scripts/wire-apps.mjs`). It never deploys a pool.
```

If there is no deployment at all — the first one ever, or the testnet was reset and erased the contract — then
`just bootstrap` creates it. It refuses while a live pool is recorded, because a second pool orphans the first.

Either way the last step rewrites `app/storefront/src/deployment.generated.ts` and
`app/extension/src/lib/deployment.generated.ts` (committed files holding public identifiers only), so the apps
follow the deployment rather than a hard-coded address. **Rebuild the extension afterwards** — its config is
compiled in, and a stale build would reject the deployment's own USDC and never show the banner:

```bash
cd app/extension && npm run build   # then load app/extension/dist as an unpacked extension
```

Re-run `just wire` on its own if you ever change the deployment without re-funding.

## Step 2 — Preflight: is everything up? (readiness gate)

```bash
just preflight
```

This smokes every live dependency **in isolation** and prints a green/red report — exit `0` = ready, exit `1` =
fix the reds first. It checks: the operator key matches the deployment, the operator has XLM for fees, the issuer
key matches the deployment, the issuer has XLM for fees (the rebalance bot's SAC mint needs it), the pool holds
USDC (`readSacBalance`), the CEX spot oracle returns a mid, the Yahoo history returns closes, and iyzico is
reachable with your creds (a no-charge probe — it creates no checkout form). **Do not proceed until this is green.**

## Step 3 — Set the callback URL

iyzico redirects the customer's **browser** to this address after payment. The settlement itself is driven
separately by the poll worker's server-side pull, so this is a landing page and nothing more.

If the browser runs on the same machine as the backend — the usual local case — point it straight at localhost.
The sandbox **accepts a plain `http://localhost:3000/return`** (measured: `initializeCheckoutForm` returns
`status: success`), so this needs no tunnel:

```
TROIA_CALLBACK_URL=http://localhost:3000/return
```

If the browser is elsewhere, open a tunnel in a dedicated terminal and use its https URL instead. Both proven runs
did this:

```bash
cloudflared tunnel --url http://localhost:3000     # prints a public https URL, e.g. https://abc-xyz.trycloudflare.com
```

```
TROIA_CALLBACK_URL=https://abc-xyz.trycloudflare.com/return
```

## Step 4 — Serve

```bash
just serve
```

The backend reads `.env` + `deployment.testnet.json`, **seeds the pool balance + operator sequence from the chain**
(two live reads), stands up Fastify, and starts the poll worker **and the TRY-driven rebalance bot** —
`settleTick`, scheduled on `SETTLEMENT_TICK_MS` (default 5s); it logs `troia rebalance bot armed — demo valör 30s,
tick 5000ms`. After a money-good order's demo valör (the real iyzico valör is ~21 days, **compressed to
`DEMO_VALOR_SECS`, default 30s**, so the refill is visible in the demo) the bot refills the pool from that order's
collected TRY at the live oracle rate via a **real issuer-signed USDC SAC mint** (signed by the separate issuer
key). On mainnet the same seam becomes a real CEX buy driven by a future agent + on/off-ramp service. It logs
`listening ... webhook -> <url>`. A bad env value fails the boot **closed** (never a silent degrade). Leave it running.

## Step 5 — Drive one real charge

The built storefront + Chrome "Pay with Troy card" extension are the primary driver (they drove the proven run);
`scripts/intent.mjs` is the headless CLI alternative for a browserless run — it ensures a demo
merchant with a USDC trustline, derives the order memo exactly as the backend does, and POSTs `/intent`:

```bash
node scripts/intent.mjs            # a ledger-nonce order id, 1 USDC  (or: node scripts/intent.mjs my-order 2)
```

It prints the server-computed price (the client cannot dictate it) and writes `demo/checkout.html`. **Open that
file in a browser** and pay with a **Troy sandbox test card** (see iyzico's test cards; the 3DS OTP is shown in
parentheses on the verification screen — enter what it displays).

## Step 6 — Watch it settle

- **Coarse status** (never the crypto leg): `curl -s http://localhost:3000/status/<orderId>` →
  `pending → processing → completed`. The customer's browser lands on the `/return` page after paying; the
  **poll worker** (every `POLL_INTERVAL_MS`) then re-retrieves the sale by its token and drives the USDC
  leg — settlement is this authenticated **pull**, not a browser redirect.
- **The `just serve` logs** show the money-first advance and the `pay()` submit as the worker picks the order up.
- **The explorer** confirms the on-chain truth: the pool balance drops by the amount, the merchant receives USDC,
  and `PaymentMade` carries the derived `tx_id`/`memo`. See [`DEPLOYMENTS.md`](DEPLOYMENTS.md) for the address table.

## Step 7 — Confirm the revert-read shape (done on chain; reproducible)

Only a live reverted `pay()` can confirm the diagnostic-event shape `readContractErrorCode` parses. A double-pay
does **not** produce one: a deterministically-reverting `pay()` fails simulation, so the CLI never submits it and
no reverted tx is created. The way to land one is to change state between simulation and inclusion —
`stage-revert.mjs` does exactly that, pausing the pool (which `pay()` checks first, before any transfer, so no USDC
moves and the books are untouched) and sending a pre-signed `pay()` that then reverts `Paused`:

```bash
node --env-file=.env scripts/stage-revert.mjs   # prints the reverted tx hash (guarantees unpause on every exit)
node scripts/probe-revert.mjs <that hash>
```

Expect it to print `readContractErrorCode  3 (Paused)` (any non-`null` code confirms the read). If it prints
`null` while the tx is `FAILED` with diagnostics, the code sits on a different contractId (SAC vs TroyPool) or
nested in the soroban meta — investigate `collectDiagnosticEvents`. **Either way the money path is safe**: a
`null` re-drives, and the on-chain `Processed(tx_id)` guard is the real double-pay shield.

This was run on 2026-07-14; the reverted tx and the read code are recorded in
[`DEPLOYMENTS.md`](DEPLOYMENTS.md).

---

## Known limits (not blockers — see SCOPE §4)

- **The order rows are single-process; the money facts are not.** See KNOWN_ISSUES §1 for exactly what survives a
  restart and why an order in flight is forgotten safely, never toward a double pay.
- **Oracle quorum is 3-of-3 sources.** A CEX outage fails a quote **closed** (retry), the money-safe default. If a
  source is flaky during the demo, the bounded retry absorbs a blip; a sustained outage needs a retry/pause.
- **The reversal (same-day void) path** is only exercised if a charge succeeds but the USDC leg cannot settle —
  not part of the happy-path smoke.

## Troubleshooting

| Symptom                                 | Likely cause                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just serve` throws on boot             | a missing/blank env var, or the operator secret ≠ deployment operator (run `just preflight`)                                                                                             |
| `/intent` → `409 PoolInsufficient`      | the pool cannot cover the amount — reduce it, or mint more USDC into it with the issuer key (`just fund` does not mint)                                                                  |
| `/intent` → `502 PriceUnavailable`      | the live oracle/history is down — re-run `just preflight` to see which                                                                                                                   |
| the browser shows an error after paying | the tunnel is down or `TROIA_CALLBACK_URL` is stale/not pointing at `/return` — settlement still proceeds via the poll worker regardless                                                 |
| the charge succeeds but no `pay()`      | check the `just serve` logs; the poll worker re-retrieves the sale by token and drives it on each `POLL_INTERVAL_MS` tick (an `UNKNOWN` charge is re-driven, a declined one fails clean) |
