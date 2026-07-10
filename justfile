set shell := ["bash", "-cu"]

# Default: list available recipes.
default:
    @just --list

# Build all TypeScript packages.
build:
    pnpm -r run build

# NOTE: vitest runs under esbuild, which STRIPS types, so this does NOT typecheck; its include is packages/**
# only, so it silently skips the extension and the contract. `just ci` is the honest gate.
# Run the packages test suite only (581 tests).
test:
    pnpm vitest run

# Mirrors .github/workflows/ci.yml one-for-one; keep them in sync. Clean installs (npm ci), so it reproduces
# CI rather than trusting whatever is in node_modules — needs the package registries.
# The full gate: every suite the repo owns, nothing skipped.
ci:
    pnpm -r run build
    pnpm vitest run
    pnpm eslint .
    pnpm prettier --check .
    (cd app/extension && npm ci && npm run build && npm test)
    (cd app/storefront && npm ci && npm run build && npm run lint)
    cargo test --locked
    just verify
    just verify-live
    just verify-tampered

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

# preflight: the live-smoke READINESS GATE. Smokes every dirty dependency the end-to-end run needs — operator
# fees, pool USDC (readSacBalance), the CEX spot oracle, the Yahoo history, and iyzico reachability — and prints a
# green/red report. Exit 0 = ready to drive a real charge; exit 1 = fix the reds first. Network IS used (a live
# probe) but it moves NO money and creates no checkout form. Run before `just serve` + a real charge.
preflight:
    pnpm -r run build
    node --env-file=.env scripts/preflight.mjs

# serve: stand up the live backend — reads .env + deployment.testnet.json, seeds the pool balance + operator
# sequence from the chain, and listens. TROIA_CALLBACK_URL is where iyzico sends the CUSTOMER'S BROWSER after
# payment; iyzico's servers never call it, and settlement is the poll worker's authenticated pull, so a
# same-machine run needs no tunnel (http://localhost:3000/return is accepted). Live — NOT part of the offline gate.
serve:
    pnpm -r run build
    node --env-file=.env packages/composition/dist/main.js

# --- Phase-gated stubs (implemented later) ---

# Pool seed in whole USDC (7 decimals under the hood).
pool_seed := "100000"

# The TroyPool is a FIXED, already-deployed contract (docs/DEPLOYMENTS.md). This recipe NEVER creates one: it
# proves the recorded pool is still on chain, tops the operator/admin/issuer up with fee XLM if this machine holds
# those keys, and re-points the storefront + extension at it.
fund:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    NET=testnet
    if [ ! -f deployment.testnet.json ]; then
      echo "no deployment.testnet.json." >&2
      echo "" >&2
      echo "Troia settles against ONE deployed TroyPool (docs/DEPLOYMENTS.md), and this recipe never creates one." >&2
      echo "  the record ships with the repo — restore it with 'git checkout -- deployment.testnet.json'" >&2
      exit 1
    fi
    POOL=$(node -p "require('./deployment.testnet.json').troyPool")
    OP=$(node -p "require('./deployment.testnet.json').operatorPublic")
    # "the pool is gone" and "I cannot see the pool" are different facts. scripts/pool-state.mjs proves which.
    case "$(node scripts/pool-state.mjs "$NET")" in
      live) ;;
      absent)
        echo "the recorded TroyPool $POOL is not on chain — the network answers, and the contract is not there." >&2
        echo "That is a testnet reset. Recovery is 'just bootstrap'; afterwards update docs/DEPLOYMENTS.md." >&2
        exit 1 ;;
      *)
        echo "could not see the network, so nothing is concluded about TroyPool $POOL." >&2
        echo "Fix connectivity (or the stellar CLI) and try again. Do NOT run 'just bootstrap' on a guess." >&2
        exit 1 ;;
    esac
    # Fee XLM, only for identities this machine actually holds. A clone that only has .env holds none, and that
    # is fine: the secrets, not the CLI keystore, are what sign.
    for name in troia-admin troia-operator troia-issuer; do
      stellar keys fund "$name" --network "$NET" >/dev/null 2>&1 || true
    done
    echo "TroyPool $POOL is live; on-chain balance:"
    stellar contract invoke --id "$POOL" --source-account "$OP" --network "$NET" --send=no -- balance
    node scripts/wire-apps.mjs

# RESET RECOVERY ONLY: replace the TroyPool that a testnet reset erased.
#
# A SECOND POOL MUST NEVER BE DEPLOYED. It would orphan the recorded one, its balance, and every explorer link and
# recon report that names it. So this runs on exactly ONE condition: the deployment record exists, the network
# answers, and the recorded pool is NOT on it — proof the contract is gone, not a guess that it might be. A live
# pool refuses. A network we cannot see refuses. A MISSING record refuses too, because a record deleted by hand is
# not evidence that the pool it named has vanished. There is no override flag; abandoning a live pool means
# changing the committed deployment.testnet.json in a reviewed commit, deliberately.
#
# DRY_RUN=1 prints the decision and stops before touching anything.
bootstrap:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    NET=testnet
    seed_stroops=$(( {{pool_seed}} * 10000000 ))
    if [ ! -f deployment.testnet.json ]; then
      echo "refusing: there is no deployment.testnet.json to prove anything about." >&2
      echo "The record ships with the repo. Restore it: git checkout -- deployment.testnet.json" >&2
      echo "This recipe only replaces a pool a testnet reset erased; it never deploys on a missing record." >&2
      exit 1
    fi
    POOL=$(node -p "require('./deployment.testnet.json').troyPool")
    case "$(node scripts/pool-state.mjs "$NET")" in
      live)
        echo "refusing: TroyPool $POOL is deployed and live." >&2
        echo "A second pool would orphan it, along with its balance and every link that points at it." >&2
        echo "Abandoning it is a deliberate act: change deployment.testnet.json in a reviewed commit first." >&2
        exit 1 ;;
      absent)
        echo "the recorded TroyPool $POOL is absent from a network that answers — a reset. Replacing it." ;;
      *)
        echo "refusing: could not see the network, so the recorded TroyPool $POOL might still be live." >&2
        echo "A second pool must never be deployed on a guess. Fix connectivity and try again." >&2
        exit 1 ;;
    esac
    if [ "${DRY_RUN:-}" = "1" ]; then echo "DRY_RUN: the guard allows a deploy; stopping before any change."; exit 0; fi
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
      { echo "# Troia testnet secrets. git-ignored, never commit."; \
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
    # 4) build + deploy the TroyPool bound to the roles and the SAC
    stellar contract build
    POOL=$(stellar contract deploy --wasm target/wasm32v1-none/release/troy_pool.wasm \
      --source-account troia-admin --network "$NET" -- \
      --admin "$ADMIN" --operator "$OPERATOR" --usdc_sac "$SAC")
    # 5) mint the pool seed to the contract address
    stellar contract invoke --id "$SAC" --source-account troia-issuer --network "$NET" \
      -- mint --to "$POOL" --amount "$seed_stroops" >/dev/null
    # 6) rewrite the committed deployment record (endpoints are merged, never dropped)
    node scripts/write-deployment.mjs "$ISSUER" "$SAC" "$POOL" "$OPERATOR" "$ADMIN"
    echo "TroyPool $POOL seeded with {{pool_seed}} USDC; on-chain balance:"
    stellar contract invoke --id "$POOL" --source-account troia-admin --network "$NET" --send=no -- balance
    # 7) point the storefront + extension at THIS deployment (they cannot import @troia/config)
    node scripts/wire-apps.mjs
    echo ""
    echo "A NEW pool was deployed. docs/DEPLOYMENTS.md now has a stale address table — update it, and COMMIT"
    echo "the new deployment.testnet.json: it is the identity everything settles against."

# Re-point the storefront + extension at the current deployment.testnet.json (`just fund` does this for you).
wire:
    node scripts/wire-apps.mjs

# Number of demo orders (each is one real on-chain payout; the last one is the deliberate mismatch).
demo_orders := "3"

# Phase 5.3 — the live end-to-end demo: N real testnet payouts -> a recon-report -> OFFLINE verify. One order
# is a deliberate CORRUPT_LOCAL the reconciler catches. Needs `just fund` first (deployment.testnet.json +
# funded operator/pool + .env secrets). Re-runnable: order ids carry a live-ledger nonce (no replay collision).
demo:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    test -f deployment.testnet.json || { echo "no deployment.testnet.json — see 'just fund' (it explains what to do)"; exit 1; }
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

# Forges the honest report in a temp file and proves the verifier catches it by RE-DERIVATION (verify exit 1),
# not by failing to read it (verify exit 2). Writes nothing into the repo, so it runs on a bare clone in any order.
# The NEGATIVE half of the offline proof: a lie cannot pass.
verify-tampered:
    pnpm --filter @troia/reconciler build
    node scripts/tamper-check.mjs
