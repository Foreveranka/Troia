# Troia — Testnet Deployments

Live Stellar **testnet** addresses for the current deploy. Everything here is **non-secret** (public
G-addresses, contract C-addresses, tx hashes); the three signing secrets live only in `.env` (git-ignored).

> **This pool is fixed.** Troia settles against the ONE `TroyPool` named below. `just fund` verifies it is still
> on chain and re-points the apps at it; it never deploys another, because a second pool would orphan this one —
> its balance, its explorer links, and every recon report that names it.
>
> **Testnet is ephemeral, though.** A network reset erases the contract without touching the address table. That
> is the honest `signed ≠ settled` boundary (see [`RECONCILIATION.md`](RECONCILIATION.md)). Recovering from a
> reset — or deploying the first pool — is `just bootstrap`, which refuses to run while a live pool is recorded
> and tells you to update this page when it does run.

## How the one-pool rule is actually enforced

The rule above is not a promise, it is a gate: `scripts/pool-state.mjs`, which `just bootstrap` consults before it
is allowed to change anything. It answers with exactly one word — **`live`**, **`absent`**, or **`unknown`** — and
bootstrap deploys only on `absent`. It refuses on `live`, and it refuses on `unknown` too.

That third word is the whole point, because the two facts a deploy script must never confuse are **"the pool is
gone"** and **"I cannot see the pool."** An earlier version treated every failed liveness call as the former, so a
momentary RPC outage would have been enough to deploy a **second** pool — orphaning the one every document,
explorer link and recon report names, along with its balance.

So the check is structural, in order:

1. `stellar network health` must **parse** and say `healthy`. Its exit code is never consulted, because the CLI
   exits `0` while printing `❌ Unhealthy` — trusting it would make an unreachable network look like a reset.
2. Only then, a **keyless simulation** of the recorded pool's own `balance` view. It answers → `live`. It does not
   → the contract genuinely is not there → `absent`.

A missing `stellar` CLI, a timeout, a rate limit, a garbled response, a corrupt or missing `deployment.testnet.json`:
all `unknown`. Fail closed, always. A second pool is never deployed on a guess.

## Accounts (classic `G…`)

| Role          | Address                                                    | Explorer                                                                                                            |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| admin         | `GBNPLKNNSAR6JZRYQLDFJKZ5WY73S42BDDPWVHNLDMNHIQHLZYOJ2QDZ` | [account](https://stellar.expert/explorer/testnet/account/GBNPLKNNSAR6JZRYQLDFJKZ5WY73S42BDDPWVHNLDMNHIQHLZYOJ2QDZ) |
| operator      | `GDMAG4EMNWL6T4IJ6PXGBTBJEWAKFJ2YRKRFRIF7ZM7MG6YFZZU35E4S` | [account](https://stellar.expert/explorer/testnet/account/GDMAG4EMNWL6T4IJ6PXGBTBJEWAKFJ2YRKRFRIF7ZM7MG6YFZZU35E4S) |
| issuer (USDC) | `GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W` | [account](https://stellar.expert/explorer/testnet/account/GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W) |

Three separate keypairs even on testnet (no collapse) — admin (pause/upgrade/rotate), operator (signs `pay()`),
issuer (USDC SAC mint authority). See ARCHITECTURE §9.

## Contracts (`C…`)

| Contract | Address                                                    | Explorer                                                                                                              |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| USDC SAC | `CCOAUUKWWPSVFZUPIVZECTV3PIVFRTVFKWWF2PQY5Q5CN3JBCDXGNCMB` | [contract](https://stellar.expert/explorer/testnet/contract/CCOAUUKWWPSVFZUPIVZECTV3PIVFRTVFKWWF2PQY5Q5CN3JBCDXGNCMB) |
| TroyPool | `CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ` | [contract](https://stellar.expert/explorer/testnet/contract/CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ) |

- **USDC SAC** — the Stellar Asset Contract for `USDC:GCRAO5VC…4N5W`, exposing our self-issued testnet USDC to
  Soroban. Its id is deterministic from the asset (`stellar contract id asset --asset USDC:<issuer>`).
- **TroyPool** — the custody contract. `__constructor` bound `admin`, `operator`, and the USDC SAC once at
  deploy; it is unpaused and seeded with **100,000 USDC** (`1000000000000` stroops).

## Demo merchant (the storefront's payee)

| Role          | Address                                                    | Explorer                                                                                                            |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| demo merchant | `GBCUCFGEAJLHYFAZFPJZOSSFLMNXW6TCE4BFFEVMYYJX7LIMRYAMNYAE` | [account](https://stellar.expert/explorer/testnet/account/GBCUCFGEAJLHYFAZFPJZOSSFLMNXW6TCE4BFFEVMYYJX7LIMRYAMNYAE) |

The address the demo storefront pays **today** — its single source is `app/storefront/src/config.ts`, and `just wire`
never writes it (only the USDC issuer is generated into the apps). It is **not part of the deploy**: a plain
trustlined testnet account, swappable without touching the pool. The two full-stack runs recorded below predate it
and paid `GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX`, the previous payee (retired 2026-07-10).

## Bootstrap transactions

| Step                                        | Tx                                                                 | Explorer                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Deploy USDC SAC                             | `4c73b7fae52b4850435dff931ad841b1cf51e2453950637091bfc956f71e4adc` | [tx](https://stellar.expert/explorer/testnet/tx/4c73b7fae52b4850435dff931ad841b1cf51e2453950637091bfc956f71e4adc) |
| Deploy TroyPool                             | `9f66a87bf20c920146c861ac1db3582d99a23243c24a157fdeab2675485c6fe0` | [tx](https://stellar.expert/explorer/testnet/tx/9f66a87bf20c920146c861ac1db3582d99a23243c24a157fdeab2675485c6fe0) |
| Mint 1000 USDC → pool (initial)             | `03e69a9552ae11dd9cebbf6e5d4fd947d2222f42eb6fc73451e7ea02cdd93609` | [tx](https://stellar.expert/explorer/testnet/tx/03e69a9552ae11dd9cebbf6e5d4fd947d2222f42eb6fc73451e7ea02cdd93609) |
| Mint +99,000 USDC → pool (top-up → 100,000) | `5f224b9b0d02ad40b6aa42e8527aa836e0daa95b8d97aa796e77ec06984fc8e4` | [tx](https://stellar.expert/explorer/testnet/tx/5f224b9b0d02ad40b6aa42e8527aa836e0daa95b8d97aa796e77ec06984fc8e4) |

> The two mints above are a one-time historical seeding of this deploy; `just bootstrap` today seeds the full
> 100,000 USDC in a **single** mint, so a fresh deployment produces one mint tx, not this pair.

## Verified on-chain state

After the pool seed, reading the TroyPool views directly:

```
balance   = "1000000000000"  # 100,000 USDC (7 decimals)
is_paused = false
operator  = GDMAG4EMNWL6T4IJ6PXGBTBJEWAKFJ2YRKRFRIF7ZM7MG6YFZZU35E4S
admin     = GBNPLKNNSAR6JZRYQLDFJKZ5WY73S42BDDPWVHNLDMNHIQHLZYOJ2QDZ
```

## Verified money path (real `pay()` on testnet)

An operator-signed `pay()` moved USDC from the pool to a merchant end-to-end, using identities derived from a real
`order_id`. Every tx below is verifiable on the explorer — you do not have to trust this table.

- **Order:** `order_id = troia-smoke-0001`, amount **1 USDC** (`10000000` stroops), `applied_rate = 411075000`.
- **Merchant:** `GDF7V2G5FB5UF4AT7ZQ2A4L3YFG44UVJW3APSZWDN3FCI3HJCCMMGOXN` — a fresh account with a USDC trustline
  ([trustline tx](https://stellar.expert/explorer/testnet/tx/d2b120f2f258f35474a3f08704639c381136a973215af114cdefbc82c59bbd49)).
- **Derived identity** (`deriveIds(order_id, destination, amount)`, byte-exact — ARCHITECTURE §5):
  - `tx_id = fdce630a4557f4bb37a6d7c1d3e011f0749b1f2e0de54be336e8d4ee789876cf`
  - `memo  = 6115721c3f246433a851a959ba9b0bc8c3de9bc486f5da2cdd0f022bad30c5a9`

| Check                            | Result                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pay()` payout (operator-signed) | [tx `5a3d60cc…`](https://stellar.expert/explorer/testnet/tx/5a3d60cc25fc82025560d1c13b74f63b619393e194ada43cc6b8317637d64f13) — emits `PaymentMade` with the derived `tx_id`/`memo` |
| Pool balance                     | 100,000 → **99,999 USDC** (`999990000000`)                                                                                                                                          |
| Merchant balance                 | 0 → **1 USDC** (`10000000`)                                                                                                                                                         |
| Replay guard                     | `is_processed(tx_id) = true`                                                                                                                                                        |
| **Double-pay shield**            | a second `pay()` with the same `tx_id` **reverts** `AlreadyProcessed` (`Error(Contract, #1)`); the pool balance is unchanged                                                        |

The double-pay revert is the on-chain half of invariant ② (the operator sequence is the primary shield; the
contract's `Processed(tx_id)` guard is the second): the irreversible USDC leg can never pay one order twice.

**Reconciled offline.** This exact payout is captured as `packages/reconciler/test/fixtures/recon-report.live.json`
and re-verified with **no network**: `just verify-live` re-derives the verdict from the embedded evidence and
confirms **MATCHED** (`{total:1, matched:1}`, `networkAttempts:0`). The signed evidence is reset-proof — it
verifies offline even after a testnet reset, because the operator's signature over the real tx hash is embedded
and unforgeable. The on-chain **settlement itself** is the payout tx above, verifiable on the explorer while the
chain remembers it (`signed ≠ settled`). See [`RECONCILIATION.md`](RECONCILIATION.md).

## Full-stack live settlement (extension → charge → `pay()`)

The payout above (`5a3d60cc…`) was a direct `pay()` call proving the on-chain leg in isolation. Phase 4.5/5.2
then drove the **whole stack live**: the demo storefront emitted a SEP-7 pay URI, the **browser extension**
detected it and opened iyzico's hosted form **in a new browser tab**, a real **Troy sandbox card** paid TRY, and — only after the charge
confirmed — the backend submitted the irreversible USDC leg automatically. No step was hand-run.

- **Order:** a storefront checkout; settlement amount **74 USDC** (`740000000` stroops).
- **Merchant:** `GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX` (the demo merchant **at the time of this
  run**, since superseded — see above; balance 10 → **84 USDC**).
- **Operator-signed `pay()`:** [tx `cd643d71…`](https://stellar.expert/explorer/testnet/tx/cd643d7178c6d6068aabe236af45e68fba60d9062d1ff71a85c5af75dfb08ded)
  — `invoke_host_function` on `TroyPool`, pool `contract_debited` 74 USDC → merchant `account_credited` 74 USDC,
  operator source `GDMAG4EM…`, `2026-07-07T23:02:50Z`. Verifiable on the explorer while the chain remembers it.

This is the money-first ordering realized end-to-end over the network: **reversible TRY charge first, irreversible
USDC last** (`signed ≠ settled`). It is the first run that exercises the live SDK/RPC/iyzico adapters — the halves
that were type-checked-only before. See [`LIVE_SMOKE.md`](LIVE_SMOKE.md) for the runbook this executed.

## Automatic pool refill (rebalance bot)

A live rebalance loop now refills the pool from the TRY collected. On every testnet boot `settleTick` arms each
money-good order and, after the compressed demo valör (`DEMO_VALOR_SECS`, default **30s**; the real iyzico valör is
**~21 days**), mints USDC into the pool from that order's collected TRY at the live oracle rate by signing a **real
USDC-SAC mint with the issuer key** (`SimulatedRebalance` → `createSacMintClient`). This exercises the issuer-signed
mint path automatically — no dedicated rebalance-mint tx hash is recorded here. The system is seamed for a future
**agent + on/off-ramp service**; on mainnet the same seam becomes a real CEX buy. See **ARCHITECTURE §6a**.

## Durable state + chain-authoritative detection, proven live

A second full-stack run, `2026-07-10`, drove the same storefront → extension → iyzico → `pay()` path, but this time
against the durable logs (ARCHITECTURE §3b) and the two chain-reading loops (RECONCILIATION.md §8). It is the stronger proof, because
nothing in it is asserted by the system about itself.

- **Order `ST-7SRI0YDF`** — customer paid **4 019.46 TRY**; settlement **80 USDC** (`800000000` stroops).
- **Operator-signed `pay()`:** [tx `d47f7fb9…`](https://stellar.expert/explorer/testnet/tx/d47f7fb92a149d61a6f576aa7f803d75e6d3b3dcb6b0119e5a12a7387683d1a5)
  — ledger `3530567`, `2026-07-10T07:33:21Z`, merchant `GA4WBDAN…` (the then-current demo payee) credited 80 USDC.
- **The audit found the settlement by the contract's own index, not by our record.** The pool announced it under
  `tx_id = f11336a3e231fde6…` — the identifier the contract indexes, derived from `order_id` alone
  (`sha256(lp("troia.txid.v1") ‖ lp(order_id))`) and recomputed independently by `deriveIds`. Looking it up by that
  contract-side identifier, not by the transaction hash we recorded, is what makes the check independent of our own
  records. All five gates passed (the settlement was found under the order's own `tx_id`; no `upgrade()`; the
  announced amount == the amount the token contract moved; the tx still live and successful;
  `resolveGroundTruth → MATCHED`), and the order was marked `Reconciled`.
- **The books equal the chain, to the stroop.** Ledger `USDC_POOL` = `991852840183`; `readSacBalance` on the pool =
  `991852840183`. Genesis `991794691346` − payout `800000000` + refill `858148837`. Each of the three journal
  entries balances in kuruş on both sides. The pool grew by the commission: **+5.8148837 USDC**.
- **Our own payout was never mistaken for a theft.** The payout tail read the USDC SAC's `transfer` events, matched
  the outflow's hash against the durable write-ahead journal, and created no suspect — `outflow-suspects.log` stayed
  0 bytes. This held **across a restart**, when the in-memory order registry was gone and the durable
  `authorized.log` — not that registry — was the only thing still vouching for the payout.
- **Restart, same data directory:** genesis was not re-booked, the tail resumed from its cursor instead of
  cold-starting again (one `cov` record, not two), the reconciled order was not re-audited, and `ledger.hasRef`
  stopped the refill from minting twice (journal still 3 entries).
- **No alarm fired in either process life** — observed in the server's stderr at the time. Alarms are logged, not
  persisted, so unlike everything above this one is **not re-derivable from a clone**; the on-disk state (an empty
  `outflow-suspects.log`, no divergence, a clean journal) is consistent with it but does not prove it.

Record counts in `data/<troyPool>/` after the run — `ledger-journal` 3, `evidence` 1, `authorized` 1,
`chain-observations` 3, `reconciled` 1, `outflow-cursor` last-wins, `outflow-suspects` **0 bytes**. (The directory
is git-ignored: it holds a live deployment's state, not a fixture.) The coverage floor, framed exactly as
ARCHITECTURE §3b describes — `L<payload bytes>,<crc32>|<payload>`:

```
L35,3499d6da|{"v":1,"t":"cov","unix":1783668512}
```

**What this run did _not_ prove.** `ROGUE PAYOUT` is proven separately below (it fired live on `2026-07-14`).
`CHAIN_DIVERGENCE` and both blind-spot states (`never-watched`, `aged-out`) remain exercised by tests only. The run
also surfaced a
real defect: `GET /status/<orderId>` answered `NotFound` after the restart, because the order rows are in memory.
Both `/status` and `/receipt` now answer a **settled** order from the durable evidence log instead; an order still
in flight is still an honest `404`. See [`SCOPE_AND_LIMITATIONS.md`](SCOPE_AND_LIMITATIONS.md) §4.

## The revert-read path, proven on a live reverted `pay()`

`readContractErrorCode` parses a contract error code out of a **failed** transaction's diagnostic events — a shape
no fake can stand in for. Confirmed on chain `2026-07-14` (`scripts/stage-revert.mjs` → `scripts/probe-revert.mjs`):

- **Reverted tx:** [`249862ed…`](https://stellar.expert/explorer/testnet/tx/249862edac65d4a006d56a8825ade62ae8b7486c6a282fcdfaad3f9745d0f134)
  — `status FAILED`, 22 diagnostic events, all scoped to `TroyPool` (`CCVNY6H…`), and `readContractErrorCode` read
  **`3` (`Paused`)**.
- **How it was staged.** A double-pay cannot produce a reverted tx (a deterministic revert fails simulation and is
  never submitted). Instead the pool was `pause()`d and a pre-signed `pay()` sent: `pay()` checks `paused` **before**
  the `Processed` write and the transfer, so the revert moved **no USDC**, marked **no** `tx_id` (`is_processed`
  stayed `false` — the `Err` rolled the whole invocation back), emitted **no** `transfer` event, and left the pool
  balance byte-identical (`994599590499` before and after). The pool was unpaused immediately, by a guard that runs
  on every exit path.

## `ROGUE PAYOUT`, fired live against a real unauthorized outflow

The payout tail's sharpest claim — that USDC leaving the pool through a transaction the operator never wrote to
the pre-broadcast journal is caught, not just the negative (an authorized payout is not accused). Demonstrated on
chain `2026-07-14`, against a **live backend** (`just serve`, so the real tail was watching), in an **isolated data
dir** so this deployment's own operating history stays clean:

- **The staged outflow.** The operator called `pay()` **directly by CLI, bypassing the backend**, sending 1 USDC
  (`10000000` stroops) to a testnet merchant —
  [tx `d946c02e…`](https://stellar.expert/explorer/testnet/tx/d946c02ea7f69e93160d9e631ceda88e7bb17a262c24f8a22c81b162a0e8c78f),
  ledger 3604686. Because it never went through the backend, its hash was never written to `authorized.log`.
- **The tail caught it.** After the 60-second grace, the live tail paged: _"ROGUE PAYOUT: 10000000 stroops of USDC
  left the pool … which this operator never authorized — its hash was never written to the pre-broadcast journal."_
  The suspect log recorded the case durably — a `seen` entry, then an `alarmed` entry, both keyed to the tx hash.
- **It self-heals the balance, never the evidence.** The issuer minted the 1 USDC back, so the pool ended
  byte-identical (`994599590499` before, `994599590499` after). The suspect record **stays** in the append-only log:
  the balance tripwire clears on re-sync, but the outflow ledger never forgets an unauthorized payout. No money was
  at risk (testnet USDC), and the real deployment's `outflow-suspects.log` remained `0` bytes throughout.

## Channel accounts live drill (A-5, `2026-08-08`)

The parallel-payout design (`CHANNEL_ACCOUNTS_DESIGN.md`) was fired live against this pool. Five channel
accounts (`troia-channel-1..5`, friendbot-funded fee payers with no USDC and no contract authority) were armed
via `TROIA_CHANNEL_SECRETS`; the boot logged `[channels] 5 channel account(s) armed`. Two concurrent 5-USDC
orders were charged on the sandbox hosted form and settled through TWO DIFFERENT channel tx sources:

- `drill-b…`: tx `56457a19…`, source `GAQFBKFG…` (**channel-1**), ledger `4035197`, successful.
- `drill-a…`: tx `cad50dff…`, source `GCEBPKYR…` (**channel-2**), ledger `4035200`, successful.

That is the live proof of the whole mechanism: the network accepted the operator's authorization as a SIGNED
address-credential auth entry inside a channel-sourced transaction. Both pool refills booked
(`troia_settlements_total 2`), the transient post-payout drift closed to `0`, and a full restart replayed the
durable store (`2 settled row(s) dropped`, both orders still answering `completed`).

The drill also caught a real gap, fixed the same day: the live reconciler's P2 predicate verified the ENVELOPE
signature against the operator, so both channel payouts flagged `EVIDENCE_TAMPERED (signature_valid=false)`.
P2 now verifies the operator's auth-entry signature over the SorobanAuthorization preimage for channel-sourced
transactions (`packages/reconciler/src/verify-crypto.ts`, with a forged-witness rejection test); after the fix
both orders reconciled: `the chain agrees — reconciled`.

**The crash variant (same day):** a third order (`drill-crash…`) was paid on the hosted form while the backend
was DEAD — the exact KNOWN_ISSUES §1 exposure (charge exists at iyzico, no process alive to record it). On
restart the durable order store recovered it (`recovered in-flight order … (SolvencyReserved)`, its
reservation replayed as held), the poll worker re-retrieved the sale, and the payout settled through
**channel-3**: tx `ec76e640…`, ledger `4035346`, successful — no human touch, no money stranded. The
charged-but-forgotten crash window is closed by live proof, not just by tests.

## Working against this deployment

```bash
just fund   # asserts the pool above is still on chain, tops up fee XLM for keys this machine holds,
            # and re-points the storefront + extension at it. Never deploys anything.
```

`deployment.testnet.json` — the record of the five identities above, plus the backend URL and the storefront's
allowed origins — **is in the repository**: every value in it
is public, and committing it is what makes "one pool, unchanging" true for every clone rather than something each
machine re-invents. Moving money additionally needs the matching secrets in `.env`, and those never leave a
machine. An offline test pins the two apps to this record, so a stale wiring fails the gate rather than the demo.

## Deploying a pool (first time, or after a testnet reset)

```bash
just bootstrap   # generates/funds the 3 keypairs (once), deploys the USDC SAC + a TroyPool, mints the pool
                 # seed, rewrites deployment.testnet.json (COMMIT the change), writes .env (git-ignored),
                 # and wires the two apps
```

It **refuses** unless the chain proves the recorded pool is absent. A live pool refuses; a network it cannot see
refuses too, because a guess is not proof and a second pool would silently abandon the first along with its
balance. There is no override flag: abandoning a live pool means changing `deployment.testnet.json` in a reviewed
commit, deliberately. When it does run, the table on this page is stale and must be rewritten.

Stack: stellar CLI 26.0.0, `soroban-sdk 26.0.0`, USDC = 7 decimals. Network passphrase
`Test SDF Network ; September 2015`.
