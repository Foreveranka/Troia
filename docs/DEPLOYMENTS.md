# Troia testnet deployment

## Persistent VPS hosting — 17 October 2026

The backend now runs as a dedicated, unprivileged Linux systemd service. Public HTTPS API:
https://api.troiapay.xyz. The existing website `/api` route forwards there. The development-machine
Cloudflare tunnel and local signing service have been stopped and disabled. No new extension permissions
are needed. Other VPS services remain running.

The full pool directory was migrated after confirming two reconciled orders and zero held reservations.
Both SQLite databases, sequence/channel state and all journals were preserved. The source snapshot remains
local as a backup. Secrets are outside the repository in a root-owned service environment file.

Verified on the VPS:

- systemd enabled for server boot and configured to restart after exits.
- Graceful restart retained the existing completed order and original transaction hash.
- A deliberate SIGKILL triggered one automatic restart. The exclusive kernel lock plus positive dead-PID
  check recovered the application lock; the same old receipt remained available.
- HTTPS validates normally. Only customer API paths are forwarded; public `/metrics` returns 404.
- Live IBAN quote succeeds; no real bank/card/mainnet funds were used.

A fresh public-proxy IBAN checkout after the crash recovery delivered 0.1000000 test USDC to the merchant.
[Migration, restart and checkout evidence](evidence/vps-testnet-2026-10-17.json);
[merchant transaction](https://stellar.expert/explorer/testnet/tx/d79f61e25ab1ac571be28e6cf567004b515a3637aa32404cd175538b15ab2b61).

The pool/issuer/operator identifiers below are unchanged. See [runbook](JURY-READINESS.md),
[IBAN chain evidence](evidence/iban-sandbox-2026-10-16.json), and [Month 2 delivery](MONTH2-DELIVERY.md).

## Contract migration — 20 September 2026

Current configuration: `deployment.testnet.json`. This migration replaces the self-issued test asset with the Circle testnet USDC used by TR Mock Anchor. Old pool state and journals are preserved.

| Role              | Stellar TESTNET identifier                                 |
| ----------------- | ---------------------------------------------------------- |
| troyPool          | `CC6EUL2AAAAUR67TYG6MKNRN5BD3WGKIH72PT3TH7VM4UU5K7AAYNFJI` |
| usdcSacContractId | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| usdcIssuer        | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| adminPublic       | `GA7ODBZRM6Z4PQWXTCGCPJ5Q6NXWTUCZCII6XBG6PWDQVLVSJBCBSSPB` |
| operatorPublic    | `GDSQGGVYA4BVMSQMZP4UPECMIY77L3NTZZ6A4JXL6X6YXS22GJFMR2BP` |

- WASM SHA-256: `432f81d35577a97a6b29109e6fe60ffd02eb82792204bbdebc649aa7cb219606`.
- [Deployment transaction](https://stellar.expert/explorer/testnet/tx/762e5be92804aab76b515718731cff5312a27b83506878d8206ec10ec866c9a6).
- [Dedicated operator rotation](https://stellar.expert/explorer/testnet/tx/eeb62a9ddbadb2bc972a05ae0e573c4453e1e28181ce7c0b92ba20cea1d26cde).
- [Manual seed: 20 test USDC](https://stellar.expert/explorer/testnet/tx/d6fca7acb5f47eb921a7c9db5a19f7acd86dd27adecfc6b4055c8dde69785a28). Obtained from Circle's public faucet, then sent to the pool.
- [Sandbox card checkout: 0.50 test USDC to merchant](https://stellar.expert/explorer/testnet/tx/877ca5c3b01960a6f8d504475f45dd05c2c80fde7e65cc765bd0293413145d4d).
- After that test: 19.50 USDC in pool; zero loss-review cases, unreconciled payouts and solvency drift.
- [Public demo end-to-end checkout: 0.50 test USDC](https://stellar.expert/explorer/testnet/tx/3b270b1c8ded4b4dc0d61fc4e2c6fe613ff98916c8ece4fb861794b216cf42cb). Verified the published shop → packaged Chrome extension → sandbox card → merchant settlement → receipt flow. Both public sites also passed the 390px horizontal-overflow check.

## Public sites

- Project and extension: https://troia-extension.vercel.app
- Jury demo: https://troia-demo-store.vercel.app
- Application route: https://troia-demo-store.vercel.app/shop
- Wallet helper: https://troia-extension.vercel.app/wallet
- API: https://troia-extension.vercel.app/api/healthz

Static sites are on Vercel. The API now forwards to the persistent VPS endpoint above; the previous development tunnel is retired. This is a Stellar testnet preview, not a mainnet launch.

## Historical anchor service incident — September 2026

On 20 September 2026 (Istanbul), the mock anchor accepted a simulated 2000 TRY request but kept it in `pending_anchor`. No USDC was delivered for that request; its reference is saved in `deployments/anchor-seed.json`. The health endpoint was green while settlement was stalled. We did not mark it successful or repeat the payment. Circle faucet funding is separate. The later October IBAN merchant-payment test is recorded below; it does not establish a fresh own-wallet withdrawal test.

## Post-submission live retest · 20 September 2026

At 03:54 Istanbul, a new checkout completed through the public demo store, the installed Chrome extension and iyzico's hosted sandbox form. Order `NK-XED4SW9K` charged 26.23 sandbox TRY and delivered exactly 0.5000000 Circle testnet USDC to the demo merchant. The store displayed its completed receipt, and the public order endpoint returned `completed`.

- [Settlement transaction](https://stellar.expert/explorer/testnet/tx/b2e1416fc28ac7e351946f198846af285cbe87be09405cfa5e0cb895be4e0e87)
- Horizon confirmed `successful: true`, ledger `4768419`, timestamp `2026-09-20T00:54:42Z`.
- Transaction effects independently confirmed a 0.5000000 USDC debit from the configured pool and a matching credit to merchant `GBR2LOLTXI7QZFQ6FX2H2KC7YBUXUCKPTPTKH2MJRRNZRSKOSJ7JE4N4`, using the pinned issuer above.
- The separate anchor retest passed authentication and quotes but failed deposit creation with HTTP 400. See [ANCHOR-TESTNET.md](ANCHOR-TESTNET.md). This checkout result does not establish that bank transfers work.

No real card charge, bank transfer or product delivery occurred.

Historical records: [legacy deployment](deployments/legacy-self-issued-testnet.json), [original documentation](deployments/legacy-deployments.md). Signed historical fixtures retain their original trusted deployment pins.

## IBAN merchant checkout — 16 October 2026

The TR Mock Anchor adapter now uses the anchor-issued IBAN/reference and firm quote. The bank input is
simulated. Anchor-to-collection USDC and pool-to-merchant USDC are independently checked on Stellar testnet.
Two 0.1000000-USDC merchant payments completed, including one through the public Vercel proxy.

- [Anchor credit, first test](https://stellar.expert/explorer/testnet/tx/457ebcf8d914ee668e13e7f15d68a4fc4dd4f469529501f4a4e8d30aaf8972d0).
- [Merchant payout, first test](https://stellar.expert/explorer/testnet/tx/ba4f1ca92bcb782546f77d0e59cb5ddc86ee3b617346d6b821383622c6b1bdee).
- [Merchant payout, public proxy](https://stellar.expert/explorer/testnet/tx/8d7ec2185dab4c76ddbf7bfc846b17a71fcbf9f4112d82ef50d4b2f2d588ebf4).
- [Structured evidence](evidence/iban-sandbox-2026-10-16.json).

Pool replenishment remains manual. Real bank receipt verification, production BiLira access and original-payer
refunds require a real provider integration; they are not claimed by this sandbox.
