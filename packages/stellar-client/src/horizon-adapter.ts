// DIRTY concrete HorizonPort over @stellar/stellar-sdk's Horizon.Server. network:true, keyless. Loads the
// destination account so the pure toAccountSnapshot can derive the trustline preflight PayoutIntent.build
// needs. A 404 (account not funded) maps to null (fail-closed: no snapshot -> no trustline -> build rejects).
// Not in the offline suite; type-checked + live-smoked later.

import { Horizon, NotFoundError } from '@stellar/stellar-sdk';
import { withTimeout } from './net-timeout.js';
import type { AccountSnapshotJson, HorizonPort } from './ports.js';

/** Per-call Horizon deadline: this read is on the /intent path, so a hung socket would freeze checkout. A timeout
 *  is NOT a NotFound, so it propagates (fail-closed: /intent errors, no charge) rather than misreading as "not
 *  funded". Overridable via opts.timeoutMs. */
const DEFAULT_HORIZON_TIMEOUT_MS = 15_000;

export class HorizonAdapter implements HorizonPort {
  private readonly server: Horizon.Server;
  private readonly timeoutMs: number;

  constructor(horizonUrl: string, opts?: { allowHttp?: boolean; timeoutMs?: number }) {
    this.server = new Horizon.Server(
      horizonUrl,
      opts?.allowHttp === true ? { allowHttp: true } : undefined,
    );
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_HORIZON_TIMEOUT_MS;
  }

  async loadAccountSnapshot(destination: string): Promise<AccountSnapshotJson | null> {
    try {
      const account = await withTimeout(
        this.server.loadAccount(destination),
        this.timeoutMs,
        'horizon.loadAccount',
      );
      return { balances: account.balances };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
}

// Match the SDK's typed error, not the RFC7807 problem-document shape: NotFoundError.response is the parsed
// problem body (not the axios response), so reading `.response.status` would be fragile. Any OTHER error
// (network/5xx/timeout) propagates — a transient failure must NOT be misread as "account not funded".
function isNotFound(e: unknown): boolean {
  return e instanceof NotFoundError;
}
