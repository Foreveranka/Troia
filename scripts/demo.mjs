// just demo — the live, one-command end-to-end proof (Phase 5.3). Drives N real operator-signed
// TroyPool.pay() payouts on testnet, collects the on-chain evidence, and emits a recon-report.json that
// `just verify` then checks OFFLINE. One order is a deliberate CORRUPT_LOCAL (the local DB amount disagrees
// with what actually settled) — the reconciler catches it, chain-as-authority.
//
// Network is USED here (this is the money path); the OFFLINE guarantee is the separate network-blocked verify
// step in the justfile. Deterministic per run via a live-ledger nonce in the order ids, so a re-run against the
// same pool never collides with the contract's per-tx_id replay guard. Requires `just fund` first
// (deployment.testnet.json + funded operator/pool + secrets in .env).

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deriveIds } from '../packages/core/dist/index.js';
import { resolveGroundTruth, summarize } from '../packages/reconciler/dist/index.js';

const N = Math.max(2, parseInt(process.argv[2] ?? '3', 10)); // >=2 so there is a clean order AND the hero
const PASS = 'Test SDF Network ; September 2015';
const HORIZON = 'https://horizon-testnet.stellar.org';
const NET = 'testnet';
const APPLIED_RATE = '411075000'; // a plausible ~41.11 TRY/USDC rate (carried + authenticated, not diffed)

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dep = JSON.parse(readFileSync('deployment.testnet.json', 'utf8'));
const { troyPool: POOL, operatorPublic: OPERATOR, usdcIssuer: ISSUER } = dep;

// A run nonce from the current ledger keeps order ids unique per run (no replay-guard collision on a re-run).
async function ledgerNonce() {
  const r = await fetch(`${HORIZON}/ledgers?order=desc&limit=1`);
  const j = await r.json();
  return String(j._embedded.records[0].sequence);
}

function ensureMerchant() {
  try {
    sh('stellar keys address troia-demo-merchant 2>/dev/null');
  } catch {
    sh(`stellar keys generate troia-demo-merchant --network ${NET} --fund`);
    sh(
      `stellar tx new change-trust --source-account troia-demo-merchant --line USDC:${ISSUER} --network ${NET}`,
    );
  }
  return sh('stellar keys address troia-demo-merchant').trim();
}

function payAndGetHash({ txIdHex, amount, merchant, memoHex }) {
  const out = sh(
    `stellar contract invoke --id ${POOL} --source-account troia-operator --network ${NET} ` +
      `-- pay --tx_id ${txIdHex} --amount ${amount} --applied_rate ${APPLIED_RATE} --merchant ${merchant} --memo ${memoHex} 2>&1`,
  );
  const m = out.match(/stellar\.expert\/explorer\/testnet\/tx\/([0-9a-f]{64})/);
  if (!m) throw new Error(`could not parse tx hash from pay() output:\n${out}`);
  return m[1];
}

async function fetchEnvelope(hash) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${HORIZON}/transactions/${hash}`);
    if (r.ok) {
      const j = await r.json();
      if (j.envelope_xdr) return { xdr: j.envelope_xdr, ledger: j.ledger };
    }
    await sleep(1500); // Horizon lag after confirmation
  }
  throw new Error(`could not fetch envelope for tx ${hash}`);
}

const nonce = await ledgerNonce();
const merchant = ensureMerchant();
console.log(`demo: pool ${POOL} | merchant ${merchant} | ${N} orders | nonce ${nonce}`);

const orders = [];
for (let i = 1; i <= N; i++) {
  const orderId = `troia-demo-${nonce}-${String(i).padStart(3, '0')}`;
  const paidStroops = String(10_000_000 * i); // i USDC on-chain (deterministic)
  const isHero = i === N; // the last order is the deliberate mismatch
  // The LOCAL DB row records a WRONG amount for the hero; tx_id/memo derive from order_id only, so the
  // on-chain settlement is faithful and only the local copy disagrees -> CORRUPT_LOCAL (chain is authority).
  const recordedStroops = isHero ? String(BigInt(paidStroops) - 1_000_000n) : paidStroops;
  const d = deriveIds(orderId, merchant, BigInt(paidStroops));

  const hash = payAndGetHash({
    txIdHex: d.txIdHex,
    amount: paidStroops,
    merchant,
    memoHex: d.memoHex,
  });
  const { xdr, ledger } = await fetchEnvelope(hash);

  const business_intent = {
    order_id: orderId,
    destination: merchant,
    amount_stroops: recordedStroops,
    memo_hex: d.memoHex,
  };
  const ledger_evidence = { signed_xdr: xdr, hash };
  const chain_evidence = {
    tx_hash: hash,
    fetched_at_ledger: ledger,
    horizon_snapshot: {
      function: 'pay',
      contract_id: POOL,
      source_account: OPERATOR,
      tx_id_hex: d.txIdHex,
      amount_stroops: paidStroops,
      applied_rate_stroops: APPLIED_RATE,
      merchant,
      memo_hex: d.memoHex,
    },
  };
  const gt = resolveGroundTruth(business_intent, ledger_evidence, chain_evidence, OPERATOR, PASS);
  orders.push({
    order_id: orderId,
    business_intent,
    ledger_evidence,
    chain_evidence,
    field_diff: gt.field_diff,
    verdict: gt.verdict,
    status: gt.status,
    signature_valid: gt.signature_valid,
    hash_consistent: gt.hash_consistent,
    chain_bound: gt.chain_bound,
  });
  console.log(
    `  ${orderId}: paid ${paidStroops}${isHero ? ` (local recorded ${recordedStroops})` : ''} -> ${gt.verdict}`,
  );
}

const report = {
  version: 1,
  seed: `troia-demo-${nonce}`,
  network: { network: 'testnet', passphrase: PASS, operator_public: OPERATOR },
  orders,
  summary: summarize(orders),
};
mkdirSync('demo', { recursive: true });
writeFileSync('demo/recon-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(`\nwrote demo/recon-report.json — summary: ${JSON.stringify(report.summary)}`);
