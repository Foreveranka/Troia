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

# Phase 4.4 — friendbot XLM + SAC deploy + mint pool seed.
fund:
    @echo "just fund — implemented in Phase 4.4"

# Phase 5.3 — deterministic N-order demo run.
demo:
    @echo "just demo — implemented in Phase 5.3"

# Phase 3.4 — offline reconciliation verification.
# Offline, network-blocked self-verification of the reconciliation report (Phase 3.4).
verify:
    pnpm --filter @troia/reconciler build
    node --import ./packages/reconciler/bin/block-net.mjs \
         ./packages/reconciler/bin/verify.mjs \
         ./packages/reconciler/test/fixtures/recon-report.json
