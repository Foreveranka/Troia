# Troia — Reconciliation (the reviewer-verifiable centerpiece)

> **You do not have to trust us.** Every settlement carries its own cryptographic evidence, and a single
> offline command re-derives the verdict of every order from that evidence. If our claim disagrees with the
> math, the command fails. This document explains what is proven, how, and how to check it yourself in ~10 seconds.

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
`just verify` recomputes the truth from that embedded evidence with **no network and no database access**.

The reconciler is **keyless and buildless by construction**: it imports `@stellar/stellar-base` only to
_decode and verify_, never to sign (enforced by a grep-provenance test, `no-signing-in-src.spec.ts`). It cannot
forge evidence because it holds no key.

---

## 2. The three-artifact model

Per order, three independent records — deliberately from three different trust domains:

| Artifact                  | Source                                                                                | Trust property                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) `business_intent`** | our local DB row (`destination` / `amount_stroops` / `memo_hex`)                      | **Mutable.** "This is what was requested." A diff's `local_value` always comes from here.                                                                             |
| **(b) `ledger_evidence`** | `signed_xdr` + its Stellar `hash`                                                     | **Frozen cryptographic witness.** "This is what we signed and submitted." Never re-serialized from (a) — corrupting the DB row cannot silently rewrite the signature. |
| **(c) `chain_evidence`**  | `tx_hash` + `fetched_at_ledger` + a normalized `horizon_snapshot` of the `pay()` call | **Frozen chain observation.** "This is what the chain looked like when we watched it."                                                                                |

The signed blob **(b)** is the cryptographic tiebreaker between the mutable local row **(a)** and the observed
chain **(c)**. The report pins two trust anchors at top level, read as **data**, never from the mutable XDR:

- `network.passphrase` — needed to recompute the real Stellar transaction hash.
- `network.operator_public` — the **pinned** signer key. The signature is selected _by hint_; any hint-matching
  signature that verifies over `tx.hash()` passes (this is the multisig seam for later).

`applied_rate` is carried in the snapshot but **excluded** from the diff — the accounting ledger is its audit
source, not the reconciler.

---

## 3. The verdict cascade (total, ordered, role-split)

`resolveGroundTruth` is a single, ordered decision procedure. The order is load-bearing: tamper detection (is
the witness authentic?) is split from divergence detection (did a _different_ tx settle?), so every verdict
stays reachable and `CORRUPT_LOCAL` can only be reached _after_ the signature is proven valid.

Let `S` = pinned-operator signature verifies over `tx.hash()`; `HB` = recomputed hash == recorded hash;
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

| Order     | Local amount        | Chain amount           | Verdict           | `signature_valid` | Meaning                                                                                                                             |
| --------- | ------------------- | ---------------------- | ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ord-001` | 10000000 (1.0 USDC) | 10000000               | **MATCHED**       | true              | Intent, signature, and chain all agree.                                                                                             |
| `ord-002` | 25000000 (2.5 USDC) | 25000000               | **MATCHED**       | true              | Same — a clean settlement.                                                                                                          |
| `ord-003` | 6000000 (0.6 USDC)  | **5000000 (0.5 USDC)** | **CORRUPT_LOCAL** | true              | The signed tx + chain agree on 0.5 USDC; only the local DB row claims 0.6. The chain wins; the discrepancy is surfaced, not hidden. |

`ord-003` is the deliberate mismatch — the "demo hero". Its `field_diff` records `amount: local 6000000 ≠ chain
5000000`, its verdict is `CORRUPT_LOCAL`, and crucially `signature_valid` is still `true`: the evidence proves
the discrepancy is in our records, not in what actually settled.

Summary: `{ total: 3, matched: 2, mismatch: 1, unsettled: 0 }`.

---

## 5. Verify it yourself

```bash
just verify
```

This builds `@troia/reconciler`, then runs the verifier under an in-process network block:

```
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

`verifyReport` ignores the report's own `verdict` / `summary` fields and **recomputes** each from the embedded
evidence, then asserts the stored values equal the recomputation. A single mismatch fails the whole report. To
see the failure mode, run it against the tampered fixture (`recon-report.tampered.json`, which flips `ord-003`'s
stored verdict _and_ status to `MATCHED` and the summary to `{matched:3, mismatch:0}`):

```bash
node --import ./packages/reconciler/bin/block-net.mjs \
     ./packages/reconciler/bin/verify.mjs \
     ./packages/reconciler/test/fixtures/recon-report.tampered.json
```

Observed output (exit code `1`):

```json
{
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

A report that lies about its own outcome cannot pass. That is the whole point.

### The strongest proof: reconcile a real on-chain payout, offline

```bash
just verify-live   # re-derives the verdict, no network, from a REAL landed testnet payout's embedded evidence
```

`recon-report.live.json` captures a real operator-signed `pay()` that landed on testnet (tx `5a3d60cc…`, `TroyPool`
`CCVNY6H…`); `just verify-live` re-verifies it **MATCHED** offline (`networkAttempts:0`) — same model, real chain
evidence. `just demo` runs the full loop end-to-end: N real testnet `pay()`s → a fresh `recon-report.json` → the
offline verify above (one order is a deliberate `CORRUPT_LOCAL` the reconciler catches).

---

## 6. Reset-proof and honest about it

- The **signed parts are self-verifying forever**: `signature_valid` and `hash_consistent` are recomputed from
  the embedded `signed_xdr` + pinned key + passphrase, with no dependency on any live service. A dead explorer
  link or a wiped testnet does not weaken them.
- The **chain-observed part is only as durable as the chain's memory.** If the chain record is gone (testnet
  reset, or the tx never landed), the order resolves to `UNSETTLED` — signed proven, settlement not. We never
  claim "settlement is provable after reset."
- The committed demo fixture tx is a **real, decodable Soroban `pay()` invocation with no execution footprint**,
  so it is genuinely verifiable but not itself network-submittable. A **real operator-signed `pay()` has already
  landed on testnet** (tx `5a3d60cc…d64f13`, `TroyPool` `CCVNY6H…ATRKZ`), captured verbatim as
  `recon-report.live.json` and re-verified reset-proof with `just verify-live` — same model, real chain evidence.

**Bottom line for a reviewer:** clone the repo, run `just verify`, watch it pass on the honest report and fail
on the tampered one — offline, in seconds, without trusting a word we wrote.
