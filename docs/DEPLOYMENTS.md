# Troia — Testnet Deployments

Live Stellar **testnet** addresses for the current deploy. Everything here is **non-secret** (public
G-addresses, contract C-addresses, tx hashes); the three signing secrets live only in `.env` (git-ignored).

> **Testnet is ephemeral.** A network reset wipes these addresses and balances — that is the honest
> `signed ≠ settled` boundary (see [`RECONCILIATION.md`](RECONCILIATION.md)). Regenerate a fresh deploy any
> time with `just fund`, which rewrites `deployment.testnet.json` (git-ignored) with the new addresses.

## Accounts (classic `G…`)

| Role | Address | Explorer |
|---|---|---|
| admin | `GBNPLKNNSAR6JZRYQLDFJKZ5WY73S42BDDPWVHNLDMNHIQHLZYOJ2QDZ` | [account](https://stellar.expert/explorer/testnet/account/GBNPLKNNSAR6JZRYQLDFJKZ5WY73S42BDDPWVHNLDMNHIQHLZYOJ2QDZ) |
| operator | `GDMAG4EMNWL6T4IJ6PXGBTBJEWAKFJ2YRKRFRIF7ZM7MG6YFZZU35E4S` | [account](https://stellar.expert/explorer/testnet/account/GDMAG4EMNWL6T4IJ6PXGBTBJEWAKFJ2YRKRFRIF7ZM7MG6YFZZU35E4S) |
| issuer (USDC) | `GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W` | [account](https://stellar.expert/explorer/testnet/account/GCRAO5VCCWUSHAOJ5LDVGD2T6HSIRBPEU4TDY6XP4GSVTOTO2KZI4N5W) |

Three separate keypairs even on testnet (no collapse) — admin (pause/upgrade/rotate), operator (signs `pay()`),
issuer (USDC SAC mint authority). See ARCHITECTURE §9.

## Contracts (`C…`)

| Contract | Address | Explorer |
|---|---|---|
| USDC SAC | `CCOAUUKWWPSVFZUPIVZECTV3PIVFRTVFKWWF2PQY5Q5CN3JBCDXGNCMB` | [contract](https://stellar.expert/explorer/testnet/contract/CCOAUUKWWPSVFZUPIVZECTV3PIVFRTVFKWWF2PQY5Q5CN3JBCDXGNCMB) |
| TroyPool | `CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ` | [contract](https://stellar.expert/explorer/testnet/contract/CCVNY6H67XQFOU64EU664HKUCO5M7ZJMJG2NIDSU6BQYRU23IJIATRKZ) |

- **USDC SAC** — the Stellar Asset Contract for `USDC:GCRAO5VC…4N5W`, exposing our self-issued testnet USDC to
  Soroban. Its id is deterministic from the asset (`stellar contract id asset --asset USDC:<issuer>`).
- **TroyPool** — the custody contract. `__constructor` bound `admin`, `operator`, and the USDC SAC once at
  deploy; it is unpaused and seeded with **100,000 USDC** (`1000000000000` stroops).

## Bootstrap transactions

| Step | Tx | Explorer |
|---|---|---|
| Deploy USDC SAC | `4c73b7fae52b4850435dff931ad841b1cf51e2453950637091bfc956f71e4adc` | [tx](https://stellar.expert/explorer/testnet/tx/4c73b7fae52b4850435dff931ad841b1cf51e2453950637091bfc956f71e4adc) |
| Deploy TroyPool | `9f66a87bf20c920146c861ac1db3582d99a23243c24a157fdeab2675485c6fe0` | [tx](https://stellar.expert/explorer/testnet/tx/9f66a87bf20c920146c861ac1db3582d99a23243c24a157fdeab2675485c6fe0) |
| Mint 1000 USDC → pool (initial) | `03e69a9552ae11dd9cebbf6e5d4fd947d2222f42eb6fc73451e7ea02cdd93609` | [tx](https://stellar.expert/explorer/testnet/tx/03e69a9552ae11dd9cebbf6e5d4fd947d2222f42eb6fc73451e7ea02cdd93609) |
| Mint +99,000 USDC → pool (top-up → 100,000) | `5f224b9b0d02ad40b6aa42e8527aa836e0daa95b8d97aa796e77ec06984fc8e4` | [tx](https://stellar.expert/explorer/testnet/tx/5f224b9b0d02ad40b6aa42e8527aa836e0daa95b8d97aa796e77ec06984fc8e4) |

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
- **Derived identity** (`deriveIds(order_id)`, byte-exact — ARCHITECTURE §4):
  - `tx_id = fdce630a4557f4bb37a6d7c1d3e011f0749b1f2e0de54be336e8d4ee789876cf`
  - `memo  = 6115721c3f246433a851a959ba9b0bc8c3de9bc486f5da2cdd0f022bad30c5a9`

| Check | Result |
|---|---|
| `pay()` payout (operator-signed) | [tx `5a3d60cc…`](https://stellar.expert/explorer/testnet/tx/5a3d60cc25fc82025560d1c13b74f63b619393e194ada43cc6b8317637d64f13) — emits `PaymentMade` with the derived `tx_id`/`memo` |
| Pool balance | 100,000 → **99,999 USDC** (`999990000000`) |
| Merchant balance | 0 → **1 USDC** (`10000000`) |
| Replay guard | `is_processed(tx_id) = true` |
| **Double-pay shield** | a second `pay()` with the same `tx_id` **reverts** `AlreadyProcessed` (`Error(Contract, #1)`); the pool balance is unchanged |

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
detected it and opened iyzico's hosted form, a real **Troy sandbox card** paid TRY, and — only after the charge
confirmed — the backend submitted the irreversible USDC leg automatically. No step was hand-run.

- **Order:** a storefront checkout; settlement amount **74 USDC** (`740000000` stroops).
- **Merchant:** `GA4WBDANMT6MF6VMFFKMZIR6QE2XBEETNHANAMRBQC2XGSST3GRNIESX` (the demo merchant; balance 10 → **84 USDC**).
- **Operator-signed `pay()`:** [tx `cd643d71…`](https://stellar.expert/explorer/testnet/tx/cd643d7178c6d6068aabe236af45e68fba60d9062d1ff71a85c5af75dfb08ded)
  — `invoke_host_function` on `TroyPool`, pool `contract_debited` 74 USDC → merchant `account_credited` 74 USDC,
  operator source `GDMAG4EM…`, `2026-07-07T23:02:50Z`. Verifiable on the explorer while the chain remembers it.

This is the money-first ordering realized end-to-end over the network: **reversible TRY charge first, irreversible
USDC last** (`signed ≠ settled`). It is the first run that exercises the live SDK/RPC/iyzico adapters — the halves
that were type-checked-only before. See [`LIVE_SMOKE.md`](LIVE_SMOKE.md) for the runbook this executed.

## Reproduce

```bash
just fund   # generates/funds the 3 keypairs (once), deploys the USDC SAC + a fresh TroyPool,
            # mints the pool seed, and writes deployment.testnet.json + .env (both git-ignored)
```

Stack: stellar CLI 26.0.0, `soroban-sdk 26.0.0`, USDC = 7 decimals. Network passphrase
`Test SDF Network ; September 2015`.
