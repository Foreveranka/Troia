// Phase 3 wire + in-memory contract for the three-artifact reconciler (docs/ARCHITECTURE.md §8).
// Stroops and rates are DECIMAL STRINGS on the wire (JSON has no bigint); hashes/memos/tx_ids are
// LOWERCASE HEX. The reconciler is keyless & buildless: it imports @stellar/stellar-base only to
// decode/verify, never to sign (enforced by test/no-signing-in-src.spec.ts).

/** (a) business_intent — the LOCAL DB row. MUTABLE. `local_value` in a diff always comes from here. */
export interface BusinessIntent {
  readonly order_id: string; // canonical NFC
  readonly destination: string; // merchant StrKey, G… or C…
  readonly amount_stroops: string; // i128 stroops, decimal string (USDC 7-dec)
  readonly memo_hex: string; // 64-char lowercase hex (pay() BytesN<32> memo ARG)
}

/** (b) ledger_evidence — the FROZEN cryptographic witness. Opaque blob + its Stellar tx hash. */
export interface LedgerEvidence {
  readonly signed_xdr: string; // base64 TransactionEnvelope; opaque; NEVER recomputed from (a)
  readonly hash: string; // hex of Transaction(signed_xdr, passphrase).hash() — the Stellar tx hash
  readonly blob_sha256?: string; // OPTIONAL integrity tripwire = sha256(base64-decoded blob); never == tx hash
}

/** Normalized projection of the pay() invocation — one normalizer feeds this AND the decode(xdr) side. */
export interface ChainSnapshotProjection {
  readonly function: 'pay';
  readonly contract_id: string; // TroyPool C-address
  readonly source_account: string; // submitting operator G-address
  readonly tx_id_hex: string; // pay() arg0 BytesN<32>, 64-hex
  readonly amount_stroops: string; // pay() arg1 i128 → decimal string
  readonly applied_rate_stroops: string; // pay() arg2 i128 → decimal string (CARRIED, NOT diffed)
  readonly merchant: string; // pay() arg3 Address → canonical StrKey
  readonly memo_hex: string; // pay() arg4 BytesN<32> → 64-hex
}

/** (c) chain_evidence — the FROZEN snapshot of "what the chain looked like when observed". */
export interface ChainEvidence {
  readonly tx_hash: string; // hex; MUST equal Transaction.hash() == ledger_evidence.hash
  readonly fetched_at_ledger: number; // ledger seq at observation
  readonly horizon_snapshot: ChainSnapshotProjection;
}

export type Verdict =
  'MATCHED' | 'CORRUPT_LOCAL' | 'EVIDENCE_TAMPERED' | 'CHAIN_DIVERGENCE' | 'UNSETTLED';

export type OrderStatus = 'matched' | 'mismatch' | 'unsettled';

export interface FieldDiff {
  readonly field: 'amount' | 'destination' | 'memo';
  readonly local_value: string; // from (a) business_intent — NOT decoded from XDR
  readonly chain_value: string; // from (c) horizon_snapshot projection
  readonly equal: boolean; // SEMANTIC equality
}

/** The deterministic output of resolveGroundTruth (discriminated by `verdict`). */
export interface GroundTruth {
  readonly verdict: Verdict;
  readonly status: OrderStatus;
  readonly signature_valid: boolean;
  readonly hash_consistent: boolean; // recomputed_hash === ledger_evidence.hash (b self-consistency)
  readonly chain_bound: boolean; // ledger_evidence.hash === chain_evidence.tx_hash (bitwise)
  readonly field_diff: readonly FieldDiff[]; // (a)↔(c); [] when MATCHED
}

/** Per-order report entry — embeds all three artifacts (self-verifying; reset-proof for the signed parts). */
export interface OrderReportEntry {
  readonly order_id: string;
  readonly business_intent: BusinessIntent;
  readonly ledger_evidence: LedgerEvidence;
  readonly chain_evidence: ChainEvidence | null; // null after testnet reset / never landed → UNSETTLED
  readonly field_diff: readonly FieldDiff[];
  readonly verdict: Verdict;
  readonly status: OrderStatus;
  readonly signature_valid: boolean;
  readonly hash_consistent: boolean;
  readonly chain_bound: boolean;
}

export interface ReportNetwork {
  readonly network: 'testnet' | 'mainnet';
  readonly passphrase: string; // read as DATA by verify (needed to recompute the tx hash)
  readonly operator_public: string; // PINNED trust anchor (the signer key)
}

export interface ReconReport {
  readonly version: 1;
  readonly seed: string;
  readonly network: ReportNetwork;
  readonly orders: readonly OrderReportEntry[];
  readonly summary: {
    readonly total: number;
    readonly matched: number;
    readonly mismatch: number;
    readonly unsettled: number;
  };
}

export function verdictToStatus(verdict: Verdict): OrderStatus {
  switch (verdict) {
    case 'MATCHED':
      return 'matched';
    case 'UNSETTLED':
      return 'unsettled';
    case 'CORRUPT_LOCAL':
    case 'EVIDENCE_TAMPERED':
    case 'CHAIN_DIVERGENCE':
      return 'mismatch';
  }
}
