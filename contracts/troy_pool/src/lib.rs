#![no_std]

//! TroyPool — the single Soroban contract. It holds USDC custody (the pool = this contract's SAC
//! balance) and moves it with `pay()`. Money-safety design (docs/ARCHITECTURE.md §5/§6):
//!   - Invariant ② DOUBLE-PAY SHIELD (contract half): a per-`tx_id` replay guard in `Persistent`
//!     storage. The primary shield is the operator's sequence (`txBAD_SEQ`); `Processed(tx_id)` is the
//!     ONLY shield once channel accounts break the single-sequence assumption (Phase 2), so it must
//!     never live in `Temporary`/`Instance` storage (archival → replay → double pay).
//!   - Invariant ③a SOLVENCY (contract half): `balance >= amount` is checked in the SAME invocation as
//!     the transfer — atomic check-and-transfer, no TOCTOU.
//!   - `tx_id` and `memo` are `deriveIds(order_id)` outputs; the contract treats them as opaque 32-byte
//!     values. `applied_rate` is authenticated (part of the operator-signed invocation) and emitted for
//!     cross-checking against the off-chain ledger — the ledger, not the event, is the audit source.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN, Env,
};

// ~5s ledgers → 17280/day. Persistent replay-guard TTL is generous: it must outlive any retry window
// so an archived-then-restored key can never let a paid tx_id replay.
const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
const PROCESSED_BUMP: u32 = 120 * DAY_IN_LEDGERS;
const PROCESSED_THRESHOLD: u32 = PROCESSED_BUMP - DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `Processed(tx_id)` already set → the second `pay()` for an order REVERTS (not a silent no-op).
    AlreadyProcessed = 1,
    /// Atomic guard: pool balance < amount.
    InsufficientBalance = 2,
    /// `IsPaused` flag is set.
    Paused = 3,
    /// Wrong role / missing auth (also enforced by the host on `require_auth`).
    NotAuthorized = 4,
    /// amount <= 0.
    InvalidAmount = 5,
}

/// Emitted on every successful `pay()`. `tx_id` is the indexed topic the reconciler looks up by;
/// `applied_rate`/`memo` are carried for cross-checking against the off-chain ledger (the audit source).
#[contractevent]
pub struct PaymentMade {
    #[topic]
    pub tx_id: BytesN<32>,
    pub merchant: Address,
    pub amount: i128,
    pub applied_rate: i128,
    pub memo: BytesN<32>,
}

/// Admin audit trail — role changes and pause toggles are security-critical, so each emits an event.
#[contractevent]
pub struct AdminChanged {
    #[topic]
    pub old_admin: Address,
    pub new_admin: Address,
}
#[contractevent]
pub struct OperatorChanged {
    #[topic]
    pub old_operator: Address,
    pub new_operator: Address,
}
#[contractevent]
pub struct PauseSet {
    pub paused: bool,
}
#[contractevent]
pub struct Upgraded {
    #[topic]
    pub wasm_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Operator,
    UsdcSac,
    Paused,
    /// Persistent replay guard, keyed by the order-derived `tx_id`.
    Processed(BytesN<32>),
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}
fn read_operator(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Operator).unwrap()
}
fn read_sac(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::UsdcSac).unwrap()
}
fn read_paused(env: &Env) -> bool {
    env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
}
fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

#[contract]
pub struct TroyPool;

#[contractimpl]
impl TroyPool {
    /// Deploy-time constructor: bind the roles and the USDC SAC once. Runs exactly once (a redeploy
    /// is the only way to re-run it), so there is no re-initialization attack surface.
    pub fn __constructor(env: Env, admin: Address, operator: Address, usdc_sac: Address) {
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Operator, &operator);
        s.set(&DataKey::UsdcSac, &usdc_sac);
        s.set(&DataKey::Paused, &false);
        bump_instance(&env);
    }

    /// Move `amount` USDC from the pool to `merchant`. Atomic check-and-transfer with a per-`tx_id`
    /// replay guard. Order: operator auth → not paused → amount > 0 → not already processed →
    /// sufficient balance → mark processed → transfer → emit. Any guard fails closed (Err), and the
    /// replay guard is written BEFORE the transfer — Soroban's all-or-nothing revert means a failed
    /// transfer undoes that write too, so a reverted transfer never leaves the order marked processed.
    pub fn pay(
        env: Env,
        tx_id: BytesN<32>,
        amount: i128,
        applied_rate: i128,
        merchant: Address,
        memo: BytesN<32>,
    ) -> Result<(), Error> {
        read_operator(&env).require_auth();

        if read_paused(&env) {
            return Err(Error::Paused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let processed_key = DataKey::Processed(tx_id.clone());
        if env.storage().persistent().has(&processed_key) {
            // Replay detected — revert regardless of current balance (idempotency dominates). We do NOT
            // re-bump the TTL on this path: an `Err` return rolls the whole invocation back, so any bump
            // here is discarded anyway. Durability rests on Persistent storage ARCHIVING (never deleting)
            // the guard — an archived key must be restored, value `true` intact, before pay() can read it,
            // so an aged-out guard can never silently read as absent and re-pay the order.
            return Err(Error::AlreadyProcessed);
        }

        let pool = env.current_contract_address();
        let usdc = token::TokenClient::new(&env, &read_sac(&env));
        if usdc.balance(&pool) < amount {
            return Err(Error::InsufficientBalance);
        }

        // Effects BEFORE interactions: mark the order processed, THEN transfer. Soroban reverts every
        // storage write if the transfer panics, so a failed transfer never leaves the order marked — and
        // nothing can re-enter pay() between the guard write and the transfer. Check-and-transfer remains
        // in the same invocation (no TOCTOU); the pool authorizes moving its own funds implicitly.
        env.storage().persistent().set(&processed_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&processed_key, PROCESSED_THRESHOLD, PROCESSED_BUMP);

        usdc.transfer(&pool, &merchant, &amount);

        PaymentMade { tx_id, merchant, amount, applied_rate, memo }.publish(&env);

        bump_instance(&env);
        Ok(())
    }

    /// Admin: halt the money path. `pay()` returns `Paused` until `unpause`.
    pub fn pause(env: Env) -> Result<(), Error> {
        read_admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        bump_instance(&env);
        PauseSet { paused: true }.publish(&env);
        Ok(())
    }

    /// Admin: resume the money path.
    pub fn unpause(env: Env) -> Result<(), Error> {
        read_admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        bump_instance(&env);
        PauseSet { paused: false }.publish(&env);
        Ok(())
    }

    /// Admin: rotate the operator (the account allowed to sign `pay()`). A leaked/rotated hot key is
    /// replaced without redeploying. Channel-account pools (Phase 2 concurrency) swap in the same way.
    pub fn set_operator(env: Env, operator: Address) -> Result<(), Error> {
        read_admin(&env).require_auth();
        let old = read_operator(&env);
        env.storage().instance().set(&DataKey::Operator, &operator);
        bump_instance(&env);
        OperatorChanged { old_operator: old, new_operator: operator }.publish(&env);
        Ok(())
    }

    /// Admin: hand over admin control. The CURRENT admin must authorize the handover (a bad `new_admin`
    /// value locks the contract, so this is the highest-trust operation — high multisig threshold on mainnet).
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let old = read_admin(&env);
        old.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        bump_instance(&env);
        AdminChanged { old_admin: old, new_admin }.publish(&env);
        Ok(())
    }

    /// Admin: swap the contract's own code to a previously-uploaded Wasm hash (in-place migration; the
    /// C-address, stored state, and pool balance are preserved). Takes effect after this invocation.
    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        read_admin(&env).require_auth();
        env.deployer().update_current_contract_wasm(wasm_hash.clone());
        Upgraded { wasm_hash }.publish(&env);
        Ok(())
    }

    // ---- read-only views (no auth; used by tests, the backend solvency check, and the reconciler) ----

    /// True once `pay()` has settled this `tx_id` (the replay-guard predicate).
    pub fn is_processed(env: Env, tx_id: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Processed(tx_id))
    }
    pub fn is_paused(env: Env) -> bool {
        read_paused(&env)
    }
    pub fn admin(env: Env) -> Address {
        read_admin(&env)
    }
    pub fn operator(env: Env) -> Address {
        read_operator(&env)
    }
    /// The pool's current USDC balance (the on-chain solvency source of truth).
    pub fn balance(env: Env) -> i128 {
        let pool = env.current_contract_address();
        token::TokenClient::new(&env, &read_sac(&env)).balance(&pool)
    }
}

#[cfg(test)]
mod test;
