import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/target/**', '**/*.wasm'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Underscore-prefixed args/vars are intentionally unused (e.g. a patched runtime function that must
    // keep its original signature). Honor the convention instead of forcing a lint-disable comment.
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Plain Node CLI scripts (the offline `just verify` harness) run under the Node runtime, so provide its
    // global identifiers. They are not TypeScript, so the type-checker cannot supply these for them.
    files: ['**/bin/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        globalThis: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
  },
);
