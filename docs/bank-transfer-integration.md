# IBAN merchant checkout integration

This is a provider-neutral implementation, **not an already integrated Onramp.money or BiLira API**.
No production IBAN, bank credentials or successful real bank transfer is configured. Default mode is disabled.
Connecting a provider means mapping its documented API into `BankTransferProvider`, or implementing the private
HTTP bridge protocol below. Arbitrary vendor API keys alone will not make a vendor speak this protocol.

## Customer flow

1. Open a supported merchant checkout, choose Bank transfer in the Troia banner; alternatively open
   **IBAN ile ödeme** in the extension side panel and enter the merchant Stellar address/USDC amount.
2. Backend validates the merchant, prices the purchase with a **separate bank fee policy**, reserves USDC
   and freezes a 15-minute payment deadline. It creates one transfer with a stable idempotency key.
3. Extension displays the provider's beneficiary, checksum-validated Turkish IBAN, exact TL amount,
   unique transfer reference and deadline. The backend generates the explanation code as
   `TROIA-` plus 128 bits of its order-derived identity. The provider must echo this exact reference;
   retries keep the same code and a different purchase gets a different code. IBAN/reference can be copied. There is no “I paid” confirmation gate.
4. Background worker retrieves cleared payment facts using server credentials. Only exact matching
   provider, transfer ID, order ID, reference, TRY amount and an on-time receipt can authorize settlement.
5. Existing Stellar settlement/reconciliation delivers the merchant's USDC and produces its receipt.
   Manual liquidity replenishment remains the operational funding model.

Underpayment, overpayment, wrong reference/currency/order/provider and late receipts are held for review.
Provider outages or local clock expiry alone never release a possibly paid reservation. A final
`expired_unpaid` observation must guarantee zero funds and a closed transfer; the provider is responsible
for handling/returning any later funds without reviving it. Unknown payment outcomes must remain pending.
Confirmed-but-failed Stellar payouts use bank refunds to the **original payer**, never card cancellation.
Refunds are bounded/idempotent and unresolved refunds are recorded in the existing durable LossReview queue.

SQLite OrderCtx version 3 stores the method, instructions, original expiry and review state. Legacy v1/v2
card rows remain readable. If create times out after the provider accepted it, recovery repeats the SAME
idempotency key, amount and expiry. Provider creation must be idempotent across process restarts. The extension
side panel retains pending bank instructions in local browser storage and re-polls rather than creating another transfer.
The bank API does not accept customer-supplied payment evidence or unauthenticated bank webhooks.

## Server setup

Use `.env.bank-transfer.example` as an additional backend environment reference. Do not copy secrets into
Vite variables, browser storage, the extension manifest or public downloads.

- `BANK_TRANSFER_MODE=disabled` (default), or `bridge`.
- `BANK_TRANSFER_API_BASE_URL`: private HTTPS service implementing the protocol below.
- `BANK_TRANSFER_PROVIDER_ID`: expected stable provider identifier; retained on existing orders.
- `BANK_TRANSFER_API_KEY`: server-side bearer credential.
- `BANK_TRANSFER_FEE_BPS`: negotiated provider percentage, integer 0–9999.
- `BANK_TRANSFER_FIXED_KURUS`: negotiated fixed per-purchase cost.
- `BANK_TRANSFER_VALOR_DAYS`: negotiated settlement period, integer 1–365.
- `BANK_TRANSFER_MARGIN_BPS`: explicit margin used in the existing FX-risk pricing policy.

Enabling without these settings fails startup. Do not set zero costs just to enable an unnegotiated provider.
Card checkout keeps its own existing quote/PSP path. Bank pricing is selected with
`GET /quote/:amountStroops?paymentMethod=bank_transfer` and `POST /intent` with
`paymentMethod: "bank_transfer"`; the normal session and rate limits still apply. Disabled bank routes return
503 `BankTransferUnavailable` before reserving liquidity or touching a PSP. All `/intent` retries retain the
original order identity/payment method; changing amount, recipient, memo or payment method returns 409.

## Private HTTP bridge contract

All calls use `Authorization: Bearer <server key>`, HTTPS, a 10-second timeout and no redirects.
Responses are bounded at 64 KiB. This bridge runs on trusted infrastructure and must authenticate to
(and verify authoritative payment status from) the real provider. Browser redirects, screenshots and bank
transfer initiation alone are not proof of cleared funds. Map KYC/AML approval into the provider's final
`received` state; never return `received` for an incomplete KYC or provisional transfer.

### Create

`POST /transfers`, header `Idempotency-Key: <stable order-derived key>`:

```json
{
  "orderId": "merchant-order-id",
  "idempotencyKey": "stable-order-derived-key",
  "reference": "TROIA-<32 uppercase hex characters from the backend>",
  "amountTry": "100.25",
  "currency": "TRY",
  "expiresAtUnix": 1800000900
}
```

Response (replace placeholders with the actual provider instructions):

```json
{
  "providerId": "your-provider-id",
  "transferId": "unique-provider-transfer-id",
  "orderId": "merchant-order-id",
  "reference": "unique-transfer-reference",
  "iban": "<canonical checksum-valid Turkish IBAN without spaces>",
  "beneficiary": "<provider-authorized beneficiary>",
  "amountTry": "100.25",
  "currency": "TRY",
  "expiresAtUnix": 1800000900
}
```

Retries must return the same transfer even after timeouts. Never reassign a reference/transfer ID to another
order. The provider may shorten the requested deadline, but must never extend it. Stable per-order virtual
accounts or unambiguous reference matching must prevent a single receipt from funding multiple orders.
Only the explicitly projected instruction fields reach the extension, never raw provider responses.

### Retrieve

`GET /transfers/:transferId` response:

```json
{
  "providerId": "your-provider-id",
  "transferId": "unique-provider-transfer-id",
  "orderId": "merchant-order-id",
  "reference": "unique-transfer-reference",
  "amountTry": "100.25",
  "currency": "TRY",
  "status": "received",
  "receivedAtUnix": 1800000300
}
```

`amountTry` is the actually cleared cumulative amount, not the expected amount echoed from creation.
For `pending`, use actual received funds (normally `0.00`). States:

- `pending`: unconfirmed or still payable; keep polling.
- `received`: final, cleared, compliance-approved funds, with a trusted receipt time.
- `review`: provider exception, unclear reference, partial/excess/late payment or compliance hold.
- `expired_unpaid`: irrevocably closed with `amountTry: "0.00"`; provider handles any late payment separately.

Transport errors, missing/unknown fields or unknown statuses must never be mapped to success. No client
clock countdown may replace this server-side verification. A final received status must not regress.

### Refund

`POST /transfers/:transferId/refund`, header `Idempotency-Key: refund:<transferId>`:

```json
{ "orderId": "merchant-order-id", "amountTry": "100.25", "currency": "TRY" }
```

Return `providerId`, `transferId`, `orderId`, `amountTry`, `currency` and
`status: "refunded"` **only after a final refund to the original payer**. A queued refund is `pending`.
Original-payer identity and bank account stay with the provider. The customer cannot override a refund destination.
The provider must recognize repeated refund calls and return the same refund outcome without duplicating it.

## Validation before enabling

Run backend and extension tests/builds, then run the provider's sandbox end to end. Verify normal receipt,
amount/reference mismatch, late/partial/excess/duplicate transfer, provider timeout/restart, no-liquidity
refusal, final expiry, successful USDC receipt and bank refund/manual review. Confirm real provider fees,
quote validity, settlement timing, KYC/KYB and authorization to support merchant checkout. Production mainnet
operations, regulatory/provider approval and liquidity are not implied by passing offline tests.

## UI-only demonstration build

`cd app/extension && npm run build:demo` opts in to `VITE_BANK_TRANSFER_DEMO=true`.
Selecting IBAN immediately shows **Troia Test Hesabı**, an intentionally invalid all-zero test IBAN,
a per-test explanation code and an explicitly illustrative quote (1 test USDC = 45 test TRY).
The code stays fixed while editing the same test; a new test gets a new code.
This mode never posts an intent, creates a bank transfer, polls a payment, sends USDC or marks an order paid.
It is a UI demonstration, not a bank sandbox integration. Demo details cannot be restored as a real bank checkout.
Normal `npm run build` defaults this flag to off. Use that build when connecting the real provider;
server-generated production references and the server-side verification gate remain authoritative.

## TR Mock Anchor integration (Stellar testnet)

`BANK_TRANSFER_MODE=tr-mock-anchor` selects the implemented SEP-10/38/6 adapter. No vendor API key is
required. A separate collection account signs validated SEP-10 challenges; it never shares a sequence/key
with the payout operator. The account receives Circle test USDC from the anchor. After independent Horizon
verification, the existing TroyPool pays the merchant. **Pool replenishment remains manual**. Both legs
use the same test USDC issuer. This flow is distinct from the user's own-wallet deposit/withdraw screen.

```sh
pnpm -r --filter './packages/**' build
# This explicitly creates/funds a TESTNET wallet and opens its USDC trustline. Secret stays local (0600).
TROIA_WALLET_LEDGER=/path/to/private/wallet-ledger.md node scripts/prepare-anchor-sandbox.mjs
# Do not run two backends against one pool/operator. Choose the matching deployment and durable directory.
PORT=3108 HOST=127.0.0.1 TROIA_DATA_DIR=data/iban-integration \
  node --env-file=.env.anchor --env-file=.env.bank-sandbox packages/composition/dist/main.js
# Separate terminal: spends 0.1 TEST USDC from the test pool, no real fiat/card funds.
RUN_IBAN_SANDBOX=1 node scripts/test-iban-sandbox.mjs
# Downloadable extension uses the normal build, never build:demo.
cd app/extension && npm run build
```

The extension displays the **anchor-issued IBAN, beneficiary and explanation code**, plus a testnet warning
and a “Test havalesini simüle et” button. The button calls the explicitly sandbox-only endpoint
`POST /sandbox/bank-transfer/:orderId/simulate` with a session and a persisted, random per-order capability.
The server takes the amount/transfer ID from its durable order, never the button payload. Simulation only
triggers the mock bank leg; it cannot mark a Troia order paid.

Payment verification requires the matching quote ID, transfer ID, collection account, anchor reference,
exact TRY and USDC amounts, correct asset issuer, an unrefunded completed anchor record, and a successful
Horizon transaction containing the treasury-to-collection payment. A unique receipt hash can authorize only
one order. Late/unmatched/ambiguous receipts remain under review; they never release a merchant payout.

The adapter's SQLite journal freezes the firm quote before creating the deposit. A lost create response is
recovered using that quote ID and authenticated transaction history. If recovery is missing or ambiguous,
the order stays held for reconciliation; it does not blindly create another deposit. The mock does not offer
an original-payer refund API, so a failed merchant payout goes to manual review rather than claiming a refund.
Likewise, reaching the UI deadline alone does not prove zero bank funds and does not release a reservation.

The testnet mode refuses mainnet, a different issuer, and reuse of the operator/admin key. Production banking,
KYC, original-payer refunds, provider fees and commercial approval still require the real provider integration.
The mock bank is simulated, while the USDC transactions are real **testnet** transactions. Do not send real TRY.
Reference: https://tr-mock-anchor.fly.dev/sep and https://tr-mock-anchor.fly.dev/llms-full.txt.
