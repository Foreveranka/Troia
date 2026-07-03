// DIRTY concrete HorizonPort over @stellar/stellar-sdk's Horizon.Server. network:true, keyless. Loads the
// destination account so the pure toAccountSnapshot can derive the trustline preflight PayoutIntent.build
// needs. A 404 (account not funded) maps to null (fail-closed: no snapshot -> no trustline -> build rejects).
// Not in the offline suite; type-checked + live-smoked later.

import { Horizon, NotFoundError } from '@stellar/stellar-sdk';
import type { AccountSnapshotJson, HorizonPort } from './ports.js';

export class HorizonAdapter implements HorizonPort {
  private readonly server: Horizon.Server;

  constructor(horizonUrl: string, opts?: { allowHttp?: boolean }) {
    this.server = new Horizon.Server(
      horizonUrl,
      opts?.allowHttp === true ? { allowHttp: true } : undefined,
    );
  }

  async loadAccountSnapshot(destination: string): Promise<AccountSnapshotJson | null> {
    try {
      const account = await this.server.loadAccount(destination);
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
