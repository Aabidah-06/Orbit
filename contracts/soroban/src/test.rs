#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::Client as TokenClient,
    token::StellarAssetClient,
    Address, Env, IntoVal, Symbol, Vec,
};

#[test]
fn test_allowance_handshake_and_pull() {
    let env = Env::default();

    // In unit tests, we mock the wallet signatures (mock_all_auths)
    // so we can test the logic without a real frontend connecting.
    env.mock_all_auths();

    // Generate dummy addresses for our actors
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // Deploy a mock testnet token (represents our USDC with 7 decimals)
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    // Mint 100 USDC to the user to start
    token_admin_client.mint(&user, &100_0000000);

    // Register our Orbit Contract
    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    // ------------------------------------------------------------------------
    // SCENARIO 1: THE HANDSHAKE
    // ------------------------------------------------------------------------
    let amount = 29_0000000; // 29 USDC (with 7 zeroes for precision)
    let interval = 30 * 24 * 60 * 60; // 30 days in seconds

    // User approves the contract to spend the recurring charge
    token_client.approve(&user, &orbit_client.address, &amount, &2000000);

    // User creates the vault (approving the 29 USDC recurring charge)
    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    // ------------------------------------------------------------------------
    // SCENARIO 2: THE PULL
    // ------------------------------------------------------------------------
    // Merchant executes the billing
    orbit_client.pull_funds(&user, &merchant);

    // Verify the math! The merchant should have exactly 29 USDC.
    assert_eq!(token_client.balance(&merchant), 29_0000000);
    // The user should have 100 - 29 = 71 USDC remaining.
    assert_eq!(token_client.balance(&user), 71_0000000);
}

// ----------------------------------------------------------------------------
// ISSUE #1: INPUT VALIDATION IN CREATE_VAULT
// ----------------------------------------------------------------------------

#[test]
#[should_panic]
fn test_create_vault_fails_when_amount_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    orbit_client.create_vault(&user, &merchant, &token, &0, &86400);
}

#[test]
#[should_panic]
fn test_create_vault_fails_when_amount_negative() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    orbit_client.create_vault(&user, &merchant, &token, &-1, &86400);
}

#[test]
#[should_panic]
fn test_create_vault_fails_when_interval_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    orbit_client.create_vault(&user, &merchant, &token, &29_0000000, &0);
}

// ----------------------------------------------------------------------------
// ISSUE #2: EXPANDED UNIT TEST COVERAGE
// ----------------------------------------------------------------------------

#[test]
#[should_panic]
fn test_pull_before_interval_has_elapsed_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let amount = 29_0000000;
    let interval = 86400; // 1 day

    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);
    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    // Initial pull at timestamp 1000
    env.ledger().set_timestamp(1000);
    orbit_client.pull_funds(&user, &merchant);

    // Advance timestamp by less than interval (1000 + 40000 < 1000 + 86400)
    env.ledger().set_timestamp(1000 + 40000);

    // Fails because interval hasn't elapsed yet
    orbit_client.pull_funds(&user, &merchant);
}

#[test]
fn test_second_pull_succeeds_once_interval_has_elapsed() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let amount = 29_0000000;
    let interval = 86400; // 1 day

    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);
    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    // First pull at timestamp 1000
    env.ledger().set_timestamp(1000);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), 29_0000000);
    assert_eq!(token_client.balance(&user), 71_0000000);

    // Advance timestamp by exactly the interval (1000 + 86400)
    env.ledger().set_timestamp(1000 + 86400);
    orbit_client.pull_funds(&user, &merchant);

    // Second pull succeeds
    assert_eq!(token_client.balance(&merchant), 58_0000000);
    assert_eq!(token_client.balance(&user), 42_0000000);
}

#[test]
#[should_panic]
fn test_pull_on_vault_that_does_not_exist_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    // Pulling on non-existent vault should fail with "Vault does not exist"
    orbit_client.pull_funds(&user, &merchant);
}

#[test]
#[should_panic]
fn test_pull_authorized_by_different_merchant_fails() {
    let env = Env::default();
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let other_merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    // Create vault with mock_all_auths first
    env.mock_all_auths();
    token_client.approve(&user, &orbit_client.address, &29_0000000, &2000000);
    orbit_client.create_vault(&user, &merchant, &token_address, &29_0000000, &86400);

    // Now mock auth ONLY for other_merchant
    orbit_client.mock_auths(&[MockAuth {
        address: &other_merchant,
        invoke: &MockAuthInvoke {
            contract: &orbit_client.address,
            fn_name: "pull_funds",
            args: (&user, &merchant).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    // Pulling with merchant while only other_merchant authorized should fail
    orbit_client.pull_funds(&user, &merchant);
}

#[test]
fn test_create_vault_overwrites_existing_terms_and_resets_last_pull_timestamp() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);

    // Create initial vault: 29 USDC, 86400s interval
    orbit_client.create_vault(&user, &merchant, &token_address, &29_0000000, &86400);

    // Pull at t = 1000
    env.ledger().set_timestamp(1000);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), 29_0000000);

    // Overwrite the vault terms with 40 USDC and 172800s interval
    orbit_client.create_vault(&user, &merchant, &token_address, &40_0000000, &172800);

    // Check persistent storage to verify overwritten terms and reset last_pull_timestamp = 0
    let key = vault_key(&user, &merchant);
    let vault_before_pull: VaultData =
        env.as_contract(&contract_id, || load_vault(&env, &key).unwrap());
    assert_eq!(vault_before_pull.amount_per_interval, 40_0000000);
    assert_eq!(vault_before_pull.interval_seconds, 172800);
    assert_eq!(vault_before_pull.last_pull_timestamp, 0);

    // Because last_pull_timestamp was reset to 0, pulling immediately at t = 1000 succeeds with new amount!
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), 69_0000000); // 29 + 40
    assert_eq!(token_client.balance(&user), 31_0000000); // 100 - 69
}

#[test]
fn test_batch_disburse_pays_every_recipient_correct_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let sender = Address::generate(&env);
    let recipient_1 = Address::generate(&env);
    let recipient_2 = Address::generate(&env);
    let recipient_3 = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    token_admin_client.mint(&sender, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    token_client.approve(&sender, &orbit_client.address, &60_0000000, &2000000);

    let mut splits = Vec::new(&env);
    splits.push_back(PaymentSplit {
        recipient: recipient_1.clone(),
        amount: 10_0000000,
    });
    splits.push_back(PaymentSplit {
        recipient: recipient_2.clone(),
        amount: 20_0000000,
    });
    splits.push_back(PaymentSplit {
        recipient: recipient_3.clone(),
        amount: 30_0000000,
    });

    orbit_client.batch_disburse(&sender, &token_address, &splits);

    assert_eq!(token_client.balance(&recipient_1), 10_0000000);
    assert_eq!(token_client.balance(&recipient_2), 20_0000000);
    assert_eq!(token_client.balance(&recipient_3), 30_0000000);
    assert_eq!(token_client.balance(&sender), 40_0000000);
}

#[test]
fn test_batch_disburse_reverts_fully_when_transfer_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let sender = Address::generate(&env);
    let recipient_1 = Address::generate(&env);
    let recipient_2 = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    token_admin_client.mint(&sender, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    // Only approve 30 USDC, but splits total 40 USDC
    token_client.approve(&sender, &orbit_client.address, &30_0000000, &2000000);

    let mut splits = Vec::new(&env);
    splits.push_back(PaymentSplit {
        recipient: recipient_1.clone(),
        amount: 20_0000000,
    });
    splits.push_back(PaymentSplit {
        recipient: recipient_2.clone(),
        amount: 20_0000000,
    });

    let res = orbit_client.try_batch_disburse(&sender, &token_address, &splits);
    assert!(res.is_err());

    // Verify atomic revert: recipient 1 must have 0, recipient 2 must have 0, sender must still have 100
    assert_eq!(token_client.balance(&recipient_1), 0);
    assert_eq!(token_client.balance(&recipient_2), 0);
    assert_eq!(token_client.balance(&sender), 100_0000000);
}

// ----------------------------------------------------------------------------
// ISSUE #21: READ-ONLY VAULT LOOKUP
// ----------------------------------------------------------------------------

#[test]
fn test_get_vault_returns_none_when_vault_does_not_exist() {
    let env = Env::default();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let vault = orbit_client.get_vault(&user, &merchant);

    assert_eq!(vault, None);
}

#[test]
fn test_get_vault_returns_existing_vault_and_latest_pull_timestamp() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    token_admin_client.mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let amount = 20_0000000;
    let interval = 86400;

    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);

    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    let created_vault = orbit_client
        .get_vault(&user, &merchant)
        .expect("vault should exist");

    assert_eq!(created_vault.token, token_address);
    assert_eq!(created_vault.amount_per_interval, amount);
    assert_eq!(created_vault.interval_seconds, interval);
    assert_eq!(created_vault.last_pull_timestamp, 0);

    env.ledger().set_timestamp(1000);
    orbit_client.pull_funds(&user, &merchant);

    let after_first_pull = orbit_client
        .get_vault(&user, &merchant)
        .expect("vault should still exist");

    assert_eq!(after_first_pull.last_pull_timestamp, 1000);

    env.ledger().set_timestamp(1000 + interval);
    orbit_client.pull_funds(&user, &merchant);

    let after_second_pull = orbit_client
        .get_vault(&user, &merchant)
        .expect("vault should still exist");

    assert_eq!(after_second_pull.last_pull_timestamp, 1000 + interval);
}

// ----------------------------------------------------------------------------
// ISSUE #23: VAULT & CONTRACT INSTANCE STORAGE TTL EXTENSION
// ----------------------------------------------------------------------------

#[test]
fn test_calculate_ttl_params_logic() {
    // 1. Short interval (e.g. 1 day = 86,400s -> ~17,280 ledgers)
    // 17,280 + 120,960 = 138,240, which is below MIN_TTL_LEDGERS (518,400).
    // It should be floored at MIN_TTL_LEDGERS.
    let (short_threshold, short_extend_to) = calculate_ttl_params(86_400);
    assert_eq!(short_extend_to, MIN_TTL_LEDGERS);
    assert_eq!(short_threshold, TTL_THRESHOLD_LEDGERS);

    // 2. Long interval (e.g. 1 year = 31,536,000s -> 6,307,200 ledgers)
    // 6,307,200 + 120,960 = 6,428,160 ledgers.
    let yearly_seconds = 365 * 24 * 60 * 60;
    let (yearly_threshold, yearly_extend_to) = calculate_ttl_params(yearly_seconds);
    assert_eq!(
        yearly_extend_to,
        (yearly_seconds / SECONDS_PER_LEDGER) as u32 + TTL_MARGIN_LEDGERS
    );
    assert_eq!(yearly_threshold, TTL_THRESHOLD_LEDGERS);
}

#[test]
fn test_vault_ttl_extended_and_survives_past_default_ttl() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    token_admin_client.mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let amount = 29_0000000;
    let interval = 30 * 24 * 60 * 60; // 30 days = 2,592,000s (~518,400 ledgers)

    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);

    // 1. Create vault: extends persistent & instance TTL
    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    let initial_seq = env.ledger().sequence();
    let advanced_seq = initial_seq + 10_000; // Past default 4,096 TTL
    let advanced_time = interval + 100; // Past interval

    env.ledger().set_sequence_number(advanced_seq);
    env.ledger().set_timestamp(advanced_time);

    // 2. The vault must still exist in storage and pull_funds must succeed!
    orbit_client.pull_funds(&user, &merchant);

    assert_eq!(token_client.balance(&merchant), amount);
    assert_eq!(token_client.balance(&user), 100_0000000 - amount);

    // 3. Verify that pull_funds also extended TTL, allowing a second pull further in time
    let second_advanced_seq = advanced_seq + 10_000;
    let second_advanced_time = advanced_time + interval + 100;

    env.ledger().set_sequence_number(second_advanced_seq);
    env.ledger().set_timestamp(second_advanced_time);

    orbit_client.pull_funds(&user, &merchant);

    assert_eq!(token_client.balance(&merchant), amount * 2);
    assert_eq!(token_client.balance(&user), 100_0000000 - (amount * 2));
}

// ----------------------------------------------------------------------------
// ISSUE #22: VALIDATE SPLITS IN BATCH_DISBURSE
// ----------------------------------------------------------------------------

#[test]
fn test_batch_disburse_fails_when_splits_empty() {
    let env = Env::default();
    env.mock_all_auths();

    let sender = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let splits = Vec::new(&env);
    let res = orbit_client.try_batch_disburse(&sender, &token, &splits);
    assert!(res.is_err());
}

#[test]
fn test_batch_disburse_fails_when_split_amount_zero_and_no_recipient_paid() {
    let env = Env::default();
    env.mock_all_auths();

    let sender = Address::generate(&env);
    let recipient_1 = Address::generate(&env);
    let recipient_2 = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    token_admin_client.mint(&sender, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    token_client.approve(&sender, &orbit_client.address, &100_0000000, &2000000);

    let mut splits = Vec::new(&env);
    // First split is positive, second split is zero
    splits.push_back(PaymentSplit {
        recipient: recipient_1.clone(),
        amount: 25_0000000,
    });
    splits.push_back(PaymentSplit {
        recipient: recipient_2.clone(),
        amount: 0,
    });

    let res = orbit_client.try_batch_disburse(&sender, &token_address, &splits);
    assert!(res.is_err());

    // Upfront validation ensures zero transfers took place
    assert_eq!(token_client.balance(&recipient_1), 0);
    assert_eq!(token_client.balance(&recipient_2), 0);
    assert_eq!(token_client.balance(&sender), 100_0000000);
}

#[test]
fn test_batch_disburse_fails_when_split_amount_negative_and_no_recipient_paid() {
    let env = Env::default();
    env.mock_all_auths();

    let sender = Address::generate(&env);
    let recipient_1 = Address::generate(&env);
    let recipient_2 = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    token_admin_client.mint(&sender, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    token_client.approve(&sender, &orbit_client.address, &100_0000000, &2000000);

    let mut splits = Vec::new(&env);
    // First split is positive, second split is negative
    splits.push_back(PaymentSplit {
        recipient: recipient_1.clone(),
        amount: 30_0000000,
    });
    splits.push_back(PaymentSplit {
        recipient: recipient_2.clone(),
        amount: -10_0000000,
    });

    let res = orbit_client.try_batch_disburse(&sender, &token_address, &splits);
    assert!(res.is_err());

    // Upfront validation ensures zero transfers took place
    assert_eq!(token_client.balance(&recipient_1), 0);
    assert_eq!(token_client.balance(&recipient_2), 0);
    assert_eq!(token_client.balance(&sender), 100_0000000);
}

// ----------------------------------------------------------------------------
// ISSUE #20: EMIT EVENTS FOR CONTRACT ENTRYPOINTS
// ----------------------------------------------------------------------------

#[test]
fn test_contract_events_published_for_all_entrypoints() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    token_admin_client.mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let amount = 29_0000000;
    let interval = 86400;

    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);

    // 1. Verify create_vault event
    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    let create_topics = soroban_sdk::vec![
        &env,
        Symbol::new(&env, "vault_created").to_val(),
        user.to_val(),
        merchant.to_val(),
    ];
    let create_data = (token_address.clone(), amount, interval).into_val(&env);
    let expected_create = soroban_sdk::vec![
        &env,
        (orbit_client.address.clone(), create_topics, create_data),
    ];
    assert_eq!(env.events().all(), expected_create);

    // 2. Verify pull_funds event
    env.ledger().set_timestamp(5000);
    orbit_client.pull_funds(&user, &merchant);

    let pull_topics = soroban_sdk::vec![
        &env,
        Symbol::new(&env, "funds_pulled").to_val(),
        user.clone().to_val(),
        merchant.clone().to_val(),
    ];
    let pull_data = (amount, 5000u64).into_val(&env);
    let expected_pull = soroban_sdk::vec![
        &env,
        (orbit_client.address.clone(), pull_topics, pull_data),
    ];
    assert_eq!(
        env.events().all().filter_by_contract(&orbit_client.address),
        expected_pull
    );

    // 3. Verify batch_disburse event
    let sender = Address::generate(&env);
    let rec1 = Address::generate(&env);
    let rec2 = Address::generate(&env);

    token_admin_client.mint(&sender, &50_0000000);
    token_client.approve(&sender, &orbit_client.address, &50_0000000, &2000000);

    let mut splits = Vec::new(&env);
    splits.push_back(PaymentSplit {
        recipient: rec1,
        amount: 15_0000000,
    });
    splits.push_back(PaymentSplit {
        recipient: rec2,
        amount: 25_0000000,
    });

    orbit_client.batch_disburse(&sender, &token_address, &splits);

    let disburse_topics = soroban_sdk::vec![
        &env,
        Symbol::new(&env, "batch_disbursed").to_val(),
        sender.clone().to_val(),
    ];
    let disburse_data = (token_address.clone(), 2u32, 40_0000000i128).into_val(&env);
    let expected_disburse = soroban_sdk::vec![
        &env,
        (orbit_client.address.clone(), disburse_topics, disburse_data),
    ];
    assert_eq!(
        env.events().all().filter_by_contract(&orbit_client.address),
        expected_disburse
    );
}

// ----------------------------------------------------------------------------
// ISSUE #44: CANCEL VAULT
// ----------------------------------------------------------------------------

#[test]
fn test_cancel_vault_removes_vault_and_blocks_pull() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);
    orbit_client.create_vault(&user, &merchant, &token_address, &29_0000000, &86400);

    orbit_client.cancel_vault(&user, &merchant);

    assert_eq!(orbit_client.get_vault(&user, &merchant), None);

    // The allowance is still in place, but with no vault the pull must fail
    let res = orbit_client.try_pull_funds(&user, &merchant);
    assert!(res.is_err());
    assert_eq!(token_client.balance(&merchant), 0);
    assert_eq!(token_client.balance(&user), 100_0000000);
}

#[test]
fn test_cancel_vault_fails_when_vault_does_not_exist() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let res = orbit_client.try_cancel_vault(&user, &merchant);
    assert!(res.is_err());
}

#[test]
fn test_cancel_vault_authorized_by_merchant_fails() {
    let env = Env::default();
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    orbit_client.create_vault(&user, &merchant, &token, &29_0000000, &86400);

    // Now mock auth ONLY for the merchant
    let res = orbit_client
        .mock_auths(&[MockAuth {
            address: &merchant,
            invoke: &MockAuthInvoke {
                contract: &orbit_client.address,
                fn_name: "cancel_vault",
                args: (&user, &merchant).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_cancel_vault(&user, &merchant);
    assert!(res.is_err());

    // The vault is untouched
    assert!(orbit_client.get_vault(&user, &merchant).is_some());
}

#[test]
fn test_create_vault_works_again_after_cancel() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);

    orbit_client.create_vault(&user, &merchant, &token_address, &29_0000000, &86400);
    orbit_client.cancel_vault(&user, &merchant);
    orbit_client.create_vault(&user, &merchant, &token_address, &40_0000000, &172800);

    let vault = orbit_client
        .get_vault(&user, &merchant)
        .expect("vault should exist");
    assert_eq!(vault.amount_per_interval, 40_0000000);
    assert_eq!(vault.interval_seconds, 172800);
    assert_eq!(vault.last_pull_timestamp, 0);

    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), 40_0000000);
}

#[test]
fn test_cancel_vault_event_published() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    orbit_client.create_vault(&user, &merchant, &token, &29_0000000, &86400);
    orbit_client.cancel_vault(&user, &merchant);

    let cancel_topics = soroban_sdk::vec![
        &env,
        Symbol::new(&env, "vault_cancelled").to_val(),
        user.to_val(),
        merchant.to_val(),
    ];
    let expected_cancel = soroban_sdk::vec![
        &env,
        (
            orbit_client.address.clone(),
            cancel_topics,
            ().into_val(&env)
        ),
    ];
    assert_eq!(env.events().all(), expected_cancel);
}
