# Channel accounts — the parallel-payout design (A-5)

> Status: **designed, groundwork landed, NOT wired**. The `ChannelPoolProvider` (per-order sticky channel
> assignment over per-channel `SequenceAllocator`s, fail-closed bare-seq disambiguation) lives in
> `@troia/core` with its own suite; the engine still runs the single-operator allocator. This page is the
> full mechanism and the honest list of what must change before channels go live — the remaining work is a
> deliberate, separately-reviewed step because it touches the double-pay shield and the signing pipeline.

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

### The remaining work, in order

1. **Signing:** channel `Signer`s (envelope) + operator auth-entry signing in the submit path;
   `assemble.ts` learns the address-credential shape behind an explicit "channel mode" (the source-account
   guard stays for the single-operator mode). Re-derive the persist-then-send ordering and its tests.
2. **Threading:** `channelPublic` through `OrderCtx` / ctx codec / `InFlightPatch` / observe / poll worker.
3. **Wiring:** `TROIA_CHANNEL_SECRETS` (comma-separated S-keys) → validate against chain, read each
   channel's live seq at boot (same bootstrap discipline as the operator), build the pool + durable
   channel-map/seq stores in `orders.db`.
4. **Ceremony:** `just add-channels N` — create + fund N channel accounts from the operator (XLM for fees
   only; channels never hold USDC and never gain contract authority — a leaked channel key can burn fees,
   not move the pool).
5. **Proof:** live drills on testnet (D-18 scope): parallel payouts landing in one ledger, a channel-side
   crash/recovery, a dead-then-replaced tx on a channel, ambiguity handling under same-ledger creation.

### Sizing

Deferred D-16 (load/soak) was to supply this number; until it runs, start with **5** channels (≈5×
throughput, trivial XLM cost) and revisit with real traffic data.

## Why it is safe to ship the groundwork now

Nothing is wired: the engine's `SequenceProvider` is still the single-operator `SequenceAllocator`, whose
behavior (and the one-source-account fail-closed guard in `assemble.ts`) is unchanged and still covered by
the existing suites. The pool ships tested but dormant, so the review of the dangerous half — signing and
deadness — happens on its own, small diff.
