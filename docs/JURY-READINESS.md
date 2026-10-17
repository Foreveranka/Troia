# Troia testnet demo and operator runbook

The product is a Chrome extension. The root website introduces Troia and offers the ZIP; the separate demo
store provides a supported Stellar checkout. Card and IBAN checkout do not require a shopper wallet.
Freighter is needed only for deposits/withdrawals to the shopper's own wallet.

## Try the product

1. Visit https://troiapay.xyz, download the ZIP, extract it, then load `troia-testnet` in desktop Chrome's
   Extensions page with Developer mode enabled. There is no Chrome Web Store listing. Replacing the files
   in an already loaded extension folder requires reloading that extension and refreshing the store tab.
2. Open https://troia-demo-store.vercel.app. Choose a test product, then **Pay with crypto → Stellar**.
   Troia detects the supported SEP-7 payment request.
3. For card checkout, choose **Troy kartı**. Use only the official iyzico sandbox Troy test card
   `9792072000017956`, future expiry such as `12/2030`, CVC `123`, name `Test User`.
   [Official test cards](https://docs.iyzico.com/ek-bilgiler/test-kartlari).
4. For IBAN checkout, choose **Banka transferi (IBAN)**. Read the anchor's test IBAN, beneficiary, exact TRY
   amount, reference and deadline. Press **Test havalesini simüle et**. Do not transfer real money.
5. Wait for USDC settlement and inspect the receipt. The simulation button does not complete the order:
   the server independently verifies the anchor receipt and onchain credit before authorizing pool payout.
6. Alternatively, **IBAN ile ödeme** in Troia opens the manual merchant-payment panel. Enter a personal
   or merchant Stellar address and USDC amount. Exchange deposit addresses requiring a memo are unsupported.
7. **Yatır / çek** is the separate own-wallet anchor panel. Connect Freighter on Stellar Testnet. Never
   enter a secret key into Troia. Check pending withdrawal history before signing/sending again.

The bank and KYC legs are simulated. USDC transfers occur on Stellar Testnet. This is not a real BiLira
integration, a mainnet launch or a real goods purchase. Partial/excess/late or ambiguous receipts require
review. Mock original-payer refunds are unsupported and cannot be claimed as completed.

## Evidence

- [Current identifiers and transaction evidence](DEPLOYMENTS.md)
- [IBAN test evidence, 16 October](evidence/iban-sandbox-2026-10-16.json)
- [IBAN adapter and provider contract](bank-transfer-integration.md)
- [Month 2 delivery checklist](MONTH2-DELIVERY.md)

## Persistent backend

Public API: https://api.troiapay.xyz. The website's existing `/api` prefix proxies to it, so the extension's
backend URL stays unchanged. A Linux systemd service owns the settlement writer; no development computer
or temporary Cloudflare tunnel is needed.

- Code: `/opt/troia/current` → immutable release under `/opt/troia/releases/`.
- Dedicated unprivileged account: `troia`; localhost listener `127.0.0.1:3108`.
- State: `/var/lib/troia/state/<pool>/`, including **both SQLite databases and all append-only journals**.
- Secrets: `/etc/troia/backend.env`, root-owned `0600`, loaded by systemd. Never commit or publish it.
- Service definition: [ops/troia.service](../ops/troia.service). Enabled at boot; automatic restart after exit.
- Startup wrapper: [ops/start-backend.sh](../ops/start-backend.sh). A kernel flock protects the full Node
  lifetime. A leftover application lock is removed only after positively proving its PID is dead.
  A live PID, corrupt record or unknown owner stays fail-closed.
- Memory/CPU limits keep the service bounded on a shared VPS. Existing services and firewall rules are preserved.
- Caddy terminates HTTPS and forwards only customer API paths. `/metrics` remains private on localhost.

```sh
sudo systemctl status troia.service
sudo journalctl -u troia.service -n 50 --no-pager
curl --fail https://api.troiapay.xyz/healthz
sudo systemctl restart troia.service
```

`/healthz` verifies startup, not the ongoing health of every payment/rate dependency. A live dependency
outage must not fabricate a price or payment success. Settlement worker errors are logged and retried;
a durable log failure stops the process. Startup validates pool/operator identity and the testnet anchor.
The own-wallet panel still has browser-local withdrawal recovery limitations.

## Release and data migration

Build and test the packages locally; the VPS uses an isolated production runtime rather than installing
or rebuilding dependencies for other projects. Validate the compiled runtime on the VPS before activating it.
Do not run two backends against the same pool/operator, even on different machines.

Before moving a writer, stop accepting orders, let paid orders settle/book, stop the source service, then
copy a consistent snapshot of the **entire** pool directory. Preserve reservations, sequence/channel maps,
anchor transfer mappings, receipt deduplication and journals together. Never initialize a fresh journal over
an existing funded pool. Checkpoint SQLite only while the writer is stopped. Keep the source copy as backup.
Disable the source machine's login service before starting the VPS writer.

Before switching `/opt/troia/current`, retain the old release and a consistent state backup. Restart the
service and verify old order receipts, zero unexplained drift and a small testnet checkout. A code rollback
must remain compatible with the migrated state; do not roll back to a version that cannot read IBAN orders.

To change the website proxy without changing extension permissions:

```sh
TROIA_API_UPSTREAM=https://api.troiapay.xyz node scripts/package-demo-sites.mjs
# Confirm the linked project before deploying from .deploy/intro.
vercel project inspect --non-interactive --cwd .deploy/intro
vercel deploy --prod --yes --cwd .deploy/intro
```

## Manual pool funding

Merchant payouts are automatic after verified payment; replenishment is deliberately manual. The anchor
collection account is separate from the pool/operator and does not automatically refill the pool.

For a top-up, stop the writer after in-flight payouts are booked, save a backup, send the configured Circle
test USDC to the pool, then use `manual-topup.js` with the confirmed transaction hash and TRY accounting value.
Run the tool against the **same** state directory and deployment while the server is stopped. It verifies
SAC/admin/pool evidence, rejects duplicates and unexplained balance movements. Do not mint this external
issuer's asset or suppress drift alarms. Start the service and verify the balance again.

## Month 2 boundary

The SOW and other external Google documents are not modified by this repository update. The submission
must distinguish the mock bank input from real testnet USDC settlement. Optional real virtual POS work,
mainnet go-live, contract audit and liquidity provisioning are not represented as completed deliverables.
