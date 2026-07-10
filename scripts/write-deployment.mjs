// Write the deployment record after `just bootstrap` has deployed a pool.
//
// It takes the five on-chain identifiers as arguments and MERGES them over the existing record, so the service
// endpoints (backendUrl, storefrontOrigins) survive a redeploy. Those two are what point the extension at a
// storefront and a backend; losing them on a bootstrap would silently unwire the apps. `scripts/wire-apps.mjs`
// runs next and refuses to proceed without them, so the failure is loud either way — this merge is what keeps it
// from ever happening.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'deployment.testnet.json');

const [usdcIssuer, usdcSacContractId, troyPool, operatorPublic, adminPublic] =
  process.argv.slice(2);
if (!adminPublic) {
  console.error('usage: write-deployment.mjs <issuer> <sac> <pool> <operator> <admin>');
  process.exit(1);
}

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const record = {
  usdcIssuer,
  usdcSacContractId,
  troyPool,
  operatorPublic,
  adminPublic,
  backendUrl: previous.backendUrl ?? 'http://localhost:3000',
  storefrontOrigins: previous.storefrontOrigins ?? [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ],
};
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `wrote deployment.testnet.json — COMMIT it: this is the deployment everything settles against`,
);
