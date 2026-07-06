set shell := ["bash", "-cu"]

# Default: list available recipes.
default:
    @just --list

# Build all TypeScript packages.
build:
    pnpm -r run build

# Run the test suite.
test:
    pnpm vitest run

# Lint the workspace.
lint:
    pnpm eslint .

# Format with Prettier.
format:
    pnpm prettier --write .

# Check formatting without writing.
format-check:
    pnpm prettier --check .

# Build the Soroban contract to wasm.
contract-build:
    stellar contract build

# --- Phase-gated stubs (implemented later) ---

# Pool seed in whole USDC (7 decimals under the hood).
pool_seed := "100000"

# Phase 4.4 — bootstrap the live testnet rails: 3 keypairs (friendbot XLM), the USDC SAC, a fresh
# TroyPool (roles + SAC bound at __constructor), and a pool-seed mint. Writes .env (secrets) and
# deployment.testnet.json (addresses) — BOTH git-ignored. Reuses existing keys + the deterministic
# USDC SAC; deploys a FRESH TroyPool each run (testnet contracts do not survive a reset).
fund:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    NET=testnet
    seed_stroops=$(( {{pool_seed}} * 10000000 ))
    # 1) three identities, generated once and friendbot-funded (reused on re-run)
    for name in troia-admin troia-operator troia-issuer; do
      if ! stellar keys address "$name" >/dev/null 2>&1; then
        echo "generating + funding $name"
        stellar keys generate "$name" --network "$NET" --fund
      else
        stellar keys fund "$name" --network "$NET" >/dev/null 2>&1 || true
      fi
    done
    ADMIN=$(stellar keys address troia-admin)
    OPERATOR=$(stellar keys address troia-operator)
    ISSUER=$(stellar keys address troia-issuer)
    # 2) secrets -> .env, only if absent (never clobber existing secrets)
    if [ ! -f .env ]; then
      { echo "# Troia testnet secrets (Phase 4.4). git-ignored, never commit."; \
        echo "TROIA_ADMIN_SECRET=$(stellar keys secret troia-admin)"; \
        echo "TROIA_OPERATOR_SECRET=$(stellar keys secret troia-operator)"; \
        echo "TROIA_ISSUER_SECRET=$(stellar keys secret troia-issuer)"; \
        echo "IYZICO_API_KEY="; echo "IYZICO_SECRET_KEY="; echo "WEBHOOK_SIGNING_SECRET="; } > .env
      chmod 600 .env
      echo "wrote .env (git-ignored)"
    fi
    # 3) USDC SAC — deterministic id from the asset; deploy once, reuse thereafter
    stellar contract asset deploy --asset "USDC:$ISSUER" --source-account troia-issuer --network "$NET" >/dev/null 2>&1 || true
    SAC=$(stellar contract id asset --asset "USDC:$ISSUER" --network "$NET")
    # 4) build + deploy a fresh TroyPool bound to the roles and the SAC
    stellar contract build
    POOL=$(stellar contract deploy --wasm target/wasm32v1-none/release/troy_pool.wasm \
      --source-account troia-admin --network "$NET" -- \
      --admin "$ADMIN" --operator "$OPERATOR" --usdc_sac "$SAC")
    # 5) mint the pool seed to the contract address
    stellar contract invoke --id "$SAC" --source-account troia-issuer --network "$NET" \
      -- mint --to "$POOL" --amount "$seed_stroops" >/dev/null
    # 6) write the non-secret deployment record (git-ignored)
    printf '{\n  "usdcIssuer": "%s",\n  "usdcSacContractId": "%s",\n  "troyPool": "%s",\n  "operatorPublic": "%s",\n  "adminPublic": "%s"\n}\n' \
      "$ISSUER" "$SAC" "$POOL" "$OPERATOR" "$ADMIN" > deployment.testnet.json
    echo "TroyPool $POOL seeded with {{pool_seed}} USDC; on-chain balance:"
    stellar contract invoke --id "$POOL" --source-account troia-admin --network "$NET" --send=no -- balance

# Number of demo orders (each is one real on-chain payout; the last one is the deliberate mismatch).
demo_orders := "3"

# Phase 5.3 — the live end-to-end demo: N real testnet payouts -> a recon-report -> OFFLINE verify. One order
# is a deliberate CORRUPT_LOCAL the reconciler catches. Needs `just fund` first (deployment.testnet.json +
# funded operator/pool + .env secrets). Re-runnable: order ids carry a live-ledger nonce (no replay collision).
demo:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    test -f deployment.testnet.json || { echo "no deployment.testnet.json — run 'just fund' first"; exit 1; }
    pnpm -r run build >/dev/null
    node scripts/demo.mjs {{demo_orders}}
    echo "--- offline, network-blocked verification of the freshly-generated report ---"
    node --import ./packages/reconciler/bin/block-net.mjs ./packages/reconciler/bin/verify.mjs demo/recon-report.json

# Phase 3.4 — offline reconciliation verification.
# Offline, network-blocked self-verification of the reconciliation report (Phase 3.4).
verify:
    pnpm --filter @troia/reconciler build
    node --import ./packages/reconciler/bin/block-net.mjs \
         ./packages/reconciler/bin/verify.mjs \
         ./packages/reconciler/test/fixtures/recon-report.json

# Offline verification of the LIVE report — generated from a REAL testnet pay() tx (see docs/DEPLOYMENTS.md).
# Self-verifying and reset-proof: passes with no network even after a testnet reset.
verify-live:
    pnpm --filter @troia/reconciler build
    node --import ./packages/reconciler/bin/block-net.mjs \
         ./packages/reconciler/bin/verify.mjs \
         ./packages/reconciler/test/fixtures/recon-report.live.json
