import { defineManifest } from '@crxjs/vite-plugin';

// Typed MV3 manifest. Least privilege by design:
//   - the content script runs ONLY on the allowlisted storefront origin (localhost dev for now),
//   - the sole host permission is the Troia backend, so the background service worker can reach
//     /intent + /status without CORS (a content-script fetch would be blocked cross-origin),
//   - no broad permissions, no <all_urls>.
// The extension holds no keys and signs nothing; it reads the page's SEP-7 request and relays an intent.
export default defineManifest({
  manifest_version: 3,
  name: 'Troia — Pay with Troy card',
  version: '0.0.1',
  description:
    'Detects a USDC-on-Stellar (SEP-7) checkout and offers to settle it with your Troy card. Holds no keys, signs nothing.',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Troia',
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  content_scripts: [
    {
      // Port-less localhost patterns: extension match patterns match a host on ANY port, so this covers the
      // storefront whether Vite serves it on 5173, 5174, … A port-bearing pattern (http://localhost:5173/*)
      // does NOT match other ports — that was why the content script did not run on 5174.
      matches: ['http://localhost/*', 'http://127.0.0.1/*'],
      js: ['src/content.ts'],
      run_at: 'document_idle',
    },
  ],
  // Also port-less so the background can reach the backend on any local port (default :3000).
  host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
});
