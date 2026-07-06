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

At deploy time, reading the TroyPool views directly:

```
balance   = "1000000000000"  # 100,000 USDC (7 decimals)
is_paused = false
operator  = GDMAG4EMNWL6T4IJ6PXGBTBJEWAKFJ2YRKRFRIF7ZM7MG6YFZZU35E4S
admin     = GBNPLKNNSAR6JZRYQLDFJKZ5WY73S42BDDPWVHNLDMNHIQHLZYOJ2QDZ
```

## Reproduce

```bash
just fund   # generates/funds the 3 keypairs (once), deploys the USDC SAC + a fresh TroyPool,
            # mints the pool seed, and writes deployment.testnet.json + .env (both git-ignored)
```

Stack: stellar CLI 26.0.0, `soroban-sdk 26.0.0`, USDC = 7 decimals. Network passphrase
`Test SDF Network ; September 2015`.
