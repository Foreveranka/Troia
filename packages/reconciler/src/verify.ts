// 3.4 offline verification core (docs/ARCHITECTURE §8). Inputs: the report object + TWO anchors supplied by the
// caller from the committed deployment record and NEVER read from the report — the CANONICAL operator key (WHO
// signed) and the CANONICAL TroyPool (WHERE the money went). No network, no DB. It does NOT trust the stored
// verdict/summary: it RECOMPUTES each order's ground truth from the embedded evidence — re-deriving every
// signature against the CANONICAL operator — and asserts every stored field equals the recomputation, then
// re-derives the summary. It also fails the report when its declared operator_public does not equal the canonical
// one, so a self-signed forgery (attacker names + signs with its own key) cannot pass. A single mismatch fails the
// whole report. The network block + positive-armed exit + anchor resolution live in bin/verify.mjs.

import { decodeSignedPay } from './decode.js';
import { addressEqual } from './normalize.js';
import { resolveGroundTruth } from './resolve-ground-truth.js';
import { summarize } from './report.js';
import type { FieldDiff, OrderReportEntry, ReconReport } from './types.js';

export interface VerifyResult {
  readonly ok: boolean;
  readonly ordersVerified: number;
  readonly summary: ReconReport['summary'];
  readonly failures: readonly string[];
}

function diffEqual(a: readonly FieldDiff[], b: readonly FieldDiff[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      y !== undefined &&
      x.field === y.field &&
      x.local_value === y.local_value &&
      x.chain_value === y.chain_value &&
      x.equal === y.equal
    );
  });
}

/**
 * The SECOND anchor. A valid operator signature proves WHO signed, never WHERE the money went: an operator-signed
 * `pay()` to a look-alike contract moves no USDC out of the canonical TroyPool, yet is entirely self-consistent —
 * its chain snapshot can carry the same look-alike id, so decode ≡ snapshot holds and the whole cascade resolves
 * MATCHED. `contract_id` is otherwise only ever compared BETWEEN two projections the report itself supplies, so
 * nothing inside the report can catch this: the anchor has to come from outside, exactly like the operator key.
 * Pin BOTH sides — the decoded XDR (the authentic witness) and the chain snapshot (the report's claim about the
 * chain) — so neither a forged witness nor a forged observation can name a contract this deployment never used.
 */
function pinSettlementContract(
  o: OrderReportEntry,
  canonicalTroyPool: string,
  passphrase: string,
): readonly string[] {
  const failures: string[] = [];

  let signedContract: string;
  try {
    signedContract = decodeSignedPay(o.ledger_evidence.signed_xdr, passphrase).projection
      .contract_id;
  } catch {
    return failures; // unreadable witness — already convicted EVIDENCE_TAMPERED; there is no contract to pin.
  }
  if (!addressEqual(signedContract, canonicalTroyPool)) {
    failures.push(
      `${o.order_id}: signed pay() invokes ${signedContract} != canonical TroyPool ${canonicalTroyPool}`,
    );
  }

  const observed = o.chain_evidence?.horizon_snapshot.contract_id;
  if (observed !== undefined && !addressEqual(observed, canonicalTroyPool)) {
    failures.push(
      `${o.order_id}: chain snapshot names ${observed} != canonical TroyPool ${canonicalTroyPool}`,
    );
  }
  return failures;
}

/** Recompute every order from embedded evidence and assert it matches what the report claims. */
export function verifyReport(
  report: ReconReport,
  canonicalOperatorPublic: string,
  canonicalTroyPool: string,
): VerifyResult {
  const failures: string[] = [];

  if (report.version !== 1) failures.push(`unsupported report version: ${report.version}`);
  // Pin the trust anchor to a value from OUTSIDE the report. `operator_public` is data the report carries, so a
  // forged report could name (and self-sign with) an attacker's key; checking signatures against the report's own
  // key would then always pass. We (1) fail the report if its declared operator ≠ canonical, and (2) re-derive
  // every signature against the CANONICAL key — so even absent (1), a forged report re-derives to EVIDENCE_TAMPERED.
  if (report.network.operator_public !== canonicalOperatorPublic) {
    failures.push(
      `operator_public ${report.network.operator_public} != canonical ${canonicalOperatorPublic}`,
    );
  }
  const op = canonicalOperatorPublic;
  const pass = report.network.passphrase;

  for (const o of report.orders) {
    const gt = resolveGroundTruth(o.business_intent, o.ledger_evidence, o.chain_evidence, op, pass);
    const tag = o.order_id;
    if (gt.verdict !== o.verdict)
      failures.push(`${tag}: verdict ${o.verdict} != recomputed ${gt.verdict}`);
    if (gt.status !== o.status)
      failures.push(`${tag}: status ${o.status} != recomputed ${gt.status}`);
    if (gt.signature_valid !== o.signature_valid) failures.push(`${tag}: signature_valid mismatch`);
    if (gt.hash_consistent !== o.hash_consistent) failures.push(`${tag}: hash_consistent mismatch`);
    if (gt.chain_bound !== o.chain_bound) failures.push(`${tag}: chain_bound mismatch`);
    if (!diffEqual(gt.field_diff, o.field_diff)) failures.push(`${tag}: field_diff mismatch`);
    failures.push(...pinSettlementContract(o, canonicalTroyPool, pass));
  }

  // Re-derive the summary from the (already-verified) statuses and compare to the stored one.
  const recomputed = summarize(report.orders);
  const stored = report.summary;
  if (
    recomputed.total !== stored.total ||
    recomputed.matched !== stored.matched ||
    recomputed.mismatch !== stored.mismatch ||
    recomputed.unsettled !== stored.unsettled
  ) {
    failures.push(`summary ${JSON.stringify(stored)} != recomputed ${JSON.stringify(recomputed)}`);
  }

  return {
    ok: failures.length === 0,
    ordersVerified: report.orders.length,
    summary: recomputed,
    failures,
  };
}
