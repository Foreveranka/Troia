// The solvency tripwire. Everything else in this system asks "did this order settle correctly?"; this asks the
// one question no per-order check can: "is the pool still holding what our books say it should?"
//
// It is the only detector that does not depend on knowing what to look for. The chain-event tail that a later
// step adds is precise but bounded by RPC event retention — it can only see the recent past, and a tailer that
// was down longer than that window has a permanent blind spot. A balance comparison has no window: it reads the
// pool's balance now and weighs it against the ledger's expectation, so value that left by ANY route — a leaked
// operator key, an upgraded contract, an unbooked mint, a clawback — shows up as a number that does not add up.
// It cannot say who or when. It can always say whether.
//
// It never re-seeds, never corrects, never absorbs. A drift is reported and stays reported: silently adopting
// the chain's number as the new expectation is exactly how a theft becomes the baseline.
//
// TRANSIENT vs REAL. Booking lags reality by design: the USDC leaves the pool when pay() lands, and the ledger
// records it on the next settlement tick; a mint lands and is booked in the same breath but not the same instant.
// So a single out-of-sync reading proves nothing — it is usually just a payout waiting to be booked. What proves
// something is PERSISTENCE: a bookkeeping lag closes within a settlement tick, while a leak does not close at
// all. The monitor therefore alarms only after the drift survives several consecutive readings, and it reports
// every reading in between so nothing is hidden while it waits.

/** What the tick needs. Structural, so this file depends on neither the ledger package nor a Stellar client. */
export interface DriftDeps {
  readonly stellar: { readPoolBalanceStroops(): Promise<bigint> };
  readonly ledger: {
    detectDrift(observedPoolStroops: bigint): {
      readonly expectedPoolStroops: bigint;
      readonly observedPoolStroops: bigint;
      readonly driftStroops: bigint;
      readonly inSync: boolean;
    };
  };
}

export interface DriftTickReport {
  readonly expectedPoolStroops: bigint;
  readonly observedPoolStroops: bigint;
  /** observed − expected. Negative: the chain holds LESS than the books say — value left unrecorded. */
  readonly driftStroops: bigint;
  readonly inSync: boolean;
}

/**
 * Read the live pool balance and compare it to the ledger's expectation.
 *
 * A read failure THROWS rather than reporting `inSync` — an alarm that goes quiet when it cannot see is worse
 * than no alarm. The caller treats a throw as "could not check this tick" and retries; it must never treat it
 * as "checked, and everything is fine".
 */
export async function checkDrift(deps: DriftDeps): Promise<DriftTickReport> {
  const observed = await deps.stellar.readPoolBalanceStroops();
  return deps.ledger.detectDrift(observed);
}

// ---------------------------------------------------------------------------------------------------------
// Persistence filter
// ---------------------------------------------------------------------------------------------------------

/** How many consecutive out-of-sync readings before a drift is treated as real rather than a booking lag. The
 *  recon interval must exceed the settlement interval, so three readings is comfortably longer than the window
 *  in which a landed payout is still waiting to be booked. */
export const DEFAULT_DRIFT_ALARM_AFTER = 3;

export interface DriftMonitorState {
  readonly consecutiveOutOfSync: number;
  /** true once an alarm has fired for the current episode, so it is raised once and not on every later tick. */
  readonly alarmed: boolean;
}

export const INITIAL_DRIFT_STATE: DriftMonitorState = { consecutiveOutOfSync: 0, alarmed: false };

export interface DriftObservation {
  readonly state: DriftMonitorState;
  /** Raise the alarm now: the drift has persisted past a plausible booking lag, and this is its first firing. */
  readonly alarm: boolean;
  /** The drift is present but still within the lag window — worth logging, not yet worth waking anyone. */
  readonly settling: boolean;
  /** The books and the chain agree again. */
  readonly recovered: boolean;
}

/**
 * Fold one reading into the monitor. Pure, so the alarm policy is testable without a clock or a chain.
 *
 * A recovery resets the episode, because a drift that closes by itself WAS the booking lag. A drift that never
 * closes fires once and then stays quiet — it is already a page; repeating it every tick only trains people to
 * ignore it. The count is what carries the memory, and it is deliberately not reset by the drift CHANGING: a
 * leak that grows is still the same leak.
 */
export function observeDrift(
  prev: DriftMonitorState,
  report: DriftTickReport,
  alarmAfter: number = DEFAULT_DRIFT_ALARM_AFTER,
): DriftObservation {
  if (report.inSync) {
    return {
      state: INITIAL_DRIFT_STATE,
      alarm: false,
      settling: false,
      recovered: prev.consecutiveOutOfSync > 0,
    };
  }
  const consecutiveOutOfSync = prev.consecutiveOutOfSync + 1;
  const due = consecutiveOutOfSync >= alarmAfter;
  const alarm = due && !prev.alarmed;
  return {
    state: { consecutiveOutOfSync, alarmed: prev.alarmed || due },
    alarm,
    settling: !due,
    recovered: false,
  };
}
