import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// @troia/* resolve to package SOURCE for the test run (no build step needed), matching how the other
// packages' tests import each other by relative source path. tsc still resolves them to built dist .d.ts.
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.spec.ts'],
    environment: 'node',
    alias: {
      '@troia/backend': pkg('backend'),
      '@troia/config': pkg('config'),
      '@troia/core': pkg('core'),
      '@troia/ledger': pkg('ledger'),
      '@troia/oracle': pkg('oracle'),
      '@troia/pricing': pkg('pricing'),
      '@troia/psp': pkg('psp'),
      '@troia/rebalance': pkg('rebalance'),
      '@troia/reconciler': pkg('reconciler'),
      // the "/adapters" subpath must precede the bare package alias — first match wins, and the bare alias would
      // otherwise prefix-match "@troia/stellar-client/adapters" and mis-resolve it into <index.ts>/adapters.
      '@troia/stellar-client/adapters': fileURLToPath(
        new URL('./packages/stellar-client/src/adapters.ts', import.meta.url),
      ),
      '@troia/stellar-client': pkg('stellar-client'),
    },
  },
});
