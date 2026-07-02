use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, BytesN, Env};

use crate::{Error, TroyPool, TroyPoolClient};

const STROOP: i128 = 10_000_000; // 1 USDC = 1e7 (Stellar 7 decimals)

/// Owned test context. Clients are built per-test (they borrow `env`, which cannot be co-owned here).
struct Ctx {
    env: Env,
    pool: Address,
    operator: Address,
    admin: Address,
    merchant: Address,
    sac_id: Address,
}

impl Ctx {
    fn client(&self) -> TroyPoolClient<'_> {
        TroyPoolClient::new(&self.env, &self.pool)
    }
    fn usdc(&self) -> token::TokenClient<'_> {
        token::TokenClient::new(&self.env, &self.sac_id)
    }
}

/// Deploy a USDC SAC + TroyPool (via its constructor) and seed the pool with `pool_seed` USDC.
/// `mock_all_auths` is on, so operator/admin auth passes unless a test strips it.
fn setup(pool_seed: i128) -> Ctx {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let merchant = Address::generate(&env);
    let issuer = Address::generate(&env);

    let sac_id = env.register_stellar_asset_contract_v2(issuer).address();
    let pool = env.register(TroyPool, (admin.clone(), operator.clone(), sac_id.clone()));

    // Mint USDC straight to the pool contract address (C-addresses need no trustline).
    token::StellarAssetClient::new(&env, &sac_id).mint(&pool, &pool_seed);

    Ctx { env, pool, operator, admin, merchant, sac_id }
}

fn id(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

#[test]
fn constructor_sets_roles_and_is_unpaused() {
    let c = setup(100 * STROOP);
    assert_eq!(c.client().admin(), c.admin);
    assert_eq!(c.client().operator(), c.operator);
    assert!(!c.client().is_paused());
    assert_eq!(c.client().balance(), 100 * STROOP);
}

#[test]
fn pay_happy_path_moves_usdc_and_marks_processed() {
    let c = setup(100 * STROOP);
    let tx_id = id(&c.env, 1);
    let memo = id(&c.env, 2);

    c.client().pay(&tx_id, &STROOP, &405_000_000, &c.merchant, &memo);

    assert_eq!(c.usdc().balance(&c.merchant), STROOP); // merchant got 1 USDC
    assert_eq!(c.usdc().balance(&c.pool), 99 * STROOP); // pool debited
    assert!(c.client().is_processed(&tx_id)); // replay guard set
}

#[test]
fn replay_same_tx_id_reverts_and_pays_only_once() {
    // The double-pay shield: a second pay() for the same order reverts, merchant is paid exactly once.
    let c = setup(100 * STROOP);
    let tx_id = id(&c.env, 1);
    let memo = id(&c.env, 2);

    c.client().pay(&tx_id, &STROOP, &405_000_000, &c.merchant, &memo);
    assert_eq!(
        c.client().try_pay(&tx_id, &STROOP, &405_000_000, &c.merchant, &memo),
        Err(Ok(Error::AlreadyProcessed)),
    );
    assert_eq!(c.usdc().balance(&c.merchant), STROOP); // still exactly 1 USDC, never 2
    assert_eq!(c.usdc().balance(&c.pool), 99 * STROOP);
}

#[test]
fn insufficient_balance_reverts_without_paying() {
    let c = setup(STROOP / 2); // pool holds 0.5 USDC
    let tx_id = id(&c.env, 1);
    let memo = id(&c.env, 2);

    assert_eq!(
        c.client().try_pay(&tx_id, &STROOP, &405_000_000, &c.merchant, &memo),
        Err(Ok(Error::InsufficientBalance)),
    );
    assert_eq!(c.usdc().balance(&c.merchant), 0);
    assert!(!c.client().is_processed(&tx_id)); // NOT marked processed on a failed pay
}

#[test]
fn invalid_amount_zero_or_negative_reverts() {
    let c = setup(100 * STROOP);
    let tx_id = id(&c.env, 1);
    let memo = id(&c.env, 2);

    assert_eq!(
        c.client().try_pay(&tx_id, &0, &405_000_000, &c.merchant, &memo),
        Err(Ok(Error::InvalidAmount)),
    );
    assert_eq!(
        c.client().try_pay(&tx_id, &-1, &405_000_000, &c.merchant, &memo),
        Err(Ok(Error::InvalidAmount)),
    );
    assert_eq!(c.usdc().balance(&c.merchant), 0);
}

#[test]
fn paused_blocks_pay_and_unpause_restores_it() {
    let c = setup(100 * STROOP);
    let tx_id = id(&c.env, 1);
    let memo = id(&c.env, 2);

    c.client().pause();
    assert!(c.client().is_paused());
    assert_eq!(
        c.client().try_pay(&tx_id, &STROOP, &405_000_000, &c.merchant, &memo),
        Err(Ok(Error::Paused)),
    );

    c.client().unpause();
    c.client().pay(&tx_id, &STROOP, &405_000_000, &c.merchant, &memo);
    assert_eq!(c.usdc().balance(&c.merchant), STROOP);
}

#[test]
fn unauthorized_caller_cannot_pay() {
    let c = setup(100 * STROOP);
    let tx_id = id(&c.env, 1);
    let memo = id(&c.env, 2);

    // Strip mocked auth: operator.require_auth() must now fail closed.
    c.env.mock_auths(&[]);
    assert!(c
        .client()
        .try_pay(&tx_id, &STROOP, &405_000_000, &c.merchant, &memo)
        .is_err());
    assert_eq!(c.usdc().balance(&c.merchant), 0);
}
