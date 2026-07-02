// (a)↔(c) SEMANTIC field-diff. `local_value` always comes from the DB business_intent, NEVER decoded from
// the XDR (that separation is the whole point of the three-artifact model). Mapping (docs/ARCHITECTURE §8):
//   business_intent.destination ⇄ pay() merchant (arg3) · amount_stroops ⇄ i128 (arg1) · memo_hex ⇄ BytesN<32> (arg4).
// applied_rate is intentionally NOT diffed (the ledger is its audit source).

import { addressEqual, amountEqual, hexEqual } from './normalize.js';
import type { BusinessIntent, ChainSnapshotProjection, FieldDiff } from './types.js';

export function computeDiffs(a: BusinessIntent, c: ChainSnapshotProjection): FieldDiff[] {
  return [
    {
      field: 'amount',
      local_value: a.amount_stroops,
      chain_value: c.amount_stroops,
      equal: amountEqual(a.amount_stroops, c.amount_stroops),
    },
    {
      field: 'destination',
      local_value: a.destination,
      chain_value: c.merchant,
      equal: addressEqual(a.destination, c.merchant),
    },
    {
      field: 'memo',
      local_value: a.memo_hex,
      chain_value: c.memo_hex,
      equal: hexEqual(a.memo_hex, c.memo_hex),
    },
  ];
}

/** business_intent == snapshot (IC) — all fields semantically equal. */
export function intentEqualsChain(diffs: readonly FieldDiff[]): boolean {
  return diffs.every((d) => d.equal);
}

/** Only the differing fields (what the report surfaces; [] means matched). */
export function differing(diffs: readonly FieldDiff[]): FieldDiff[] {
  return diffs.filter((d) => !d.equal);
}
