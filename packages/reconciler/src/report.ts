// 3.3 recon-report.json builder. Embeds all three artifacts per order (self-verifying; the signed parts are
// reset-proof) and derives verdict/status/summary via resolveGroundTruth. The report is the ONLY input to
// offline `verify` — no network, no DB. See docs/ARCHITECTURE §8.

import { resolveGroundTruth } from './resolve-ground-truth.js';
import type {
  BusinessIntent,
  ChainEvidence,
  LedgerEvidence,
  OrderReportEntry,
  ReconReport,
  ReportNetwork,
} from './types.js';

export interface OrderInput {
  readonly business_intent: BusinessIntent;
  readonly ledger_evidence: LedgerEvidence;
  readonly chain_evidence: ChainEvidence | null;
}

export function summarize(orders: readonly OrderReportEntry[]): ReconReport['summary'] {
  const s = { total: orders.length, matched: 0, mismatch: 0, unsettled: 0 };
  for (const o of orders) s[o.status] += 1;
  return s;
}

function toEntry(input: OrderInput, network: ReportNetwork): OrderReportEntry {
  const gt = resolveGroundTruth(
    input.business_intent,
    input.ledger_evidence,
    input.chain_evidence,
    network.operator_public,
    network.passphrase,
  );
  return {
    order_id: input.business_intent.order_id,
    business_intent: input.business_intent,
    ledger_evidence: input.ledger_evidence,
    chain_evidence: input.chain_evidence,
    field_diff: gt.field_diff,
    verdict: gt.verdict,
    status: gt.status,
    signature_valid: gt.signature_valid,
    hash_consistent: gt.hash_consistent,
    chain_bound: gt.chain_bound,
  };
}

/** Orders are processed SERIALLY (§4 head-of-line: one payout in flight at a time). */
export function buildReconReport(
  seed: string,
  network: ReportNetwork,
  inputs: readonly OrderInput[],
): ReconReport {
  const orders = inputs.map((i) => toEntry(i, network));
  return { version: 1, seed, network, orders, summary: summarize(orders) };
}
