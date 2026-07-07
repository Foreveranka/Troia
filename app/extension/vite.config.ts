import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

// The crx plugin reads the typed manifest, bundles the background/content/popup entry points, and (in dev)
// wires HMR for the extension. React powers the popup UI only; the content and background logic is plain TS.
// Dev server runs on 5174 so it never collides with the storefront's 5173.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: { port: 5174, strictPort: true },
});
