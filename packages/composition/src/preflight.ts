// `just preflight` — the live-smoke READINESS GATE. Before a human drives a real charge through the end-to-end
// run, this smokes every DIRTY dependency in isolation (the ones type-checked but never live-exercised offline):
// the operator account (fees), the pool USDC balance (readSacBalance), the CEX spot oracle, the Yahoo daily-close
// history, and iyzico reachability. It answers "is everything the run needs actually up + configured?" with a
// green/red report, so a missing pool balance / an unreachable RPC / a bad iyzico key is caught UP FRONT, not
// mid-demo. runPreflight is the pure, offline-testable core (injected probes); buildPreflightProbes wires the real
// adapters (network:true, live-smoked). It NEVER throws — a probe that throws becomes a red check.

import { createPaymentProvider } from '@troia/psp';
import type { NetworkConfig } from '@troia/config';
import type { OracleProvider, OracleResult, RateHistoryProvider } from '@troia/oracle';
import { HorizonAdapter, SorobanRpcAdapter } from '@troia/stellar-client/adapters';

export interface PreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
export interface PreflightReport {
  readonly ok: boolean;
  readonly checks: readonly PreflightCheck[];
}

/** The live smokes, one per dirty dependency. Each resolves with the value to judge, or THROWS if unreachable —
 *  runPreflight turns a throw into a red check (never a crash). Injectable so the report logic is offline-tested. */
export interface PreflightProbes {
  /** operator account native XLM balance (must cover pay() fees). Throws if the account is unreachable/unfunded. */
  operatorNativeXlm(): Promise<number>;
  /** pool USDC balance in stroops (smokes readSacBalance against the live SAC + TroyPool). */
  poolBalanceStroops(): Promise<bigint>;
  /** live spot mid (smokes the CEX oracle end-to-end: fetch -> derive -> aggregate). */
  spotRate(): Promise<OracleResult>;
  /** number of daily closes returned (smokes the Yahoo history fetch + parse). */
  historyCloseCount(): Promise<number>;
  /** did we reach iyzico and get a structured response (smokes creds + connectivity, no charge). */
  iyzicoReachable(): Promise<{ reached: boolean; detail: string }>;
}

export interface PreflightThresholds {
  readonly minNativeXlm?: number; // default 1 XLM
  readonly minPoolStroops?: bigint; // default 10 USDC — enough to settle a demo order
  readonly minCloses?: number; // default 3 — computeReturnStats needs a sample variance
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Format stroops (7 decimals) as a whole-ish USDC string for the human-readable report only. */
function fmtUsdc(stroops: bigint): string {
  return (Number(stroops) / 1e7).toString();
}

async function safe(name: string, fn: () => Promise<PreflightCheck>): Promise<PreflightCheck> {
  try {
    return await fn();
  } catch (e) {
    return { name, ok: false, detail: `probe failed: ${errMsg(e)}` };
  }
}

/** Run every probe (in parallel, so an all-down environment reports in one timeout window, not five in series) and
 *  fold the results into a green/red report. Pure over the injected probes. */
export async function runPreflight(
  probes: PreflightProbes,
  t: PreflightThresholds = {},
): Promise<PreflightReport> {
  const minXlm = t.minNativeXlm ?? 1;
  const minPool = t.minPoolStroops ?? 100_000_000n; // 10 USDC
  const minCloses = t.minCloses ?? 3;

  const checks = await Promise.all([
    safe('operator XLM (fees)', async () => {
      const xlm = await probes.operatorNativeXlm();
      return {
        name: 'operator XLM (fees)',
        ok: xlm >= minXlm,
        detail: `${xlm} XLM (need >= ${minXlm})`,
      };
    }),
    safe('pool USDC balance', async () => {
      const s = await probes.poolBalanceStroops();
      return {
        name: 'pool USDC balance',
        ok: s >= minPool,
        detail: `${fmtUsdc(s)} USDC (need >= ${fmtUsdc(minPool)})`,
      };
    }),
    safe('spot oracle (CEX mid)', async () => {
      const r = await probes.spotRate();
      return r.ok
        ? {
            name: 'spot oracle (CEX mid)',
            ok: true,
            detail: `mid ${r.quote.midTryPerUsdc} (x1e7) from ${r.quote.sources.join('+')}`,
          }
        : {
            name: 'spot oracle (CEX mid)',
            ok: false,
            detail: `oracle fail-closed: ${r.error.code}`,
          };
    }),
    safe('rate history (Yahoo)', async () => {
      const n = await probes.historyCloseCount();
      return {
        name: 'rate history (Yahoo)',
        ok: n >= minCloses,
        detail: `${n} daily closes (need >= ${minCloses})`,
      };
    }),
    safe('iyzico reachability', async () => {
      const r = await probes.iyzicoReachable();
      return { name: 'iyzico reachability', ok: r.reached, detail: r.detail };
    }),
  ]);

  return { ok: checks.every((c) => c.ok), checks };
}

/** Secrets the iyzico reachability probe needs (mirrors TestnetSecrets minus the Stellar operator key). */
export interface PreflightIyzicoSecrets {
  readonly apiKey: string;
  readonly secretKey: string;
  readonly webhookSigningSecret: string;
}

export interface PreflightWiring {
  readonly network: NetworkConfig;
  readonly iyzico: PreflightIyzicoSecrets;
  readonly spotOracle: OracleProvider;
  readonly history: RateHistoryProvider;
  readonly opts?: { allowHttp?: boolean; timeoutMs?: number };
}

/** Wire the REAL probes from a NetworkConfig + secrets + the live oracle/history. network:true — live-smoked, not
 *  in the offline suite. The iyzico probe uses retrieveCheckoutFormResult with a throwaway token: a structured
 *  iyzico response (even a bad-token error body) proves connectivity + that our signed request was accepted; only
 *  a transport failure (timeout/malformed) is a red. It creates NO checkout form and moves NO money. */
export function buildPreflightProbes(w: PreflightWiring): PreflightProbes {
  const rpc = new SorobanRpcAdapter(w.network.rpcUrl, w.network.passphrase, w.opts);
  const horizon = new HorizonAdapter(w.network.horizonUrl, w.opts);
  const psp = createPaymentProvider(w.network.psp, w.iyzico);

  return {
    async operatorNativeXlm() {
      const snap = await horizon.loadAccountSnapshot(w.network.operatorPublic);
      if (snap === null)
        throw new Error(`operator ${w.network.operatorPublic} not funded on Horizon`);
      const native = snap.balances.find((b) => b.asset_type === 'native');
      return native?.balance !== undefined ? Number(native.balance) : 0;
    },
    poolBalanceStroops: () =>
      rpc.readSacBalance(
        w.network.usdc.sacContractId,
        w.network.contracts.troyPool,
        w.network.operatorPublic,
      ),
    spotRate: () => w.spotOracle.getRate(),
    historyCloseCount: async () => (await w.history.dailyCloses()).length,
    async iyzicoReachable() {
      const r = await psp.retrieveCheckoutFormResult({
        conversationId: 'preflight-probe',
        token: 'preflight-probe',
      });
      if (r.kind === 'body') {
        const status = typeof r.body.status === 'string' ? r.body.status : '?';
        const errorCode =
          r.body.errorCode === undefined ? '' : `, errorCode=${String(r.body.errorCode)}`;
        return { reached: true, detail: `reached iyzico (status=${status}${errorCode})` };
      }
      return {
        reached: false,
        detail: r.kind === 'timeout' ? 'transport failure/timeout' : `malformed: ${r.reason}`,
      };
    },
  };
}
