// Pure, testable env/config parsing for the bootstrap. No side effects here (no fs/process access): main.ts reads
// process.env + the deployment file and passes the raw values in, so the FAIL-CLOSED validation is unit-tested
// without booting a server. A malformed value THROWS (a bad boot is a visible, fail-closed boot), never silently
// degrades — e.g. a POLL_INTERVAL_MS typo must not slip into a ~1ms setInterval hot loop.

import type { TestnetDeployment } from '@troia/config';

export type EnvRecord = Record<string, string | undefined>;

const INT32_MAX = 2_147_483_647;
const DEPLOYMENT_KEYS = [
  'usdcIssuer',
  'usdcSacContractId',
  'troyPool',
  'operatorPublic',
  'adminPublic',
] as const;

/** A required non-empty env var; throws (fail-closed) if absent or blank. */
export function requireEnv(env: EnvRecord, name: string): string {
  const v = env[name];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`missing required env var ${name} (fill it in .env)`);
  }
  return v;
}

/** A bounded positive-integer env var. Absent/blank -> the default, but only if the DEFAULT itself is in range;
 *  present-but-invalid (non-numeric, non-integer, or outside [min, max]) -> THROW. This is what keeps a typo like
 *  POLL_INTERVAL_MS="5s" from becoming NaN and clamping setInterval to ~1ms (a hot loop that storms iyzico +
 *  Stellar RPC), matching PORT's fail-closed shape.
 *
 *  The bound binds the default too. Two callers derive `min` from ANOTHER settable var (RECON_INTERVAL_MS from
 *  SETTLEMENT_TICK_MS; RECONCILE_INTERVAL_MS from OUTFLOW_INTERVAL_MS), so a perfectly valid setting there can lift
 *  `min` above a default that was written for the base cadence. Handing that default back would invert the very
 *  ordering the min encodes — a read-only observer running INSIDE the booking-lag window it was told to stay out
 *  of, reporting bookkeeping in flight as drift. Silently degrading is the one thing this module promises not to
 *  do, so an out-of-range default fails the boot and names the var to set. */
export function intEnv(
  env: EnvRecord,
  name: string,
  def: number,
  min: number,
  max: number = INT32_MAX,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    if (!Number.isInteger(def) || def < min || def > max) {
      throw new Error(
        `env ${name} is unset and its default ${def} is outside [${min}, ${max}] — set ${name} explicitly`,
      );
    }
    return def;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`env ${name}="${raw}" is invalid — want an integer in [${min}, ${max}]`);
  }
  return n;
}

/** Validate a parsed deployment JSON into a TestnetDeployment (all 5 addresses present + non-empty strings). */
export function parseDeployment(raw: unknown, source: string): TestnetDeployment {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${source}: not a JSON object`);
  const d = raw as Record<string, unknown>;
  for (const k of DEPLOYMENT_KEYS) {
    if (typeof d[k] !== 'string' || (d[k] as string).length === 0)
      throw new Error(`${source}: missing "${k}"`);
  }
  return {
    usdcIssuer: d.usdcIssuer as string,
    usdcSacContractId: d.usdcSacContractId as string,
    troyPool: d.troyPool as string,
    operatorPublic: d.operatorPublic as string,
    adminPublic: d.adminPublic as string,
  };
}
