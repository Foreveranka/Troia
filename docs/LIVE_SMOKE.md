# Troia — Live-Smoke Runbook (Phase 4.5 end-to-end)

> **✅ Executed.** This run has been driven end-to-end: a real Troy sandbox card charge automatically drove a real
> on-chain `TroyPool.pay()` (74 USDC pool → merchant, tx
> [`cd643d71…`](https://stellar.expert/explorer/testnet/tx/cd643d7178c6d6068aabe236af45e68fba60d9062d1ff71a85c5af75dfb08ded);
> see [`DEPLOYMENTS.md`](DEPLOYMENTS.md)). This doc remains the runbook for reproducing it.
>
> This is the operational script for the Phase-4.5 live step: a real iyzico charge automatically driving a real
> on-chain `TroyPool.pay()`, behind a public webhook tunnel on testnet. Everything the run needs is wired +
> offline-tested (see [`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md) §4); this doc is how a human actually
> drives it. Honest boundary: **`signed ≠ settled`** — we prove what we signed cryptographically and what settled
> while the chain remembers it.
>
> Nothing here runs in the offline gate. It uses the network and the iyzico **sandbox** (valueless test cards); the
> USDC is our own testnet mint. No real money moves.

---

## What the live run smokes (that offline cannot)

The network-facing halves are type-checked and exercised by fakes offline, but a live run is the first time they
hit a real RPC / the real sandbox. This run smokes:

1. **The dirty Stellar adapters** — `readSacBalance` (pool balance), the `pay()` submit + poll (`getTransaction`,
   `getLedgerEntries`, `getLatestLedger`), and destination trustline load (Horizon).
2. **The iyzico HTTP client** — a real hosted-form init, a real webhook, a real signed callback.
3. **The live oracle inputs** — the CEX spot mid (Binance/Bybit/OKX) and the Yahoo daily-close history, now behind
   per-attempt timeouts + bounded retry (a hung source drops fail-closed, a transient blip retries).
4. **The revert-read shape** (optional, flag-1) — whether a landed-and-reverted `pay()` carries the diagnostic
   events `readContractErrorCode` reads. Only a live reverted tx can confirm this (Step 7).

---

## Prerequisites

- Toolchain per [`README.md`](../README.md): Node 22, pnpm, Rust + `wasm32v1-none`, stellar CLI 26.0.0, `just`.
- **iyzico sandbox account** — register free at `sandbox-merchant.iyzipay.com`, copy `apiKey` + `secretKey` into
  `.env`. (The signed server-to-server notification webhook is deferred — settlement is driven by the poll worker's
  authenticated pull, so no dashboard webhook config is needed for this run.)
- **A public tunnel** — e.g. `cloudflared` (`brew install cloudflared`), `ngrok`, or any https reverse tunnel to
  `localhost`. iyzico must be able to POST the webhook to a public URL.
- `.env` filled from `.env.example` (see the secret list there). `.env` + `deployment.testnet.json` are git-ignored.

---

## Step 1 — Deploy the rails (once)

If there is no `deployment.testnet.json` yet (or the testnet was reset):

```bash
just fund     # generates/funds 3 keypairs, deploys the USDC SAC + a fresh TroyPool, mints the 100,000 USDC seed,
              # writes deployment.testnet.json + .env (both git-ignored). See docs/DEPLOYMENTS.md.
```

## Step 2 — Preflight: is everything up? (readiness gate)

```bash
just preflight
```

This smokes every live dependency **in isolation** and prints a green/red report — exit `0` = ready, exit `1` =
fix the reds first. It checks: the operator key matches the deployment, the operator has XLM for fees, the pool
holds USDC (`readSacBalance`), the CEX spot oracle returns a mid, the Yahoo history returns closes, and iyzico is
reachable with your creds (a no-charge probe — it creates no checkout form). **Do not proceed until this is green.**

## Step 3 — Open the tunnel, set the callback URL

In a dedicated terminal:

```bash
cloudflared tunnel --url http://localhost:3000     # prints a public https URL, e.g. https://abc-xyz.trycloudflare.com
```

Put that URL + `/return` into `.env` (iyzico redirects the customer's browser here after payment; the actual
settlement is driven separately by the poll worker's server-side pull, so this is just a friendly landing page):

```
TROIA_CALLBACK_URL=https://abc-xyz.trycloudflare.com/return
```

## Step 4 — Serve

```bash
just serve
```

The backend reads `.env` + `deployment.testnet.json`, **seeds the pool balance + operator sequence from the chain**
(two live reads), stands up Fastify, and starts the poll/recovery worker. It logs `listening ... webhook -> <url>`.
A bad env value fails the boot **closed** (never a silent degrade). Leave it running.

## Step 5 — Drive one real charge

The storefront (5.1) is the eventual driver; until then, `scripts/intent.mjs` stands in — it ensures a demo
merchant with a USDC trustline, derives the order memo exactly as the backend does, and POSTs `/intent`:

```bash
node scripts/intent.mjs            # a ledger-nonce order id, 1 USDC  (or: node scripts/intent.mjs my-order 2)
```

It prints the server-computed price (the client cannot dictate it) and writes `demo/checkout.html`. **Open that
file in a browser** and pay with a **Troy sandbox test card** (see iyzico's test cards; 3DS mock OTP `123456`).

## Step 6 — Watch it settle

- **Coarse status** (never the crypto leg): `curl -s http://localhost:3000/status/<orderId>` →
  `pending → processing → completed`. The customer's browser lands on the `/return` page after paying; the
  **poll/recovery worker** (every `POLL_INTERVAL_MS`) then re-retrieves the sale by its token and drives the USDC
  leg — settlement is this authenticated **pull**, not a browser redirect.
- **The `just serve` logs** show the money-first advance and the `pay()` submit as the worker picks the order up.
- **The explorer** confirms the on-chain truth: the pool balance drops by the amount, the merchant receives USDC,
  and `PaymentMade` carries the derived `tx_id`/`memo`. See [`DEPLOYMENTS.md`](DEPLOYMENTS.md) for the address table.

## Step 7 — (optional) Confirm the revert-read shape (flag-1)

Only a live reverted `pay()` can confirm the diagnostic-event shape `readContractErrorCode` parses. Force one with
the CLI (a second `pay()` with the same `tx_id` reverts `AlreadyProcessed`), then:

```bash
node scripts/probe-revert.mjs <txHashOfTheRevertedInvocation>
```

Expect `readContractErrorCode -> 1 (AlreadyProcessed)`. If it prints `null` while the tx is `FAILED` with
diagnostics, the code sits on a different contractId (SAC vs TroyPool) or nested in the soroban meta — investigate
`collectDiagnosticEvents`. **Either way the money path is safe**: a `null` re-drives, and the on-chain
`Processed(tx_id)` guard is the real double-pay shield.

---

## Known limits (not blockers — see SCOPE §4)

- **`InMemoryStore` / `InMemoryJournal` are single-process.** Correct for a one-process live-smoke; a restart loses
  the in-flight witness, which fails **safe** (re-drive; never a double pay). A durable store is the mainnet swap.
- **Oracle quorum is 3-of-3 sources.** A CEX outage fails a quote **closed** (retry), the money-safe default. If a
  source is flaky during the demo, the bounded retry absorbs a blip; a sustained outage needs a retry/pause.
- **The reversal (same-day void) path** is only exercised if a charge succeeds but the USDC leg cannot settle —
  not part of the happy-path smoke.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `just serve` throws on boot | a missing/blank env var, or the operator secret ≠ deployment operator (run `just preflight`) |
| `/intent` → `409 PoolInsufficient` | the pool cannot cover the amount — reduce it or re-`just fund` |
| `/intent` → `502 PriceUnavailable` | the live oracle/history is down — re-run `just preflight` to see which |
| the browser shows an error after paying | the tunnel is down or `TROIA_CALLBACK_URL` is stale/not pointing at `/return` — settlement still proceeds via the poll worker regardless |
| the charge succeeds but no `pay()` | check the `just serve` logs; the poll worker re-retrieves the sale by token and drives it on each `POLL_INTERVAL_MS` tick (an `UNKNOWN` charge is re-driven, a declined one fails clean) |
