// A per-call network deadline for the DIRTY adapters (Soroban RPC + Horizon). The Stellar SDK's Server does not
// expose a per-request timeout, so we race each call against a REJECTING timeout. This is what stops a hung read
// from wedging the poll loop: main.ts guards the loop with `let polling=false; ...finally(()=>polling=false)`, so
// a read that HANGS (open socket, no bytes) would never let the finally run and every later tick would
// short-circuit — a dead poller. A timeout turns the hang into a rejection, which the loop's .catch/.finally
// convert back into "this tick failed, retry next tick". It NEVER resolves to a value on timeout, so a timed-out
// read is an ERROR, never a (mis)observed on-chain state — it can't be read as a settlement or as deadness, so it
// can never trigger a spurious replacement submit. The underlying promise is left to settle in the background
// (its socket is released by the runtime); the money-safety property is that the CALLER is unblocked.

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
