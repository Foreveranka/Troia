import { defineManifest } from '@crxjs/vite-plugin';
import { BACKEND_BASE_URL, STOREFRONT_ORIGINS } from './src/lib/deployment.generated';

// Chrome match patterns carry no port: `http://localhost/*` matches every port on that host, and a port-bearing
// pattern matches none — which is why the content script once failed to run on 5174. So the manifest is
// deliberately coarser than the exact-origin allowlist the background worker enforces. Both come from the same
// deployment record, so pointing Troia at a public storefront is a change to that record, not to this file.
const hostPattern = (origin: string): string => {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
};
const STOREFRONT_PATTERNS = [...new Set(STOREFRONT_ORIGINS.map(hostPattern))];
const BACKEND_PATTERN = hostPattern(BACKEND_BASE_URL);

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
      matches: STOREFRONT_PATTERNS,
      js: ['src/content.ts'],
      run_at: 'document_idle',
    },
  ],
  host_permissions: [...new Set([...STOREFRONT_PATTERNS, BACKEND_PATTERN])],
});
