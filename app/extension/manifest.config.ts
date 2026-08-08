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
  name: 'Troia',
  version: '0.0.1',
  description: 'Pay with Troy card',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Troia',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  // B-11 UX: the manual-payment wizard lives in Chrome's SIDE PANEL — persistent next to the store page (a
  // popup would close the moment the iyzico tab takes focus). The only new tab in the flow is iyzico's own
  // hosted card page; the panel stays open and shows the live status/receipt. `sidePanel` grants access to
  // no site data — it is a UI-surface permission only.
  permissions: ['sidePanel'],
  side_panel: {
    default_path: 'src/wizard/index.html',
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
