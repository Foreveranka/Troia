# Troia testnet deployment - 20 September 2026

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

Static sites are on Vercel. The API forwards to a temporary Cloudflare tunnel on the development computer. **VPS hosting is still required for always-on jury access.** Keep the computer, backend and tunnel online in the meantime.

## Anchor service incident

On 20 September 2026 (Istanbul), the mock anchor accepted a simulated 2000 TRY request but kept it in `pending_anchor`. No USDC was delivered for that request; its reference is saved in `deployments/anchor-seed.json`. The health endpoint was green while settlement was stalled. We did not mark it successful or repeat the payment. Circle faucet funding is separate. A complete card-to-merchant-to-bank off-ramp re-test awaits recovery.

Historical records: [legacy deployment](deployments/legacy-self-issued-testnet.json), [original documentation](deployments/legacy-deployments.md). Signed historical fixtures retain their original trusted deployment pins.
