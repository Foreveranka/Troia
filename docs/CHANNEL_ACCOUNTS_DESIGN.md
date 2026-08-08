# Channel accounts — the parallel-payout design (A-5)

> Status: **LIVE-PROVEN on testnet, `2026-08-08`** — two concurrent payouts settled through two different
> channel tx sources (ledgers `4035197`/`4035200`; see DEPLOYMENTS.md "Channel accounts live drill" for the
> transaction evidence and the reconciler gap the drill caught and fixed). The crash variant also passed the
> same day: an order PAID WHILE THE PROCESS WAS DEAD was recovered on restart and settled through channel-3
> (tx `ec76e640…`, ledger `4035346`) — the KNOWN_ISSUES §1 window closed by live proof. Original pre-drill
> status, kept for history: implemented and wired, awaiting the live testnet drill. Everything on this page is built and
> offline-tested: the pool provider, the channel-sourced signing path (operator auth as signed
> address-credential entries), the per-channel deadness reads, the durable seq snapshots + sticky
> order->channel map in `orders.db`, the `TROIA_CHANNEL_SECRETS` wiring and the `just add-channels`
> ceremony. Channel mode turns on only when `TROIA_CHANNEL_SECRETS` is set; without it, the single-operator
> path is byte-for-byte unchanged (pinned by tests). What remains is the LIVE PROOF on testnet — see "The
> live drill" at the bottom; until it has been run, do not rely on channel mode.

## The problem

Every `pay()` is signed with the operator account's sequence number, and a Stellar account has ONE strictly
sequential seq space — worse, Soroban admits **one transaction per source account per ledger**. So the whole
system settles at most one payout per ledger (~5s), a ceiling of roughly 2–4/min regardless of hardware.

## The mechanism

N pre-funded **channel accounts**. Each `pay()` transaction uses a FREE channel as its **tx source** (the
channel pays the fee and provides the sequence); the operator remains the only key that can authorize the
contract call. K channels ⇒ K payouts per ledger.

### What the exploration established (why this is bigger than "swap the allocator")

1. **Authorization changes shape.** `TroyPool.pay()` does `read_operator().require_auth()`. Today the
   operator IS the tx source, so simulation returns a **source-account** credential and the tx-level
   signature satisfies it — `assemble.ts` deliberately FAILS CLOSED on anything else. With a channel as tx
   source, the operator's authorization becomes an **address-credential `SorobanAuthorizationEntry`**:
   nonce + `signature_expiration_ledger` + an explicit operator signature over the auth preimage
   (`authorizeEntry`). The fail-closed guard in `assemble.ts` is not an obstacle to delete casually — it is
   the pin that keeps this redesign a conscious act.
2. **The write-ahead hash discipline must be re-derived.** Today `hashOf(assembled)` is deterministic
   before signing (source-account entries carry no nonce) and is persisted BEFORE any send. Address
   credentials add a nonce and an expiration ledger, and the entry signature is part of the tx body —
   the pre-submit journal must therefore persist the hash **after auth-entry signing** (still strictly
   before broadcast, preserving the SPIKE-2 contract: a crash leaves a byte-exact resubmittable artifact).
3. **Deadness becomes per-channel.** The deadness proof reads "the SOURCE account's on-chain seq has moved
   past ourSeq AND closeTime > maxTime" — today that read is `readAccountSeq(operatorPublic)`. With
   channels it must read the order's OWN channel, so the channel identity has to ride with the order:
   `OrderCtx` (and its codec) gains `channelPublic`, the observe `ReducerState` gains it, and the poll
   worker's rebuild paths thread it through.
4. **Sequence numbers stop being globally unique.** A Stellar account's starting seq derives from its
   creation ledger — channels funded in one ledger start at the SAME number. Everything keyed on a bare
   seq had to learn this: `SequenceProvider.confirmBurned` now takes the orderId (landed with the
   groundwork), and the pool refuses to guess when a bare number is ambiguous.
5. **Stickiness is money-critical.** The per-account sequence shield only protects an order if every retry
   rides the SAME channel. The pool assigns a channel once per order, persists the assignment (it must
   survive a restart exactly like the seq snapshots), and `reallocate` stays on the assigned channel.

### How the implementation resolved each point

1. **Signing** — `Signer.signAuthEntry` (implemented by `LocalKeySigner` via `authorizeEntry`);
   `assembleWithSignedAuth` accepts ONLY signed, operator-addressed, address-credential entries (unsigned /
   foreign / source-account entries are refused before anything is hashed); `client.submitPay` in channel
   mode runs build(source=channel) → simulate → operator-signs each entry (`validUntil = head + 120`
   ledgers) → assemble → hash → channel-signs the envelope → **persist → send**. The write-ahead contract
   holds: the persisted artifact includes the signed entries (they are tx body), so it is still byte-exactly
   resubmittable. The original `assembleFromSimulation` guard is untouched for single-operator mode.
2. **Threading** — `OrderCtx.channelPublic` (ctx codec v2; v1 rows decode as null), `InFlightPatch` +
   both stores' order rows, `ReducerState.sourcePublic`, and both observe paths (engine + poll worker) read
   the channel's account, never the operator's, for a channel-ridden order.
3. **Wiring** — `TROIA_CHANNEL_SECRETS` (comma/space-separated S-keys) → `buildTestnetServerDeps` builds
   the pool over per-channel `SqliteSequenceStore`s + the `SqliteChannelMapStore` (both in `orders.db`;
   channel seqs chain-seeded on first sight, authoritative thereafter) and hands the channel signers to the
   Stellar client. Channel mode REQUIRES the durable deployment (refused without a dataDir). A side gain:
   the operator allocator's snapshot is now durable too, which closed A-1's last recovery hole (a restarted
   allocator could not `reuseOnDead`/`confirmBurned` a seq it had forgotten).
4. **Ceremony** — `just add-channels N` (default 5): creates + friendbot-funds `troia-channel-<n>` keys via
   the `stellar` CLI and prints the `TROIA_CHANNEL_SECRETS` line for `.env`.

### The live drill (the one unfinished step — run before relying on channel mode)

On a machine with the repo's `.env` (operator/issuer/iyzico secrets) and `just serve` working:

1. `just add-channels 5` → paste the printed `TROIA_CHANNEL_SECRETS=...` line into `.env`.
2. `just serve` → expect `[channels] 5 channel account(s) armed — parallel payouts on`.
3. Fire two+ concurrent orders (`node scripts/intent.mjs a & node scripts/intent.mjs b`), pay both sandbox
   forms quickly, and verify BOTH `pay()`s land in the same or adjacent ledgers (the explorer shows two
   different tx source accounts) and both `/receipt`s carry hashes.
4. Kill `just serve` mid-flight (after a card payment, before settlement) and restart: the order must
   resume on the SAME channel (boot log + `/status` reaching `completed`).
5. Only after 3–4 pass: mark this page's status "live-proven" and note the drill date in DEPLOYMENTS.md.

### Sizing

Deferred D-16 (load/soak) was to supply this number; until it runs, start with **5** channels (≈5×
throughput, trivial XLM cost) and revisit with real traffic data.

## Why it is safe to ship the groundwork now

Nothing is wired: the engine's `SequenceProvider` is still the single-operator `SequenceAllocator`, whose
behavior (and the one-source-account fail-closed guard in `assemble.ts`) is unchanged and still covered by
the existing suites. The pool ships tested but dormant, so the review of the dangerous half — signing and
deadness — happens on its own, small diff.
