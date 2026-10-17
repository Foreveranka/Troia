# Instawards Month 2 — delivery evidence

This repository implements the two core testnet flows in the approved work description. The external SOW
is unchanged. Final acceptance is the Chapter Lead/program's decision; a working mock does not establish
production bank approval.

## Automated settlement

The backend reads live USD/TRY pricing, reserves existing pool liquidity, verifies the provider's payment
result and automatically executes a bounded Soroban merchant payout. The recovery worker and durable
sequence/journal state prevent a restart or a duplicate request from blindly issuing another payment.
Pool replenishment is manual and separate from automatic merchant settlement.

Card checkout uses iyzico sandbox. Existing card-to-merchant transaction evidence is linked in
[DEPLOYMENTS.md](DEPLOYMENTS.md). IBAN checkout uses the anchor's SEP-38 quote, independent receipt checks
and the same merchant payout engine. Neither a browser redirect nor a simulation-button click is evidence
of a successful payout.

## IBAN merchant payments

The extension offers **IBAN ile ödeme** and an IBAN choice in the detected merchant checkout. The server
requests actual sandbox instructions from TR Mock Anchor, including the IBAN and per-transfer explanation
code. The user simulates the bank leg, then the backend checks the anchor and Horizon transaction before
paying the merchant. No production BiLira/bank API is integrated.

Completed public-gateway test on 16 October 2026:

- Order: `iban-e2e-1792117877902`.
- Amount: 4.98 simulated TRY → 0.1000000 test USDC to the merchant.
- [Merchant transaction](https://stellar.expert/explorer/testnet/tx/8d7ec2185dab4c76ddbf7bfc846b17a71fcbf9f4112d82ef50d4b2f2d588ebf4).
- [First test and anchor credit evidence](evidence/iban-sandbox-2026-10-16.json).
- [Provider adapter and repeatable smoke test](bank-transfer-integration.md).

## Reviewer access

- Introduction, install instructions and current ZIP: https://troiapay.xyz
- Supported demo shop: https://troia-demo-store.vercel.app
- Persistent testnet API: https://api.troiapay.xyz/healthz
- [Runbook](JURY-READINESS.md), [deployment evidence](DEPLOYMENTS.md).

The backend is isolated from other VPS projects and enabled on server boot.
[17 October VPS, crash-recovery and fresh payment evidence](evidence/vps-testnet-2026-10-17.json). Its state migrated from the
stopped local writer. A production-domain certificate replaces the temporary tunnel.

## Delivery materials still requiring a human step

Record the updated extension flow, showing both card and IBAN checkout, automatic merchant settlement and
the onchain receipt. A concise recording can use this sequence:

1. 0–15s: problem and Troia installed at a supported Stellar checkout.
2. 15–45s: show a sandbox card purchase, automatic settlement and transaction receipt.
3. 45–90s: choose IBAN, show the exact amount/reference and simulate the bank transfer.
4. 90–120s: show the completed USDC receipt and explain that TRY is simulated, USDC is on testnet, and pool
   funding is manual.

Provide this repo, the recording, the links above and the transaction evidence to the Chapter Lead for
verification. Do not label an older recording as evidence of the new IBAN flow. Real virtual POS is optional;
mainnet deployment, contract audit and liquidity provisioning are outside this month's stated scope.
