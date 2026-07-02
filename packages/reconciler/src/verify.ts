// 3.4 offline verification core (docs/ARCHITECTURE §8). Input is ONLY the report object — no network, no DB.
// It does NOT trust the stored verdict/summary: it RECOMPUTES each order's ground truth from the embedded
// evidence and asserts every stored field equals the recomputation, then re-derives the summary. A single
// mismatch fails the whole report. The network block + positive-armed exit live in bin/verify.mjs.

import { resolveGroundTruth } from './resolve-ground-truth.js';
import { summarize } from './report.js';
import type { FieldDiff, ReconReport } from './types.js';

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

/** Recompute every order from embedded evidence and assert it matches what the report claims. */
export function verifyReport(report: ReconReport): VerifyResult {
  const failures: string[] = [];

  if (report.version !== 1) failures.push(`unsupported report version: ${report.version}`);
  const op = report.network.operator_public;
  const pass = report.network.passphrase;

  for (const o of report.orders) {
    const gt = resolveGroundTruth(o.business_intent, o.ledger_evidence, o.chain_evidence, op, pass);
    const tag = o.order_id;
    if (gt.verdict !== o.verdict) failures.push(`${tag}: verdict ${o.verdict} != recomputed ${gt.verdict}`);
    if (gt.status !== o.status) failures.push(`${tag}: status ${o.status} != recomputed ${gt.status}`);
    if (gt.signature_valid !== o.signature_valid) failures.push(`${tag}: signature_valid mismatch`);
    if (gt.hash_consistent !== o.hash_consistent) failures.push(`${tag}: hash_consistent mismatch`);
    if (gt.chain_bound !== o.chain_bound) failures.push(`${tag}: chain_bound mismatch`);
    if (!diffEqual(gt.field_diff, o.field_diff)) failures.push(`${tag}: field_diff mismatch`);
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
