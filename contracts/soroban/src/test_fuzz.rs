#![cfg(test)]
//! Property-based invariant and stateful sequence fuzzing test suite (#181).
//!
//! Proves core financial and rate-limiting invariants across randomized inputs
//! and interleaved transaction sequences:
//!   1. Solvency Invariant: Contract token balance is always >= total outstanding
//!      escrow holds (`EscrowHold`) plus active stream obligations.
//!   2. Single-Pull-Per-Cycle Invariant: An active vault can never settle more
//!      than once within the same billing epoch (`cycle_index`).
//!   3. Distribution / Allowance Integrity: Metered epoch pulls, batch payroll
//!      disbursements, and Merkle-style claim allocations never pay out more
//!      than `total_deposited` / `max_amount_per_interval` regardless of order.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Vec,
};

struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn range_u64(&mut self, min: u64, max: u64) -> u64 {
        if min >= max {
            return min;
        }
        min + (self.next_u64() % (max - min + 1))
    }

    fn range_i128(&mut self, min: i128, max: i128) -> i128 {
        if min >= max {
            return min;
        }
        let span = (max - min + 1) as u64;
        min + i128::from(self.next_u64() % span)
    }
}

#[test]
fn fuzz_invariant_solvency_escrow_and_streams() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let recipient = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    let initial_supply: i128 = 50_000_000_000_000;
    token_admin_client.mint(&user, &initial_supply);

    let contract_id = env.register(OrbitContract, ());
    let client = OrbitContractClient::new(&env, &contract_id);

    token_client.approve(&user, &contract_id, &initial_supply, &9_999_999);

    let mut rng = SplitMix64::new(0x0181_5017_E4C0_FFEE);
    let mut now: u64 = 10_000;
    env.ledger().set_timestamp(now);

    let interval: u64 = 86_400;
    let vault_amount: i128 = 25_000_000;
    let escrow_window: u64 = 43_200;

    client.create_vault(&user, &merchant, &token_address, &vault_amount, &interval);
    client.configure_escrow(&user, &merchant, &arbitrator, &escrow_window);

    let mut tracked_escrow_ids: [u64; 32] = [0; 32];
    let mut escrow_count: usize = 0;

    let stream_deposit: i128 = 100_000_000;
    let stream_id = client.create_stream(
        &user,
        &recipient,
        &token_address,
        &stream_deposit,
        &now,
        &(now + 100_000),
    );
    let mut stream_remaining: i128 = stream_deposit;
    let mut stream_active = true;

    for _ in 0..250 {
        let step = rng.range_u64(1_000, 50_000);
        now = now.saturating_add(step);
        env.ledger().set_timestamp(now);

        let action = rng.range_u64(0, 4);
        if action == 0 {
            if client.try_pull_funds(&user, &merchant).is_ok() && escrow_count < 32 {
                tracked_escrow_ids[escrow_count] = escrow_count as u64;
                escrow_count += 1;
            }
        } else if action == 1 && escrow_count > 0 {
            let idx = (rng.next_u64() as usize) % escrow_count;
            let pid = tracked_escrow_ids[idx];
            let _ = client.try_raise_dispute(&user, &merchant, &pid);
        } else if action == 2 && escrow_count > 0 {
            let idx = (rng.next_u64() as usize) % escrow_count;
            let pid = tracked_escrow_ids[idx];
            let pct = rng.range_u64(0, 100) as u32;
            let _ = client.try_resolve_dispute(&arbitrator, &pid, &pct);
        } else if action == 3 && escrow_count > 0 {
            let idx = (rng.next_u64() as usize) % escrow_count;
            let pid = tracked_escrow_ids[idx];
            let _ = client.try_claim_escrow_funds(&merchant, &pid);
        } else if stream_active {
            let withdraw_amt = rng.range_i128(1, 15_000_000);
            let w_res = client.try_withdraw_from_stream(&stream_id, &withdraw_amt);
            if w_res.is_ok() {
                stream_remaining -= withdraw_amt;
                if stream_remaining == 0 {
                    stream_active = false;
                }
            }
        }

        let mut outstanding_escrow: i128 = 0;
        for pid in tracked_escrow_ids.iter().take(escrow_count) {
            if let Some(hold) = client.get_escrow(pid) {
                outstanding_escrow += hold.amount;
            }
        }

        let contract_balance = token_client.balance(&contract_id);
        let required_liabilities = outstanding_escrow + stream_remaining;
        assert!(
            contract_balance >= required_liabilities,
            "Solvency invariant violated: balance < escrow + stream liabilities"
        );

        let total_held = contract_balance
            + token_client.balance(&user)
            + token_client.balance(&merchant)
            + token_client.balance(&recipient);
        assert_eq!(total_held, initial_supply);
    }
}

#[test]
fn fuzz_invariant_single_pull_per_billing_interval() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    let initial_supply: i128 = 90_000_000_000_000;
    token_admin_client.mint(&user, &initial_supply);

    let contract_id = env.register(OrbitContract, ());
    let client = OrbitContractClient::new(&env, &contract_id);
    token_client.approve(&user, &contract_id, &initial_supply, &9_999_999);

    let start_ts: u64 = 1_000_000;
    let interval: u64 = 3_600;
    let amount: i128 = 10_000_000;

    env.ledger().set_timestamp(start_ts);
    client.create_vault(&user, &merchant, &token_address, &amount, &interval);

    let mut rng = SplitMix64::new(0xB111_C7C1_E5E9_0001);
    let mut now = start_ts;
    let mut last_settled_cycle: Option<u64> = None;
    let mut total_pulls: i128 = 0;

    for _ in 0..300 {
        let delta = rng.range_u64(0, interval / 2);
        now = now.saturating_add(delta);
        env.ledger().set_timestamp(now);

        let cycle_index = (now - start_ts) / interval;
        let use_batch = (rng.next_u64() & 1) == 1;

        let settled = if use_batch {
            let mut subs = Vec::new(&env);
            subs.push_back(user.clone());
            let results = client.batch_pull_funds(&merchant, &subs);
            results.get(0).map(|r| r.success).unwrap_or(false)
        } else {
            client.try_pull_funds(&user, &merchant).is_ok()
        };

        if settled {
            if let Some(prev_cycle) = last_settled_cycle {
                assert!(
                    cycle_index > prev_cycle,
                    "Vault settled twice within the same or earlier billing cycle"
                );
            }
            last_settled_cycle = Some(cycle_index);
            total_pulls += 1;

            // Immediate retry at identical timestamp must be rejected
            assert!(client.try_pull_funds(&user, &merchant).is_err());
        }

        assert_eq!(token_client.balance(&merchant), total_pulls * amount);
    }
}

#[test]
fn fuzz_invariant_distribution_and_metered_cap_integrity() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let recipient_a = Address::generate(&env);
    let recipient_b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);

    let total_deposited: i128 = 500_000_000;
    token_admin_client.mint(&user, &total_deposited);

    let contract_id = env.register(OrbitContract, ());
    let client = OrbitContractClient::new(&env, &contract_id);
    token_client.approve(&user, &contract_id, &total_deposited, &9_999_999);

    let mut now: u64 = 50_000;
    let interval: u64 = 10_000;
    let max_per_interval: i128 = 50_000_000;
    env.ledger().set_timestamp(now);

    client.create_metered_vault(
        &user,
        &merchant,
        &token_address,
        &max_per_interval,
        &interval,
    );

    let mut rng = SplitMix64::new(0xCAFE_F00D_DEAD_BEEF);
    let mut epoch_start = now;
    let mut tracked_epoch_spent: i128 = 0;

    for _ in 0..200 {
        let advance = rng.range_u64(0, 2_500);
        now = now.saturating_add(advance);
        env.ledger().set_timestamp(now);

        if now >= epoch_start + interval {
            epoch_start = now;
            tracked_epoch_spent = 0;
        }

        let attempt = rng.range_i128(1, 30_000_000);
        let res = client.try_pull_metered_funds(&user, &merchant, &attempt);

        if tracked_epoch_spent + attempt <= max_per_interval
            && token_client.balance(&user) >= attempt
        {
            assert!(res.is_ok());
            tracked_epoch_spent += attempt;
        } else {
            assert!(res.is_err());
        }

        let vault = client.get_metered_vault(&user, &merchant).unwrap();
        assert!(vault.epoch_spent <= vault.max_amount_per_interval);
    }

    // Verify batch disbursement / claim allocations never exceed remaining user deposit
    let remaining = token_client.balance(&user);
    if remaining >= 20 {
        let split_a = remaining / 2;
        let split_b = remaining - split_a;
        let mut splits = Vec::new(&env);
        splits.push_back(PaymentSplit {
            recipient: recipient_a.clone(),
            amount: split_a,
        });
        splits.push_back(PaymentSplit {
            recipient: recipient_b.clone(),
            amount: split_b,
        });
        let batch_ok = client.try_batch_disburse(&user, &token_address, &splits);
        assert!(batch_ok.is_ok());

        // Attempting to claim / disburse even 1 extra unit beyond total_deposited fails
        let mut extra_splits = Vec::new(&env);
        extra_splits.push_back(PaymentSplit {
            recipient: recipient_a.clone(),
            amount: 1,
        });
        let extra_res = client.try_batch_disburse(&user, &token_address, &extra_splits);
        assert!(extra_res.is_err());
    }

    let total_paid = token_client.balance(&merchant)
        + token_client.balance(&recipient_a)
        + token_client.balance(&recipient_b);
    assert!(
        total_paid <= total_deposited,
        "Total payouts exceeded total_deposited"
    );
}

#[test]
fn fuzz_edge_cases_zero_amounts_and_timestamp_boundaries() {
    let env = Env::default();
    env.mock_all_auths();

    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin_client = StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&user, &1_000_000_000);

    let contract_id = env.register(OrbitContract, ());
    let client = OrbitContractClient::new(&env, &contract_id);
    token_client.approve(&user, &contract_id, &1_000_000_000, &9_999_999);

    // Edge case 1: Zero and negative amounts or intervals must always be rejected
    let r1 = client.try_create_vault(&user, &merchant, &token_address, &0, &86_400);
    assert!(r1.is_err());
    let r2 = client.try_create_vault(&user, &merchant, &token_address, &-100, &86_400);
    assert!(r2.is_err());
    let r3 = client.try_create_vault(&user, &merchant, &token_address, &1_000, &0);
    assert!(r3.is_err());
    let r4 = client.try_create_metered_vault(&user, &merchant, &token_address, &0, &86_400);
    assert!(r4.is_err());

    // Edge case 2: Exact trial boundary timestamp (trial_end - 1 vs trial_end)
    let base_ts: u64 = 1_700_000_000;
    let trial_duration: u64 = 7_200;
    let interval: u64 = 86_400;
    env.ledger().set_timestamp(base_ts);

    client.create_vault_with_trial(
        &user,
        &merchant,
        &token_address,
        &10_000_000,
        &interval,
        &trial_duration,
    );

    env.ledger().set_timestamp(base_ts + trial_duration - 1);
    assert!(client.try_pull_funds(&user, &merchant).is_err());

    env.ledger().set_timestamp(base_ts + trial_duration);
    assert!(client.try_pull_funds(&user, &merchant).is_ok());

    // Edge case 3: Exact next-interval boundary (last_pull + interval - 1 vs last_pull + interval)
    let next_due = base_ts + trial_duration + interval;
    env.ledger().set_timestamp(next_due - 1);
    assert!(client.try_pull_funds(&user, &merchant).is_err());

    env.ledger().set_timestamp(next_due);
    assert!(client.try_pull_funds(&user, &merchant).is_ok());
}
