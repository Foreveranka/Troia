#![no_std]
use soroban_sdk::{contract, contractimpl, Env};

/// TroyPool holds USDC custody and moves it via `pay()`.
///
/// Phase 0 scaffold: only a `version()` placeholder so the crate compiles and the toolchain is
/// verified. The real `pay()` money path and admin entrypoints arrive in Phase 2 (see
/// docs/ARCHITECTURE.md §5).
#[contract]
pub struct TroyPool;

#[contractimpl]
impl TroyPool {
    pub fn version(_env: Env) -> u32 {
        0
    }
}
