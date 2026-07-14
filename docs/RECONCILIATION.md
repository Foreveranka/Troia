# Troia — Reconciliation (the reviewer-verifiable centerpiece)

> **You do not have to trust our verdicts.** Every settlement carries its own cryptographic evidence, and a single
> offline command re-derives the verdict of every order from that evidence — pinning each signature to an operator
> key supplied from OUTSIDE the report, not to the key the report names, so a self-signed forgery cannot pass.
> `just verify-live` pins to Troia's canonical operator (the committed deployment record) for a REAL payout, leaving
> you one check: open its `tx_hash` on the explorer. If our claim disagrees with the math, the command fails. This
> document explains what is proven, how, and how to check it yourself in ~10 seconds.

Honest proof boundary, stated up front: **`signed ≠ settled`.** We prove what we _signed and submitted_ with
cryptography that survives a link rot or a testnet reset; we prove what _settled on-chain_ only while the chain
still remembers it. The reconciler never blurs the two — an order whose chain record is gone is reported
`UNSETTLED`, never silently "matched".

---

## 1. Why this exists

Troia is custodial: a Turkish user pays TRY, and we pay the merchant USDC from a pre-funded Stellar pool. A
reviewer's fair question is _"how do I know a lira was accounted for, and that you did not quietly lose or
misroute money?"_ The answer is not "read our logs and trust them." The answer is a self-verifying artifact:
`recon-report.json` embeds, per order, the signed transaction we submitted plus the chain observation, and
`just verify` recomputes each order's **verdict** from that embedded evidence with **no network and no database
access** — proving the report is self-consistent and that its signatures verify against the operator key the
verifier is pinned to (an external value, never the report's own field). It runs the demo corpus; `just verify-live`
is the one that pins to Troia's canonical operator on a real payout. Neither queries Horizon, so neither proves —
on its own — that the tx settled on-chain.

The reconciler is **keyless by construction and cannot build a transaction**: it imports `@stellar/stellar-base`
only to _decode and verify_, never to sign or assemble one (enforced by a grep-provenance test,
`no-signing-in-src.spec.ts`). It cannot forge evidence because it holds no key.

---

## 2. The three-artifact model

Per order, three independent records — deliberately from three different trust domains:

| Artifact                  | Source                                                                                | Trust property                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) `business_intent`** | our local order record (`destination` / `amount_stroops` / `memo_hex`)                | **Mutable.** "This is what was requested." A diff's `local_value` always comes from here.                                                                                   |
| **(b) `ledger_evidence`** | `signed_xdr` + its Stellar `hash`                                                     | **Frozen cryptographic witness.** "This is what we signed and submitted." Never re-serialized from (a) — corrupting the local record cannot silently rewrite the signature. |
| **(c) `chain_evidence`**  | `tx_hash` + `fetched_at_ledger` + a normalized `horizon_snapshot` of the `pay()` call | **Frozen chain observation.** "This is what the chain looked like when we watched it."                                                                                      |

The `hash` in **(b)** is the **real Stellar transaction hash** — `hex(Transaction(signed_xdr, passphrase).hash())`
= `sha256(networkId ‖ ENVELOPE_TYPE_TX(0x00000002) ‖ xdr(innerTx))`, **not** `sha256(envelope)` nor
`sha256(decoded tx)` (empirically distinct). An optional `blob_sha256` is a pure integrity tripwire, never equated
to the tx hash (identity ≠ integrity).

The signed blob **(b)** is the cryptographic tiebreaker between the mutable local row **(a)** and the observed
chain **(c)**. The report carries two top-level fields, read as **data**, never from the mutable XDR:

- `network.passphrase` — needed to recompute the real Stellar transaction hash.
- `network.operator_public` — the signer key the report names, **read as data and NOT trusted**: the verifier
  re-derives every signature against an operator key supplied from OUTSIDE the report (the runner's
  `TROIA_OPERATOR_PUBLIC`, else `deployment.testnet.json` — the committed record the verifier actually reads; the
  same identities are published for humans in [`DEPLOYMENTS.md`](DEPLOYMENTS.md)) and fails the
  report if its named key differs. `just verify-live` runs with the canonical deployment operator; the demo corpus
  (`just verify`) is pinned to a throwaway seed-derived signer, since the real operator secret is never committed.
  Either way a forged report cannot name and self-sign with an attacker's key and pass. The signature is selected
  _by hint_; any hint-matching signature that verifies over `tx.hash()` passes (this is the multisig seam for later).

The operator key answers **who signed** — never **where the money went**, and the report cannot answer that about
itself. `contract_id` appears twice inside a report (in the signed XDR and in the snapshot) and the cascade only
ever compares those two to _each other_, so an operator-signed `pay()` to a look-alike contract — one the operator
deployed, holding no pool funds — is perfectly self-consistent and re-derives to `MATCHED` while the canonical
TroyPool never moves a stroop. So the verifier takes a **second anchor from outside the report**, resolved by the
same rule as the first (`TROIA_TROY_POOL`, else `deployment.testnet.json`'s `troyPool`): every order's
`pay()` must invoke the canonical TroyPool, checked on **both** sides — the decoded XDR _and_ the chain snapshot.
Anything else fails the report. Signature ∧ contract: authorship _and_ destination, both pinned to a record the
report cannot touch.

The diff maps `business_intent.destination ⇄ pay() merchant` (arg 3), `amount_stroops ⇄ i128` (arg 1), and
`memo_hex ⇄ BytesN<32>` (arg 4). `applied_rate` is carried in the snapshot but **excluded** from the diff — the
accounting ledger is its audit source, not the reconciler.

---

## 3. The verdict cascade (total, ordered, role-split)

`resolveGroundTruth` is a single, ordered decision procedure. The order is load-bearing: tamper detection (is
the witness authentic?) is split from divergence detection (did a _different_ tx settle?), so every verdict
stays reachable and `CORRUPT_LOCAL` can only be reached _after_ the signature is proven valid.

Let `S` = the transaction's source **is** the pinned operator **and** its signature verifies over `tx.hash()` — a
transaction the operator merely co-signed, sourced from another account, does not satisfy `S`; `HB` = recomputed
hash == recorded hash;
`BC` = recorded hash == chain `tx_hash` (bitwise); `DC` = decoded call == chain snapshot (semantic);
`IC` = local intent == chain snapshot (semantic).

```
1. decode fails / not a Transaction / func ≠ pay()   ⇒ EVIDENCE_TAMPERED   (the witness itself is forged)
2. !S   (bad / absent operator signature)            ⇒ EVIDENCE_TAMPERED
3. !HB  (blob ↮ recorded hash)                        ⇒ EVIDENCE_TAMPERED
   ── after 1–3, (b) is an authentic, self-consistent operator witness ──
4. chain_evidence == null                            ⇒ UNSETTLED          (signed proven; settlement NOT)
5. !BC || !DC  (a DIFFERENT tx settled)              ⇒ CHAIN_DIVERGENCE   (signed ≠ settled)
6. IC                                                ⇒ MATCHED
7. else                                              ⇒ CORRUPT_LOCAL      (authority = chain; only reachable with S∧HB∧BC∧DC)
```

Verdict → customer-facing status: `MATCHED → matched`; `CORRUPT_LOCAL | EVIDENCE_TAMPERED | CHAIN_DIVERGENCE
→ mismatch`; `UNSETTLED → unsettled`.

The subtle, important one is **`CORRUPT_LOCAL`**: it is reachable _only_ after `S ∧ HB ∧ BC ∧ DC`, so it always
carries `signature_valid == true`. It means the signed evidence and the chain agree with each other, and only
our _mutable local row_ disagrees — i.e. **the chain is the authority and our DB copy is the corrupt one.** That
is exactly the case a reviewer should want caught, and it is caught with the cryptographic evidence intact.

---

## 4. The seeded fixture, walked through

The committed fixture (`packages/reconciler/test/fixtures/recon-report.json`, seed `troia-demo-0001`,
operator `GA6C2W6O…E52K`) contains three orders:

| Order     | Local amount        | Chain amount           | Verdict           | `signature_valid` | Meaning                                                                                                                                   |
| --------- | ------------------- | ---------------------- | ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ord-001` | 10000000 (1.0 USDC) | 10000000               | **MATCHED**       | true              | Intent, signature, and chain all agree.                                                                                                   |
| `ord-002` | 25000000 (2.5 USDC) | 25000000               | **MATCHED**       | true              | Same — a clean settlement.                                                                                                                |
| `ord-003` | 6000000 (0.6 USDC)  | **5000000 (0.5 USDC)** | **CORRUPT_LOCAL** | true              | The signed tx + chain agree on 0.5 USDC; only the local order record claims 0.6. The chain wins; the discrepancy is surfaced, not hidden. |

`ord-003` is the deliberate mismatch — the "demo hero". Its `field_diff` records `amount: local 6000000 ≠ chain
5000000`, its verdict is `CORRUPT_LOCAL`, and crucially `signature_valid` is still `true`: the evidence proves
the discrepancy is in our records, not in what actually settled.

Summary: `{ total: 3, matched: 2, mismatch: 1, unsettled: 0 }`.

---

## 5. Verify it yourself

```bash
just verify
```

This builds `@troia/reconciler`, then runs the verifier under an in-process network block. The demo corpus is
signed by a throwaway seed-derived operator and settles through a throwaway seed-derived pool (the real operator
secret is never committed), so the verifier is pinned to that corpus pair via `TROIA_OPERATOR_PUBLIC` and
`TROIA_TROY_POOL` — external, committed constants, never the report's own fields. `just verify-live` instead
defaults to **both** canonical deployment anchors, so it proves the real payout was signed by the canonical
operator _and_ settled through the canonical TroyPool, with no override to get wrong.

```
TROIA_OPERATOR_PUBLIC=GA6C2W6OPOJJYIRCG3QSMTD7MZVBTVQM6QATLOPVGXI2AIUGXCSNE52K \
TROIA_TROY_POOL=CBE4G2FHXZGGEYNUTBAICHPKMMVGJBF4757GY5IRBLMRP3O42CLCYPHB \
node --import ./packages/reconciler/bin/block-net.mjs \
     ./packages/reconciler/bin/verify.mjs \
     ./packages/reconciler/test/fixtures/recon-report.json
```

Observed output (exit code `0`):

```json
{
  "ok": true,
  "summary": { "total": 3, "matched": 2, "mismatch": 1, "unsettled": 0 },
  "ordersVerified": 3,
  "networkAttempts": 0,
  "failures": []
}
```

**The exit code is a _positive_ proof, not mere absence of error.** `bin/block-net.mjs` is preloaded before any
app module and patches `net` / `tls` / `dns` / `http(s)` / `http2` / `dgram` / `fetch` / `WebSocket` to throw and
count attempts. `bin/verify.mjs` then requires all of: a startup **canary** (a deliberate `net.connect` must
throw, proving the block is armed — "did not call out" is upgraded to "the block is active"), `ordersVerified
=== N`, `networkAttempts === 0`, and every re-derived verdict / status / summary equal to what the report
stored. `crypto` is left intact so Ed25519 verify and sha256 keep working — the proof is that the _network_ path
was never reached, computed purely from the embedded data.

### The verifier does not trust the stored verdicts

`verifyReport` ignores the report's own `verdict` / `status` fields and **recomputes** each from the embedded
evidence, then asserts the stored values equal the recomputation. The `summary` is then re-derived from those
per-order statuses — which is sound precisely because each one was already proven equal to its recomputation a
step earlier, so a forged status cannot survive to be counted. A single mismatch fails the whole report. To see
the failure mode:

```bash
just verify-tampered
```

It forges the honest report **in a temp file** — flipping `ord-003`'s stored verdict _and_ status to `MATCHED`
and the summary to `{matched:3, mismatch:0}` — then runs the same network-blocked verifier over the forgery.
Nothing is written into the repo, so this runs on a bare clone in any order.

Two exit codes are in play, and they mean opposite things: `just verify-tampered` (the outer wrapper script)
exits **`0`**, because successfully catching a tamper is the expected, correct outcome; the **inner** verifier's
exit — captured in the `verifierExit` field below — is `1`, because it read the forged report and the
recomputation disagreed. `verifierExit: 1` is the recorded evidence that the catch actually happened, not a
process failure. Observed output:

```json
{
  "tamperDetected": true,
  "verifierExit": 1,
  "ok": false,
  "summary": { "total": 3, "matched": 3, "mismatch": 0, "unsettled": 0 },
  "ordersVerified": 3,
  "networkAttempts": 0,
  "failures": [
    "ord-003: verdict MATCHED != recomputed CORRUPT_LOCAL",
    "ord-003: status matched != recomputed mismatch"
  ]
}
```

`verifierExit: 1` is the load-bearing field. `bin/verify.mjs` exits `1` when it **read** the report and the
recomputation disagreed, and `2` when it could not read the report at all. A check that accepted any non-zero
exit would pass on a missing file while proving nothing, so `just verify-tampered` pins the distinction.

A report that lies about its own outcome cannot pass. That is the whole point.

### The strongest proof: reconcile a real on-chain payout, offline

```bash
just verify-live   # re-derives the verdict, no network, from a REAL landed testnet payout's embedded evidence
```

`recon-report.live.json` captures a real operator-signed `pay()` that landed on testnet (tx `5a3d60cc…`, `TroyPool`
`CCVNY6H…`); `just verify-live` re-verifies it **MATCHED** offline (`networkAttempts:0`) — same model, real chain
evidence, pinned to the canonical operator by default (no override). It is **network-blocked exactly like
`just verify`**: "live" names the report's provenance (a real landed tx), not a live query — nothing in the
just-verify family touches Horizon, so confirming the tx actually landed stays a manual explorer check
(`signed ≠ settled`). `just demo` runs the full loop end-to-end: N real testnet `pay()`s → a fresh
`recon-report.json` → the offline verify above (one order is a deliberate `CORRUPT_LOCAL` the reconciler catches).

---

## 6. The other reconciliation: the one the server does to itself

Everything above is the **artifact** a reviewer verifies offline, after the fact. The running server also
reconciles **continuously, against the live chain**, and does not trust anything it announced. Two loops do this —
a **payout tail** that attributes every outflow, and a **live reconciler** that confirms each settlement. Their
operational mechanics (attribution, coverage, alarm latching, the RPC facts they are built on) are in §8; this
section is the reconciler's **decision**: did each order's settlement actually happen, and was it the one we
announced?

It finds each order's settlement through the contract-indexed **`tx_id`** — the identifier the _contract_ indexes,
derived from `order_id` alone (`sha256(lp("troia.txid.v1") ‖ lp(order_id))`) and recomputed independently by
`deriveIds` — **not** the transaction hash we recorded. Looking up by our own hash would only check our record
against itself, which is what made `CHAIN_DIVERGENCE` unreachable in practice.

**Five checks, all of which must pass before an order is marked `Reconciled`:**

1. The settlement is **found under that `tx_id`.** Not found is not an accusation — it is a coverage / blind case
   (§8) or still-waiting, never a theft claim.
2. The pool's code was **never replaced** — an `upgrade()` latches `POOL CODE REPLACED`, and past announcements
   stop being proofs.
3. The **announced amount equals what the token contract actually moved** (`payment_made.amount` ⇄ Σ `transfer`).
4. The transaction is **still live on chain** (`checkTxLiveness`; `ABSENT` ⇒ `UNSETTLED`).
5. `resolveGroundTruth` (§3, the same cascade) returns `MATCHED`.

An unreachable chain (`UNKNOWN`) **never concludes anything** — it re-polls, never guesses. `reconciled.mark()` is
written durably **before** the order advances, so a crash between the two re-marks rather than double-advances.

Both loops have run against the live chain, reconciling a real payout by finding it under its contract-indexed
`tx_id` (`f11336a3e231fde6…`, recomputed independently by `deriveIds`, so the lookup is independent of our own
records) — with no false theft accusation, including after a restart that erased the in-memory order registry. The
concrete run (order, amount, tx hash) and what it did **not** prove are in [`DEPLOYMENTS.md`](DEPLOYMENTS.md).

---

## 7. Reset-proof and honest about it

- The **signed parts are self-verifying forever**: `signature_valid` and `hash_consistent` are recomputed from
  the embedded `signed_xdr` + pinned key + passphrase, with no dependency on any live service. A dead explorer
  link or a wiped testnet does not weaken them.
- The **chain-observed part is only as durable as the chain's memory.** If the chain record is gone (testnet
  reset, or the tx never landed), the order resolves to `UNSETTLED` — signed proven, settlement not. We never
  claim "settlement is provable after reset."
- The committed demo fixture tx is a **real, decodable Soroban `pay()` invocation with no execution footprint**,
  so it is genuinely verifiable but not itself network-submittable. A **real operator-signed `pay()` has already
  landed on testnet** (tx `5a3d60cc…`, `TroyPool` `CCVNY6H…`), captured verbatim as
  `recon-report.live.json` and re-verified reset-proof with `just verify-live` — same model, real chain evidence.

**Bottom line for a reviewer:** clone the repo and run `just verify` — it passes on the honest demo corpus. Then run
`just verify-tampered`, which forges that same report in a temp file and proves the verifier **rejects** it (the
inner verifier exits `1`; the check itself exits `0` because catching the forgery is the pass condition — §5).
Together they prove the reconciler logic offline, in seconds. Then run `just verify-live`: it re-derives a REAL
payout pinned to our canonical operator (from the committed `deployment.testnet.json`), leaving one check the
offline run cannot do for you — open that `tx_hash` on the explorer to confirm it landed (`signed ≠ settled`).

---

## 8. The live loops — payout tail & reconciler

§6 is the reconciler's verdict. This is how the two running-server loops _operate_ against the live chain, and how
they handle the one thing an honest monitor must never fake: uncertainty. Both read the chain; neither trusts what
we announced.

**The payout tail (`tailOutflows`, `OUTFLOW_INTERVAL_MS`, default 20s)** — attribution for money leaving the pool.

- It watches the **USDC SAC's `transfer` events with `from == pool`**, not the pool's own `payment_made` event. An
  `upgrade()` could let replaced contract code drain the pool without ever emitting `payment_made`; the token
  contract cannot be talked out of emitting `transfer`.
- **Why it may accuse.** The write-ahead journal (`authorized.log`) is durable and is awaited **strictly before**
  `send`, so a `pay()` cannot land — and so cannot emit an outflow — unless its hash was already on disk. An outflow
  whose hash is absent was **never authorized** — not "not yet witnessed", not "still settling". There is no timing
  window to get wrong and no in-memory allowlist for a restart to erase. That outflow is a `ROGUE PAYOUT`.
- Grace (chain **close time**, never the local clock; `outflowGraceSecs`, default **60s**) is a margin, not the
  correctness mechanism; a suspect is re-judged each tick and pages exactly **once**. Do not confuse it with the
  reconciler's `unsettledGraceSecs` (default 600s), which bounds how long an announced settlement may stay
  unobserved before `SETTLEMENT UNOBSERVABLE`.
- **Durable order per tick:** record the observation → mark the suspect → tombstone the cleared → _save the cursor
  last_. A crash mid-tick re-reads a page (harmless); a cursor advanced past an unrecorded suspect would lose a
  theft forever.
- It complements the solvency drift tripwire rather than replacing it. Drift is windowless and always right about
  the **total** but cannot name a transaction; the tail names it, and pays with a window — Soroban RPC retains
  events for a rolling ~7 days **that moves**, so a tail down longer than the window has a gap. The gap is declared
  (`TAIL BLIND SPOT` / `TAIL STALLED`), never hidden, and drift covers it.

**"We cannot see" is not "it is not there."** The tail durably records a **coverage floor**: the instant it began
(or, after a retention re-anchor, resumed) watching. An order witnessed before that floor settled in ledgers nobody
read, so its missing announcement is a fact about us — reported as `blind / never-watched`, never `SETTLEMENT
UNOBSERVABLE`. Likewise, when we hold the pool's announcement but the RPC will no longer return the transaction
(retention, a reset, or it never landed — `NOT_FOUND` cannot tell them apart), that is `blind / aged-out`, not an
accusation. Only silence **inside** the watched window, past the grace, is an alarm; the drift tripwire remains the
cover for value that actually went missing.

**Alarms latch.** The audit re-derives every verdict each tick, so a stuck order would otherwise restate its problem
forever, and a page repeated forever is a page nobody reads. `observeReconcile` (pure, mirroring `observeDrift` /
`observeTailHealth`) pages each order **once per problem**, keyed on _what_ is wrong — so silence that becomes a
divergence pages again — and logs one line when the problem clears. `unreachable` is deliberately neither: it cannot
raise a page, and it cannot forge an all-clear for an alarm it was unable to re-check.

**RPC facts these loops are built on, measured against live testnet, not read from a doc:** a topic filter with the
wrong arity returns an **empty page with no error** (a silent all-clear — hence contract-id-only filters); `-32600`
means **both** "below retention" and "ahead of head", so the range is probed **structurally** rather than matched
against the message text; a cursor resumes **strictly after** its ledger.
