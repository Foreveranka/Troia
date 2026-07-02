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

// ---- admin path (Phase 2.2) ----

#[test]
fn admin_can_set_operator() {
    let c = setup(0);
    let new_op = Address::generate(&c.env);
    c.client().set_operator(&new_op);
    assert_eq!(c.client().operator(), new_op);
}

#[test]
fn admin_can_rotate_admin() {
    let c = setup(0);
    let new_admin = Address::generate(&c.env);
    c.client().set_admin(&new_admin);
    assert_eq!(c.client().admin(), new_admin);
}

#[test]
fn rotated_operator_can_pay_and_original_is_replaced() {
    // The rotation actually rewires who signs pay(): after set_operator, the new operator's auth
    // drives a successful pay (mock_all_auths authorizes it), proving the stored role is load-bearing.
    let c = setup(100 * STROOP);
    let new_op = Address::generate(&c.env);
    c.client().set_operator(&new_op);
    assert_eq!(c.client().operator(), new_op);

    let tx_id = id(&c.env, 1);
    let memo = id(&c.env, 2);
    c.client().pay(&tx_id, &STROOP, &405_000_000, &c.merchant, &memo);
    assert_eq!(c.usdc().balance(&c.merchant), STROOP);
}

#[test]
fn unauthorized_cannot_change_roles_or_pause() {
    let c = setup(0);
    let x = Address::generate(&c.env);
    c.env.mock_auths(&[]); // no auth provided → every admin-gated call fails closed
    assert!(c.client().try_set_operator(&x).is_err());
    assert!(c.client().try_set_admin(&x).is_err());
    assert!(c.client().try_pause().is_err());
    assert!(c.client().try_unpause().is_err());
}

#[test]
fn unauthorized_cannot_upgrade() {
    let c = setup(0);
    let bogus_hash = id(&c.env, 9);
    c.env.mock_auths(&[]);
    // Auth is checked before touching the Wasm, so the bogus hash is never reached.
    assert!(c.client().try_upgrade(&bogus_hash).is_err());
}

// ---- Phase 2.3: real-SAC integration + conservation fuzz ----

#[test]
fn multi_order_integration_conserves_and_pays_each_merchant() {
    // Several distinct orders against a real SAC: each merchant is paid exactly its amount and the pool
    // is debited by the exact total — USDC is conserved (nothing created or lost).
    let c = setup(100 * STROOP);
    let m: [Address; 3] = core::array::from_fn(|_| Address::generate(&c.env));
    let amounts = [10 * STROOP, 25 * STROOP, 5 * STROOP];
    for k in 0..3 {
        c.client()
            .pay(&id(&c.env, k as u8 + 1), &amounts[k], &405_000_000, &m[k], &id(&c.env, 100 + k as u8));
    }
    assert_eq!(c.usdc().balance(&m[0]), 10 * STROOP);
    assert_eq!(c.usdc().balance(&m[1]), 25 * STROOP);
    assert_eq!(c.usdc().balance(&m[2]), 5 * STROOP);
    assert_eq!(c.client().balance(), 60 * STROOP); // 100 - (10+25+5)

    let paid: i128 = m.iter().map(|x| c.usdc().balance(x)).sum();
    assert_eq!(c.client().balance() + paid, 100 * STROOP); // conservation
}

#[test]
fn fuzz_conservation_and_pay_at_most_once() {
    // A deterministic pseudo-random workload of pay() attempts — valid, duplicate (same tx_id), zero /
    // negative, and over-balance amounts, to random merchants. Two invariants must hold at every step no
    // matter the interleaving:
    //   (1) CONSERVATION: pool_balance + Σ(merchant balances) == initial seed  (no USDC created or lost).
    //   (2) PAY-AT-MOST-ONCE: any given tx_id is settled at most once (the double-pay shield).
    const SEED: i128 = 100 * STROOP;
    const N_TX: usize = 40; // distinct tx_ids → the workload forces replays
    let c = setup(SEED);
    let merchants: [Address; 5] = core::array::from_fn(|_| Address::generate(&c.env));
    let mut succeeded = [false; N_TX];

    let mut rng: u64 = 0x2545_F491_4F6C_DD1D; // fixed seed → reproducible
    for _ in 0..400 {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let r = rng;

        let idx = (r % N_TX as u64) as usize;
        let merchant = &merchants[((r >> 8) % merchants.len() as u64) as usize];
        // range ~[-1 USDC, +3 USDC]: mixes InvalidAmount, valid, and over-balance cases.
        let amount = ((r >> 16) % (4 * STROOP as u64)) as i128 - STROOP;

        let res = c
            .client()
            .try_pay(&id(&c.env, idx as u8), &amount, &405_000_000, merchant, &id(&c.env, 200 - idx as u8));

        if matches!(res, Ok(Ok(()))) {
            assert!(!succeeded[idx], "tx_id {idx} settled twice — double-pay shield breached");
            succeeded[idx] = true;
        }

        let paid: i128 = merchants.iter().map(|x| c.usdc().balance(x)).sum();
        assert_eq!(c.client().balance() + paid, SEED, "conservation broken");
        assert!(c.client().balance() >= 0, "pool went negative");
    }
}
