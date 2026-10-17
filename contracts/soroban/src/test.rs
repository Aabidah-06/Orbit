#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::Client as TokenClient,
    token::StellarAssetClient,
    Address, Env, IntoVal, String, Symbol, Vec,
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
    let key = VaultKey {
        user: user.clone(),
        merchant: merchant.clone(),
    };
    let vault_before_pull: VaultData = env.as_contract(&contract_id, || {
        env.storage().persistent().get(&key).unwrap()
    });
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
    let expected_pull =
        soroban_sdk::vec![&env, (orbit_client.address.clone(), pull_topics, pull_data),];
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

// ----------------------------------------------------------------------------
// ISSUE #93: SUBSCRIPTION PAUSE & RESUME
// ----------------------------------------------------------------------------

#[test]
fn test_pause_blocks_pull_and_resume_restores_billing() {
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
    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    // First settlement at t = 1000
    env.ledger().set_timestamp(1000);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), amount);

    // The subscriber freezes the vault
    orbit_client.pause_vault(&user, &merchant);
    let paused = orbit_client
        .get_vault(&user, &merchant)
        .expect("vault should exist");
    assert!(paused.is_paused);

    // A full interval later the merchant still cannot pull while paused
    env.ledger().set_timestamp(1000 + interval);
    let res = orbit_client.try_pull_funds(&user, &merchant);
    assert!(res.is_err());
    assert_eq!(token_client.balance(&merchant), amount);
    assert_eq!(token_client.balance(&user), 100_0000000 - amount);

    // Resume restarts the billing clock at "now" so the interval that elapsed
    // during the pause is not back-billed
    orbit_client.resume_vault(&user, &merchant);
    let resumed = orbit_client
        .get_vault(&user, &merchant)
        .expect("vault should exist");
    assert!(!resumed.is_paused);
    assert_eq!(resumed.last_pull_timestamp, 1000 + interval);

    // Pulling immediately after the resume is rejected (no retro-active billing)
    let res = orbit_client.try_pull_funds(&user, &merchant);
    assert!(res.is_err());

    // A full interval after the resume the merchant can bill again
    env.ledger().set_timestamp(1000 + 2 * interval);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), amount * 2);
    assert_eq!(token_client.balance(&user), 100_0000000 - amount * 2);
}

#[test]
fn test_pause_vault_authorized_by_merchant_fails() {
    let env = Env::default();
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    orbit_client.create_vault(&user, &merchant, &token, &29_0000000, &86400);

    // Only the merchant is authorized, but pause_vault requires the user
    let res = orbit_client
        .mock_auths(&[MockAuth {
            address: &merchant,
            invoke: &MockAuthInvoke {
                contract: &orbit_client.address,
                fn_name: "pause_vault",
                args: (&user, &merchant).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_pause_vault(&user, &merchant);
    assert!(res.is_err());

    let vault = orbit_client
        .get_vault(&user, &merchant)
        .expect("vault should exist");
    assert!(!vault.is_paused);
}

#[test]
fn test_resume_vault_authorized_by_merchant_fails() {
    let env = Env::default();
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    orbit_client.create_vault(&user, &merchant, &token, &29_0000000, &86400);
    orbit_client.pause_vault(&user, &merchant);

    let res = orbit_client
        .mock_auths(&[MockAuth {
            address: &merchant,
            invoke: &MockAuthInvoke {
                contract: &orbit_client.address,
                fn_name: "resume_vault",
                args: (&user, &merchant).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_resume_vault(&user, &merchant);
    assert!(res.is_err());

    let vault = orbit_client
        .get_vault(&user, &merchant)
        .expect("vault should exist");
    assert!(vault.is_paused);
}

#[test]
fn test_cancel_vault_works_while_paused() {
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

    orbit_client.pause_vault(&user, &merchant);
    orbit_client.cancel_vault(&user, &merchant);

    assert_eq!(orbit_client.get_vault(&user, &merchant), None);
    let res = orbit_client.try_pull_funds(&user, &merchant);
    assert!(res.is_err());
    assert_eq!(token_client.balance(&merchant), 0);
    assert_eq!(token_client.balance(&user), 100_0000000);
}

#[test]
fn test_pause_and_resume_of_unknown_vault_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    assert!(orbit_client.try_pause_vault(&user, &merchant).is_err());
    assert!(orbit_client.try_resume_vault(&user, &merchant).is_err());
}

#[test]
fn test_pause_and_resume_events_published() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let amount = 29_0000000;
    let interval = 86400;

    orbit_client.create_vault(&user, &merchant, &token, &amount, &interval);

    orbit_client.pause_vault(&user, &merchant);
    let paused_topics = soroban_sdk::vec![
        &env,
        Symbol::new(&env, "vault_paused").to_val(),
        user.clone().to_val(),
        merchant.clone().to_val(),
    ];
    let expected_pause = soroban_sdk::vec![
        &env,
        (
            orbit_client.address.clone(),
            paused_topics,
            ().into_val(&env),
        ),
    ];
    assert_eq!(env.events().all(), expected_pause);

    orbit_client.resume_vault(&user, &merchant);
    let resumed_topics = soroban_sdk::vec![
        &env,
        Symbol::new(&env, "vault_resumed").to_val(),
        user.clone().to_val(),
        merchant.clone().to_val(),
    ];
    let expected_resume = soroban_sdk::vec![
        &env,
        (
            orbit_client.address.clone(),
            resumed_topics,
            ().into_val(&env),
        ),
    ];
    assert_eq!(env.events().all(), expected_resume);
}

// ----------------------------------------------------------------------------
// ISSUE #94: MONOTONIC PULL EPOCH COUNTER
// ----------------------------------------------------------------------------

#[test]
fn test_pull_sequence_tracks_billing_cycles_monotonically() {
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
    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    env.ledger().set_timestamp(1000);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(
        orbit_client
            .get_vault(&user, &merchant)
            .expect("vault should exist")
            .pull_sequence,
        0
    );

    env.ledger().set_timestamp(1000 + interval);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(
        orbit_client
            .get_vault(&user, &merchant)
            .expect("vault should exist")
            .pull_sequence,
        1
    );

    env.ledger().set_timestamp(1000 + 2 * interval);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(
        orbit_client
            .get_vault(&user, &merchant)
            .expect("vault should exist")
            .pull_sequence,
        2
    );

    assert_eq!(token_client.balance(&merchant), amount * 3);
    assert_eq!(token_client.balance(&user), 100_0000000 - amount * 3);
}

#[test]
fn test_same_epoch_second_pull_rejected_even_when_timestamp_check_is_bypassed() {
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
    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    // Settle at ledger timestamp 0: last_pull_timestamp stays 0, which
    // bypasses the legacy "Too early to pull funds" check entirely.
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), amount);

    // Later in the SAME computed cycle the epoch guard alone must reject the
    // second pull, keeping the single-pull-per-cycle invariant deterministic.
    env.ledger().set_timestamp(interval / 2);
    let res = orbit_client.try_pull_funds(&user, &merchant);
    assert!(res.is_err());
    assert_eq!(token_client.balance(&merchant), amount);
    assert_eq!(token_client.balance(&user), 100_0000000 - amount);

    // The next cycle opens and billing resumes exactly once
    env.ledger().set_timestamp(interval);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), amount * 2);
    assert_eq!(
        orbit_client
            .get_vault(&user, &merchant)
            .expect("vault should exist")
            .pull_sequence,
        1
    );
}

#[test]
fn test_clock_jitter_cannot_double_pull_within_an_epoch() {
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
    orbit_client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    // Settle inside billing cycle 1
    env.ledger().set_timestamp(100_000);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(
        orbit_client
            .get_vault(&user, &merchant)
            .expect("vault should exist")
            .pull_sequence,
        1
    );

    // Sequencer clock steps backwards: no pull can be smuggled through
    env.ledger().set_timestamp(50_000);
    assert!(orbit_client.try_pull_funds(&user, &merchant).is_err());

    // Still inside the same computed cycle as the last settlement
    env.ledger().set_timestamp(172_799);
    assert!(orbit_client.try_pull_funds(&user, &merchant).is_err());

    assert_eq!(token_client.balance(&merchant), amount);

    // The next cycle opens exactly one interval after the settlement
    env.ledger().set_timestamp(100_000 + interval);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(
        orbit_client
            .get_vault(&user, &merchant)
            .expect("vault should exist")
            .pull_sequence,
        2
    );

    // A duplicate attempt at the very same instant is rejected deterministically
    env.ledger().set_timestamp(100_000 + interval);
    assert!(orbit_client.try_pull_funds(&user, &merchant).is_err());

    assert_eq!(token_client.balance(&merchant), amount * 2);
    assert_eq!(token_client.balance(&user), 100_0000000 - amount * 2);
}

// ----------------------------------------------------------------------------
// ISSUE #95: DECENTRALIZED PLAN CATALOG & PLAN-LINKED VAULTS
// ----------------------------------------------------------------------------

#[test]
fn test_register_plan_and_read_it_back() {
    let env = Env::default();
    env.mock_all_auths();

    let merchant = Address::generate(&env);
    let token = Address::generate(&env);
    let plan_id = String::from_str(&env, "plan-pro");
    let name = String::from_str(&env, "Pro Plan");

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    // Unknown plan ids read back as None without panicking
    assert_eq!(
        orbit_client.get_plan(&String::from_str(&env, "missing")),
        None
    );

    orbit_client.register_plan(&merchant, &plan_id, &token, &29_0000000, &86400, &name);

    let plan = orbit_client.get_plan(&plan_id).expect("plan should exist");
    assert_eq!(plan.merchant, merchant);
    assert_eq!(plan.token, token);
    assert_eq!(plan.amount_per_interval, 29_0000000);
    assert_eq!(plan.interval_seconds, 86400);
    assert_eq!(plan.name, name);
    assert!(plan.is_active);
}

#[test]
fn test_register_plan_requires_merchant_authorization() {
    let env = Env::default();

    let merchant = Address::generate(&env);
    let other = Address::generate(&env);
    let token = Address::generate(&env);
    let plan_id = String::from_str(&env, "plan-pro");
    let name = String::from_str(&env, "Pro Plan");

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let res = orbit_client
        .mock_auths(&[MockAuth {
            address: &other,
            invoke: &MockAuthInvoke {
                contract: &orbit_client.address,
                fn_name: "register_plan",
                args: (&merchant, &plan_id, &token, &29_0000000, &86400, &name).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_register_plan(&merchant, &plan_id, &token, &29_0000000, &86400, &name);
    assert!(res.is_err());
    assert_eq!(orbit_client.get_plan(&plan_id), None);
}

#[test]
#[should_panic]
fn test_register_plan_rejects_zero_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    orbit_client.register_plan(
        &merchant,
        &String::from_str(&env, "plan-pro"),
        &token,
        &0,
        &86400,
        &String::from_str(&env, "Pro Plan"),
    );
}

#[test]
#[should_panic]
fn test_register_plan_rejects_zero_interval() {
    let env = Env::default();
    env.mock_all_auths();

    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    orbit_client.register_plan(
        &merchant,
        &String::from_str(&env, "plan-pro"),
        &token,
        &29_0000000,
        &0,
        &String::from_str(&env, "Pro Plan"),
    );
}

#[test]
fn test_register_plan_rejects_plan_id_owned_by_another_merchant() {
    let env = Env::default();
    env.mock_all_auths();

    let merchant_a = Address::generate(&env);
    let merchant_b = Address::generate(&env);
    let token = Address::generate(&env);
    let plan_id = String::from_str(&env, "plan-pro");
    let name = String::from_str(&env, "Pro Plan");

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    orbit_client.register_plan(&merchant_a, &plan_id, &token, &29_0000000, &86400, &name);

    // Another merchant cannot hijack the id
    let res = orbit_client.try_register_plan(
        &merchant_b,
        &plan_id,
        &token,
        &40_0000000,
        &172800,
        &String::from_str(&env, "Hijacked"),
    );
    assert!(res.is_err());

    let plan = orbit_client.get_plan(&plan_id).expect("plan should exist");
    assert_eq!(plan.merchant, merchant_a);
    assert_eq!(plan.amount_per_interval, 29_0000000);

    // The owner can refresh the terms, which also reactivates the plan
    orbit_client.deactivate_plan(&merchant_a, &plan_id);
    assert!(
        !orbit_client
            .get_plan(&plan_id)
            .expect("plan exists")
            .is_active
    );

    orbit_client.register_plan(&merchant_a, &plan_id, &token, &40_0000000, &172800, &name);
    let plan = orbit_client.get_plan(&plan_id).expect("plan should exist");
    assert_eq!(plan.amount_per_interval, 40_0000000);
    assert_eq!(plan.interval_seconds, 172800);
    assert!(plan.is_active);
}

#[test]
fn test_deactivate_plan_requires_owning_merchant() {
    let env = Env::default();
    env.mock_all_auths();

    let merchant = Address::generate(&env);
    let other = Address::generate(&env);
    let token = Address::generate(&env);
    let plan_id = String::from_str(&env, "plan-pro");
    let name = String::from_str(&env, "Pro Plan");

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    orbit_client.register_plan(&merchant, &plan_id, &token, &29_0000000, &86400, &name);

    let res = orbit_client
        .mock_auths(&[MockAuth {
            address: &other,
            invoke: &MockAuthInvoke {
                contract: &orbit_client.address,
                fn_name: "deactivate_plan",
                args: (&other, &plan_id).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_deactivate_plan(&other, &plan_id);
    assert!(res.is_err());
    assert!(
        orbit_client
            .get_plan(&plan_id)
            .expect("plan exists")
            .is_active
    );
}

#[test]
fn test_deactivate_plan_blocks_new_vaults_but_existing_vaults_keep_billing() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let new_user = Address::generate(&env);
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
    let plan_id = String::from_str(&env, "plan-pro");

    orbit_client.register_plan(
        &merchant,
        &plan_id,
        &token_address,
        &amount,
        &interval,
        &String::from_str(&env, "Pro Plan"),
    );

    // A user opens a vault from the on-chain plan terms
    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);
    orbit_client.create_vault_from_plan(&user, &plan_id);

    let vault = orbit_client
        .get_vault(&user, &merchant)
        .expect("vault should exist");
    assert_eq!(vault.token, token_address);
    assert_eq!(vault.amount_per_interval, amount);
    assert_eq!(vault.interval_seconds, interval);
    assert!(!vault.is_paused);

    env.ledger().set_timestamp(1000);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), amount);

    // Merchant deactivates the plan: no NEW subscriptions, existing ones live
    orbit_client.deactivate_plan(&merchant, &plan_id);
    assert!(
        !orbit_client
            .get_plan(&plan_id)
            .expect("plan exists")
            .is_active
    );

    let res = orbit_client.try_create_vault_from_plan(&new_user, &plan_id);
    assert!(res.is_err());
    assert_eq!(orbit_client.get_vault(&new_user, &merchant), None);

    // The pre-existing vault keeps billing on schedule
    env.ledger().set_timestamp(1000 + interval);
    orbit_client.pull_funds(&user, &merchant);
    assert_eq!(token_client.balance(&merchant), amount * 2);
    assert_eq!(token_client.balance(&user), 100_0000000 - amount * 2);
}

#[test]
fn test_create_vault_from_plan_requires_user_authorization() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let other = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);
    let plan_id = String::from_str(&env, "plan-pro");

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    orbit_client.register_plan(
        &merchant,
        &plan_id,
        &token,
        &29_0000000,
        &86400,
        &String::from_str(&env, "Pro Plan"),
    );

    let res = orbit_client
        .mock_auths(&[MockAuth {
            address: &other,
            invoke: &MockAuthInvoke {
                contract: &orbit_client.address,
                fn_name: "create_vault_from_plan",
                args: (&user, &plan_id).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_create_vault_from_plan(&user, &plan_id);
    assert!(res.is_err());
    assert_eq!(orbit_client.get_vault(&user, &merchant), None);
}

#[test]
fn test_create_vault_from_unknown_plan_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let res = orbit_client.try_create_vault_from_plan(&user, &String::from_str(&env, "missing"));
    assert!(res.is_err());
    assert_eq!(orbit_client.get_vault(&user, &merchant), None);
}

#[test]
fn test_deactivate_unknown_plan_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let merchant = Address::generate(&env);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let res = orbit_client.try_deactivate_plan(&merchant, &String::from_str(&env, "missing"));
    assert!(res.is_err());
}

#[test]
fn test_create_vault_from_plan_emits_vault_created_event() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);
    let plan_id = String::from_str(&env, "plan-pro");
    let name = String::from_str(&env, "Pro Plan");

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);

    let amount = 29_0000000;
    let interval = 86400;

    orbit_client.register_plan(&merchant, &plan_id, &token, &amount, &interval, &name);
    orbit_client.create_vault_from_plan(&user, &plan_id);

    let vault_topics = soroban_sdk::vec![
        &env,
        Symbol::new(&env, "vault_created").to_val(),
        user.clone().to_val(),
        merchant.clone().to_val(),
    ];
    let expected = soroban_sdk::vec![
        &env,
        (
            orbit_client.address.clone(),
            vault_topics,
            (token.clone(), amount, interval).into_val(&env),
        ),
    ];
    assert_eq!(env.events().all(), expected);
}

// ----------------------------------------------------------------------------
// ISSUE #46: METERED (USAGE-BASED) BILLING
// ----------------------------------------------------------------------------

const METERED_CAP: i128 = 20_0000000; // 20 USDC per interval
const METERED_INTERVAL: u64 = 7 * 24 * 60 * 60; // weekly

struct MeteredWorld<'a> {
    env: Env,
    user: Address,
    merchant: Address,
    token_address: Address,
    token_client: TokenClient<'a>,
    orbit_client: OrbitContractClient<'a>,
}

fn metered_world<'a>() -> MeteredWorld<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    StellarAssetClient::new(&env, &token_address).mint(&user, &100_0000000);

    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);
    token_client.approve(&user, &orbit_client.address, &100_0000000, &2000000);
    orbit_client.create_metered_vault(
        &user,
        &merchant,
        &token_address,
        &METERED_CAP,
        &METERED_INTERVAL,
    );

    MeteredWorld {
        env,
        user,
        merchant,
        token_address,
        token_client,
        orbit_client,
    }
}

#[test]
fn test_create_metered_vault_stores_terms() {
    let w = metered_world();
    let vault = w
        .orbit_client
        .get_metered_vault(&w.user, &w.merchant)
        .unwrap();
    assert_eq!(vault.token, w.token_address);
    assert_eq!(vault.max_amount_per_interval, METERED_CAP);
    assert_eq!(vault.interval_seconds, METERED_INTERVAL);
    assert_eq!(vault.current_epoch_start, 1_000);
    assert_eq!(vault.epoch_spent, 0);
    // A metered vault doesn't create a fixed-interval vault.
    assert!(w.orbit_client.get_vault(&w.user, &w.merchant).is_none());
}

#[test]
fn test_metered_multiple_partial_pulls_within_interval() {
    let w = metered_world();
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &3_4500000); // $3.45
    w.env.ledger().set_timestamp(2_000);
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &8_2000000); // $8.20
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &8_3500000); // exactly up to the cap

    assert_eq!(w.token_client.balance(&w.merchant), 20_0000000);
    assert_eq!(w.token_client.balance(&w.user), 80_0000000);
    let vault = w
        .orbit_client
        .get_metered_vault(&w.user, &w.merchant)
        .unwrap();
    assert_eq!(vault.epoch_spent, METERED_CAP);
    assert_eq!(vault.current_epoch_start, 1_000, "still the same epoch");
}

#[test]
#[should_panic(expected = "Interval spending limit exceeded")]
fn test_metered_pull_exceeding_remaining_allowance_panics() {
    let w = metered_world();
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &15_0000000);
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &5_0000001); // 1 stroop over
}

#[test]
#[should_panic(expected = "Interval spending limit exceeded")]
fn test_metered_allowance_does_not_reset_before_interval_elapses() {
    let w = metered_world();
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &METERED_CAP);
    w.env.ledger().set_timestamp(1_000 + METERED_INTERVAL - 1);
    w.orbit_client.pull_metered_funds(&w.user, &w.merchant, &1);
}

#[test]
fn test_metered_epoch_rolls_over_and_resets_allowance() {
    let w = metered_world();
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &METERED_CAP);

    let next_epoch = 1_000 + METERED_INTERVAL;
    w.env.ledger().set_timestamp(next_epoch);
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &4_0000000);

    let vault = w
        .orbit_client
        .get_metered_vault(&w.user, &w.merchant)
        .unwrap();
    assert_eq!(vault.current_epoch_start, next_epoch);
    assert_eq!(vault.epoch_spent, 4_0000000);
    assert_eq!(w.token_client.balance(&w.merchant), 24_0000000);
}

#[test]
fn test_cancel_vault_removes_metered_vault() {
    let w = metered_world();
    w.orbit_client.cancel_vault(&w.user, &w.merchant);
    assert!(w
        .orbit_client
        .get_metered_vault(&w.user, &w.merchant)
        .is_none());
}

#[test]
#[should_panic(expected = "Metered vault does not exist")]
fn test_pull_after_cancelling_metered_vault_fails() {
    let w = metered_world();
    w.orbit_client.cancel_vault(&w.user, &w.merchant);
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &1_0000000);
}

#[test]
fn test_metered_and_fixed_vaults_for_same_pair_are_independent() {
    let w = metered_world();
    w.orbit_client
        .create_vault(&w.user, &w.merchant, &w.token_address, &29_0000000, &86400);
    w.orbit_client
        .pull_metered_funds(&w.user, &w.merchant, &5_0000000);
    assert_eq!(
        w.orbit_client
            .get_vault(&w.user, &w.merchant)
            .unwrap()
            .amount_per_interval,
        29_0000000
    );
    assert_eq!(
        w.orbit_client
            .get_metered_vault(&w.user, &w.merchant)
            .unwrap()
            .epoch_spent,
        5_0000000
    );

    // cancel_vault clears both.
    w.orbit_client.cancel_vault(&w.user, &w.merchant);
    assert!(w.orbit_client.get_vault(&w.user, &w.merchant).is_none());
    assert!(w
        .orbit_client
        .get_metered_vault(&w.user, &w.merchant)
        .is_none());
}

#[test]
#[should_panic(expected = "max_amount_per_interval must be positive")]
fn test_create_metered_vault_rejects_zero_cap() {
    let w = metered_world();
    w.orbit_client.create_metered_vault(
        &w.user,
        &w.merchant,
        &w.token_address,
        &0,
        &METERED_INTERVAL,
    );
}

#[test]
#[should_panic(expected = "interval_seconds must be greater than zero")]
fn test_create_metered_vault_rejects_zero_interval() {
    let w = metered_world();
    w.orbit_client
        .create_metered_vault(&w.user, &w.merchant, &w.token_address, &METERED_CAP, &0);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_metered_pull_rejects_non_positive_amount() {
    let w = metered_world();
    w.orbit_client.pull_metered_funds(&w.user, &w.merchant, &0);
}

#[test]
#[should_panic]
fn test_metered_pull_authorized_by_different_merchant_fails() {
    let w = metered_world();
    let other_merchant = Address::generate(&w.env);
    // `mock_auths` returns a client with per-call auth, so chain the call on it.
    w.orbit_client
        .mock_auths(&[MockAuth {
            address: &other_merchant,
            invoke: &MockAuthInvoke {
                contract: &w.orbit_client.address,
                fn_name: "pull_metered_funds",
                args: (&w.user, &w.merchant, 1_0000000i128).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .pull_metered_funds(&w.user, &w.merchant, &1_0000000);
}

#[test]
#[should_panic]
fn test_create_metered_vault_requires_user_auth() {
    let env = Env::default();
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);
    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);
    // No auths mocked: user.require_auth() must fail.
    orbit_client.create_metered_vault(&user, &merchant, &token, &METERED_CAP, &METERED_INTERVAL);
}

#[test]
fn test_metered_events_published_for_creation_and_pulls() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    StellarAssetClient::new(&env, &token_address).mint(&user, &100_0000000);
    let contract_id = env.register(OrbitContract, ());
    let orbit_client = OrbitContractClient::new(&env, &contract_id);
    TokenClient::new(&env, &token_address).approve(
        &user,
        &orbit_client.address,
        &100_0000000,
        &2000000,
    );

    orbit_client.create_metered_vault(
        &user,
        &merchant,
        &token_address,
        &METERED_CAP,
        &METERED_INTERVAL,
    );
    let create_topics = soroban_sdk::vec![
        &env,
        Symbol::new(&env, "metered_vault_created").to_val(),
        user.clone().to_val(),
        merchant.clone().to_val(),
    ];
    let create_data = (token_address.clone(), METERED_CAP, METERED_INTERVAL).into_val(&env);
    assert_eq!(
        env.events().all().filter_by_contract(&orbit_client.address),
        soroban_sdk::vec![
            &env,
            (orbit_client.address.clone(), create_topics, create_data)
        ]
    );

    orbit_client.pull_metered_funds(&user, &merchant, &3_4500000);
    let pull_topics = soroban_sdk::vec![
        &env,
        Symbol::new(&env, "metered_funds_pulled").to_val(),
        user.clone().to_val(),
        merchant.clone().to_val(),
    ];
    let pull_data = (3_4500000i128, 3_4500000i128, METERED_CAP).into_val(&env);
    assert_eq!(
        env.events().all().filter_by_contract(&orbit_client.address),
        soroban_sdk::vec![&env, (orbit_client.address.clone(), pull_topics, pull_data)]
    );
}

// ----------------------------------------------------------------------------
// #123–126: Soulbound credentials, bitmap registry, swap and escrow settlement
// ----------------------------------------------------------------------------

#[test]
fn test_badge_issuance_renewal_expiration_and_revocation() {
    let env = Env::default();
    env.mock_all_auths();
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let token = TokenClient::new(&env, &token_id);
    StellarAssetClient::new(&env, &token_id).mint(&user, &1_000);
    let id = env.register(OrbitContract, ());
    let client = OrbitContractClient::new(&env, &id);
    token.approve(&user, &id, &1_000, &2_000_000);

    client.create_vault(&user, &merchant, &token_id, &100, &100);
    let original = client.get_subscriber_badge(&user, &merchant).unwrap();
    assert!(original.active);
    assert_eq!(original.tier, 1);
    assert_eq!(original.subscriber_id, 0);
    assert_eq!(original.expiration_timestamp, 100);
    assert!(client.is_subscriber_active(&user, &merchant));
    assert_eq!(
        client.get_subscriber_bitmap_chunk(&merchant, &0).to_array()[0],
        1
    );

    client.set_subscriber_tier(&user, &merchant, &3);
    env.ledger().set_timestamp(20);
    client.pull_funds(&user, &merchant);
    let renewed = client.get_subscriber_badge(&user, &merchant).unwrap();
    assert_eq!(renewed.tier, 3);
    assert_eq!(renewed.expiration_timestamp, 120);
    env.ledger().set_timestamp(121);
    assert!(!client.is_subscriber_active(&user, &merchant));
    assert!(client.mark_subscription_default(&user, &merchant));
    assert!(
        !client
            .get_subscriber_badge(&user, &merchant)
            .unwrap()
            .active
    );
    assert_eq!(
        client.get_subscriber_bitmap_chunk(&merchant, &0).to_array()[0],
        0
    );

    client.cancel_vault(&user, &merchant);
    client.create_vault(&user, &merchant, &token_id, &100, &100);
    assert_eq!(
        client
            .get_subscriber_badge(&user, &merchant)
            .unwrap()
            .subscriber_id,
        0
    );
    assert_eq!(
        client.get_subscriber_bitmap_chunk(&merchant, &0).to_array()[0],
        1
    );
    client.cancel_vault(&user, &merchant);
    assert!(!client.is_subscriber_active(&user, &merchant));
    assert_eq!(
        client.get_subscriber_bitmap_chunk(&merchant, &0).to_array()[0],
        0
    );
}

#[test]
fn test_bitmap_chunk_boundary_and_neighbor_integrity() {
    let env = Env::default();
    env.mock_all_auths();
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);
    let id = env.register(OrbitContract, ());
    let client = OrbitContractClient::new(&env, &id);
    let mut users = Vec::<Address>::new(&env);
    for _ in 0..258 {
        let user = Address::generate(&env);
        client.create_vault(&user, &merchant, &token, &10, &86400);
        users.push_back(user);
    }
    let first = client.get_subscriber_bitmap_chunk(&merchant, &0).to_array();
    let second = client.get_subscriber_bitmap_chunk(&merchant, &1).to_array();
    assert_eq!(first, [255u8; 32]);
    assert_eq!(second[0], 3);
    assert_eq!(second[1], 0);

    client.cancel_vault(&users.get(255).unwrap(), &merchant);
    client.cancel_vault(&users.get(256).unwrap(), &merchant);
    let first = client.get_subscriber_bitmap_chunk(&merchant, &0).to_array();
    let second = client.get_subscriber_bitmap_chunk(&merchant, &1).to_array();
    assert_eq!(first[31], 127);
    assert_eq!(first[30], 255);
    assert_eq!(second[0], 2);
    assert!(client.is_subscriber_active(&users.get(257).unwrap(), &merchant));
}

#[test]
fn test_escrow_claim_dispute_and_partial_arbitration() {
    let env = Env::default();
    env.mock_all_auths();
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let token = TokenClient::new(&env, &token_id);
    StellarAssetClient::new(&env, &token_id).mint(&user, &1_000);
    let id = env.register(OrbitContract, ());
    let client = OrbitContractClient::new(&env, &id);
    token.approve(&user, &id, &1_000, &2_000_000);
    client.create_vault(&user, &merchant, &token_id, &100, &100);
    client.configure_escrow(&user, &merchant, &arbitrator, &30);

    env.ledger().set_timestamp(10);
    client.pull_funds(&user, &merchant);
    assert_eq!(token.balance(&merchant), 0);
    assert_eq!(token.balance(&id), 100);
    assert_eq!(client.get_escrow(&0).unwrap().release_at, 40);
    assert!(client.try_claim_escrow_funds(&merchant, &0).is_err());
    client.raise_dispute(&user, &merchant, &0);
    env.ledger().set_timestamp(41);
    assert!(client.try_claim_escrow_funds(&merchant, &0).is_err());
    assert!(client.try_resolve_dispute(&user, &0, &50).is_err());
    assert!(client.try_resolve_dispute(&arbitrator, &0, &101).is_err());
    client.resolve_dispute(&arbitrator, &0, &25);
    assert_eq!(token.balance(&user), 925);
    assert_eq!(token.balance(&merchant), 75);
    assert!(client.get_escrow(&0).is_none());

    env.ledger().set_timestamp(110);
    client.pull_funds(&user, &merchant);
    assert_eq!(token.balance(&merchant), 75);
    assert!(client.try_claim_escrow_funds(&merchant, &1).is_err());
    env.ledger().set_timestamp(141);
    client.claim_escrow_funds(&merchant, &1);
    assert_eq!(token.balance(&merchant), 175);
    assert!(client.get_escrow(&1).is_none());
}

#[soroban_sdk::contract]
pub struct TestExactOutputRouter;

#[soroban_sdk::contractimpl]
impl TestExactOutputRouter {
    pub fn swap_exact_output(
        env: Env,
        payment_token: Address,
        settlement_token: Address,
        amount_out: i128,
        max_amount_in: i128,
        recipient: Address,
    ) -> i128 {
        let spent = amount_out.checked_mul(2).unwrap();
        assert!(
            spent <= max_amount_in,
            "Insufficient max input for router quote"
        );
        let router = env.current_contract_address();
        token::Client::new(&env, &settlement_token).transfer(&router, &recipient, &amount_out);
        if max_amount_in > spent {
            token::Client::new(&env, &payment_token).transfer(
                &router,
                &recipient,
                &(max_amount_in - spent),
            );
        }
        spent
    }
}

#[test]
fn test_cross_asset_swap_exact_output_refund_and_slippage_rejection() {
    let env = Env::default();
    env.mock_all_auths();
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let admin = Address::generate(&env);
    let payment = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let settlement = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let payment_token = TokenClient::new(&env, &payment);
    let settlement_token = TokenClient::new(&env, &settlement);
    StellarAssetClient::new(&env, &payment).mint(&user, &1_000);
    let router = env.register(TestExactOutputRouter, ());
    StellarAssetClient::new(&env, &settlement).mint(&router, &1_000);
    let id = env.register(OrbitContract, ());
    let client = OrbitContractClient::new(&env, &id);
    payment_token.approve(&user, &id, &1_000, &2_000_000);
    client.create_vault(&user, &merchant, &settlement, &100, &100);
    client.configure_swap(&user, &merchant, &payment, &router, &250);
    env.ledger().set_timestamp(20);
    client.pull_funds(&user, &merchant);
    assert_eq!(payment_token.balance(&user), 800);
    assert_eq!(payment_token.balance(&router), 200);
    assert_eq!(settlement_token.balance(&merchant), 100);
    assert_eq!(settlement_token.balance(&id), 0);

    // Change the authorized quote cap to below the router's input requirement.
    client.configure_swap(&user, &merchant, &payment, &router, &150);
    env.ledger().set_timestamp(121);
    assert!(client.try_pull_funds(&user, &merchant).is_err());
    assert_eq!(payment_token.balance(&user), 800);
    assert_eq!(settlement_token.balance(&merchant), 100);
}
