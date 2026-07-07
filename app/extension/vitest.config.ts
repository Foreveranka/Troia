import { defineConfig } from 'vitest/config';

// The extension is a standalone package (its own node_modules), so it runs its own vitest. Phase 1 logic is
// pure TS plus a little DOM (adapter locator, banner, content pipeline), so the suite runs in happy-dom. No
// @troia/* aliases are needed — the extension imports no workspace package; it re-implements the small pieces
// it needs (e.g. strkey) to stay isolated and shippable on its own.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'happy-dom',
  },
});
