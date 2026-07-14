// RebalanceProvider — keeps the USDC pool funded (ARCHITECTURE §7 packages; Phase 4.4). `topUp` is
// async because real inventory acquisition (a CEX buy + withdrawal) settles asynchronously. Testnet uses
// SimulatedRebalance, which mints self-issued test USDC straight to the pool; mainnet swaps in a real-CEX impl
// (Phase-2, ADR-9) behind the SAME interface — no backend change.
//
// The on-chain mint is an INJECTED port so the provider's logic (fail-closed validation, per-ref idempotency) is
// pure and offline-testable; the real mint (the issuer keypair signing a USDC SAC mint to the pool C-address) is
// wired at the composition root. The provider does NOT touch the accounting ledger: it returns the amount plus
// its TRY value so the caller records the top-up (`ledger.recordTopUp` → EXTERNAL_FUNDING), keeping this package
// dependency-free and the drift check honest (mint on-chain AND book, or neither).

export interface TopUpRequest {
  /** Idempotency key for this top-up (e.g. a rebalance-cycle id). A repeat with the same ref never mints twice. */
  readonly ref: string;
  /** USDC to add to the pool, in stroops (> 0). */
  readonly usdcStroops: bigint;
  /** The TRY value of that USDC in kuruş (> 0), carried through for the caller's ledger booking. */
  readonly valueKurus: bigint;
}

export interface TopUpResult {
  readonly ref: string;
  readonly usdcStroops: bigint; // amount actually minted
  readonly valueKurus: bigint; // echoed for the caller's recordTopUp
  readonly txHash: string; // the on-chain mint tx hash
  readonly poolStroops: bigint; // observed pool balance AFTER the mint (the chain is the source of truth)
}

/** The injected on-chain seam. Real impl: the issuer signs a USDC SAC mint(pool, amount) and reads the new balance. */
export interface MintPort {
  mintToPool(usdcStroops: bigint): Promise<{ txHash: string; poolStroops: bigint }>;
}

export interface RebalanceProvider {
  topUp(req: TopUpRequest): Promise<TopUpResult>;
}

export type RebalanceErrorCode = 'InvalidRequest';

export class RebalanceError extends Error {
  readonly code: RebalanceErrorCode;
  constructor(code: RebalanceErrorCode, message: string) {
    super(message);
    this.name = 'RebalanceError';
    this.code = code;
  }
}

/**
 * Testnet rebalance: mint self-issued USDC to the pool, fail-closed and idempotent per `ref`. Concurrent calls
 * with the same ref share ONE in-flight mint (never double-mint); a completed ref stays cached and never re-mints;
 * a mint that THROWS is dropped from the cache so a later retry can mint again (nothing landed on a clean throw).
 * Cross-restart idempotency + real withdrawal finality are a Phase-2 concern (persisted, like the payout seq).
 */
export class SimulatedRebalance implements RebalanceProvider {
  private readonly inflight = new Map<string, Promise<TopUpResult>>();

  constructor(private readonly mint: MintPort) {}

  topUp(req: TopUpRequest): Promise<TopUpResult> {
    if (req.ref.length === 0) {
      return Promise.reject(new RebalanceError('InvalidRequest', 'ref must be non-empty'));
    }
    if (req.usdcStroops <= 0n) {
      return Promise.reject(new RebalanceError('InvalidRequest', 'usdcStroops must be > 0'));
    }
    if (req.valueKurus <= 0n) {
      return Promise.reject(new RebalanceError('InvalidRequest', 'valueKurus must be > 0'));
    }

    const existing = this.inflight.get(req.ref);
    if (existing) return existing; // same ref → the same operation; never a second mint

    // Store a promise that self-evicts on failure, so a clean throw (nothing minted) allows a retry, while a
    // success stays cached (a repeat returns the same result without re-minting).
    const p = this.doTopUp(req).catch((e: unknown) => {
      this.inflight.delete(req.ref);
      throw e;
    });
    this.inflight.set(req.ref, p);
    return p;
  }

  private async doTopUp(req: TopUpRequest): Promise<TopUpResult> {
    const { txHash, poolStroops } = await this.mint.mintToPool(req.usdcStroops);
    return {
      ref: req.ref,
      usdcStroops: req.usdcStroops,
      valueKurus: req.valueKurus,
      txHash,
      poolStroops,
    };
  }
}
