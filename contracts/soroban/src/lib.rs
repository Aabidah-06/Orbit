#![no_std]
#![allow(deprecated)]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, String, Symbol, Vec};

// ----------------------------------------------------------------------------
// CONSTANTS: STATE ARCHIVAL & TTL MANAGEMENT
// ----------------------------------------------------------------------------

/// Approximate duration of one Stellar ledger in seconds (~5 seconds per ledger).
pub const SECONDS_PER_LEDGER: u64 = 5;

/// Safety margin added to interval ledgers (approx. 7 days = 120,960 ledgers)
/// to ensure vaults remain active even if automated pulls are delayed.
pub const TTL_MARGIN_LEDGERS: u32 = 120_960;

/// Base minimum TTL duration in ledgers (approx. 30 days = 518,400 ledgers).
pub const MIN_TTL_LEDGERS: u32 = 518_400;

/// Threshold in ledgers below which TTL will be extended (approx. 7 days = 120,960 ledgers).
pub const TTL_THRESHOLD_LEDGERS: u32 = 120_960;

/// Sentinel `pull_sequence` for a vault that has never settled a pull.
/// Lets the very first pull through while every later pull must advance the
/// monotonic billing epoch (`cycle_index > pull_sequence`).
pub const PULL_SEQUENCE_UNSET: u64 = u64::MAX;

/// Calculates (threshold, extend_to) in ledgers for vault persistent storage
/// and contract instance storage based on interval_seconds.
pub fn calculate_ttl_params(interval_seconds: u64) -> (u32, u32) {
    let interval_ledgers = (interval_seconds / SECONDS_PER_LEDGER) as u32;
    let extend_to = interval_ledgers
        .saturating_add(TTL_MARGIN_LEDGERS)
        .max(MIN_TTL_LEDGERS);
    let threshold = TTL_THRESHOLD_LEDGERS.min(extend_to.saturating_sub(1));
    (threshold, extend_to)
}

// ----------------------------------------------------------------------------
// DATA STRUCTURES
// ----------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultKey {
    pub user: Address,
    pub merchant: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultData {
    pub token: Address,
    pub amount_per_interval: i128,
    pub interval_seconds: u64,
    pub last_pull_timestamp: u64,
    /// Ledger timestamp the vault was (last) created at; anchors the billing
    /// cycle grid used by the monotonic pull epoch guard (#94).
    pub initial_timestamp: u64,
    /// Cycle index of the most recent settlement. `PULL_SEQUENCE_UNSET` until
    /// the first successful pull (#94).
    pub pull_sequence: u64,
    /// Subscriber-controlled freeze flag; blocks `pull_funds` while true (#93).
    pub is_paused: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentSplit {
    pub recipient: Address,
    pub amount: i128,
}

/// Storage key for a metered (usage-based) vault (#46). An enum on purpose:
/// `#[contracttype]` structs encode as a map of field names without the type
/// name, so a struct with the same fields as `VaultKey` would share its storage
/// entry. The enum encodes as `["Vault", user, merchant]`, which can't collide.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MeteredVaultKey {
    /// (user, merchant)
    Vault(Address, Address),
}

/// Usage-based allowance (#46): the merchant may pull variable amounts, any
/// number of times, as long as the total within the current epoch stays at or
/// below `max_amount_per_interval`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MeteredVaultData {
    pub token: Address,
    pub max_amount_per_interval: i128,
    pub interval_seconds: u64,
    /// Ledger timestamp the current billing epoch started at.
    pub current_epoch_start: u64,
    /// Total pulled in the current epoch.
    pub epoch_spent: i128,
}

/// Storage key for the on-chain plan catalog (#95). `plan_id` is unique
/// across the contract so anyone can read a plan back with `get_plan`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanKey {
    pub plan_id: String,
}

/// Decentralized subscription plan metadata stored on-chain (#95) so
/// third-party dApps can verify plan terms without the off-chain database.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanData {
    pub merchant: Address,
    pub token: Address,
    pub amount_per_interval: i128,
    pub interval_seconds: u64,
    pub name: String,
    pub is_active: bool,
}

// ----------------------------------------------------------------------------
// CONTRACT LOGIC
// ----------------------------------------------------------------------------

/// Validates the terms and writes a fresh vault for (user, merchant), emitting
/// `vault_created` and extending storage TTLs. Shared by `create_vault` and
/// `create_vault_from_plan` so both paths behave identically.
fn write_vault(
    env: &Env,
    user: &Address,
    merchant: &Address,
    token: &Address,
    amount_per_interval: i128,
    interval_seconds: u64,
) {
    assert!(
        amount_per_interval > 0,
        "amount_per_interval must be positive"
    );
    assert!(
        interval_seconds > 0,
        "interval_seconds must be greater than zero"
    );

    let key = VaultKey {
        user: user.clone(),
        merchant: merchant.clone(),
    };

    let vault_data = VaultData {
        token: token.clone(),
        amount_per_interval,
        interval_seconds,
        last_pull_timestamp: 0,
        initial_timestamp: env.ledger().timestamp(),
        pull_sequence: PULL_SEQUENCE_UNSET,
        is_paused: false,
    };

    env.storage().persistent().set(&key, &vault_data);

    // Emit contract event
    env.events().publish(
        (
            Symbol::new(env, "vault_created"),
            user.clone(),
            merchant.clone(),
        ),
        (token.clone(), amount_per_interval, interval_seconds),
    );
    // Extend vault storage TTL and contract instance TTL to prevent archival
    let (threshold, extend_to) = calculate_ttl_params(interval_seconds);
    env.storage().persistent().extend_ttl(&key, threshold, extend_to);
    env.storage().instance().extend_ttl(threshold, extend_to);
}

#[contract]
pub struct OrbitContract;

#[contractimpl]
impl OrbitContract {
    /// 1. THE HANDSHAKE (Create Allowance)
    /// The user calls this to set up a recurring subscription for a merchant.
    pub fn create_vault(
        env: Env,
        user: Address,
        merchant: Address,
        token: Address,
        amount_per_interval: i128,
        interval_seconds: u64,
    ) {
        user.require_auth();

        write_vault(
            &env,
            &user,
            &merchant,
            &token,
            amount_per_interval,
            interval_seconds,
        );
    }

    /// Read the current terms for a user/merchant vault.
    /// This entrypoint requires no authorization and does not modify storage.
    pub fn get_vault(env: Env, user: Address, merchant: Address) -> Option<VaultData> {
        let key = VaultKey { user, merchant };

        env.storage().persistent().get(&key)
    }

    /// Close a vault so the merchant can no longer pull from it.
    /// Only the user can cancel. The token allowance is left untouched.
    /// Removes the fixed-interval vault and/or the metered vault (#46) for the
    /// pair; panics if neither exists.
    pub fn cancel_vault(env: Env, user: Address, merchant: Address) {
        user.require_auth();

        let key = VaultKey {
            user: user.clone(),
            merchant: merchant.clone(),
        };
        let metered_key = MeteredVaultKey::Vault(user.clone(), merchant.clone());

        let has_fixed = env.storage().persistent().has(&key);
        let has_metered = env.storage().persistent().has(&metered_key);
        assert!(has_fixed || has_metered, "Vault does not exist");

        if has_fixed {
            env.storage().persistent().remove(&key);
        }
        if has_metered {
            env.storage().persistent().remove(&metered_key);
        }

        // Emit contract event
        env.events()
            .publish((Symbol::new(&env, "vault_cancelled"), user, merchant), ());
    }

    /// Freeze a vault so the merchant cannot pull while the subscriber is away
    /// (e.g. seasonal pause). Only the subscriber can pause; the vault record,
    /// token allowance, and existing billing state are preserved (#93).
    pub fn pause_vault(env: Env, user: Address, merchant: Address) {
        user.require_auth();

        let key = VaultKey {
            user: user.clone(),
            merchant: merchant.clone(),
        };
        let mut vault: VaultData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Vault does not exist");

        vault.is_paused = true;
        env.storage().persistent().set(&key, &vault);

        // Emit contract event
        env.events()
            .publish((Symbol::new(&env, "vault_paused"), user, merchant), ());

        // Keep the paused vault (and contract) resident despite the inactivity
        let (threshold, extend_to) = calculate_ttl_params(vault.interval_seconds);
        env.storage().persistent().extend_ttl(&key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    /// Unfreeze a vault. The billing timestamp is reset to the current ledger
    /// timestamp so intervals that elapsed while paused are not back-billed
    /// retroactively (#93).
    pub fn resume_vault(env: Env, user: Address, merchant: Address) {
        user.require_auth();

        let key = VaultKey {
            user: user.clone(),
            merchant: merchant.clone(),
        };
        let mut vault: VaultData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Vault does not exist");

        vault.is_paused = false;
        vault.last_pull_timestamp = env.ledger().timestamp();
        env.storage().persistent().set(&key, &vault);

        // Emit contract event
        env.events()
            .publish((Symbol::new(&env, "vault_resumed"), user, merchant), ());

        let (threshold, extend_to) = calculate_ttl_params(vault.interval_seconds);
        env.storage().persistent().extend_ttl(&key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    /// 2. THE PULL (Execute Billing)
    /// The merchant (or the Orbit backend) calls this to pull the funds.
    pub fn pull_funds(env: Env, user: Address, merchant: Address) {
        merchant.require_auth();

        let key = VaultKey {
            user: user.clone(),
            merchant: merchant.clone(),
        };
        let mut vault: VaultData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Vault does not exist");

        // A paused subscriber is never billed (#93)
        assert!(!vault.is_paused, "Vault is paused by subscriber");

        let current_time = env.ledger().timestamp();

        if vault.last_pull_timestamp != 0 {
            assert!(
                current_time >= vault.last_pull_timestamp + vault.interval_seconds,
                "Too early to pull funds"
            );
        }

        // Deterministic epoch guard (#94): every settlement must advance the
        // billing cycle index, so no two pulls can ever land in the same cycle
        // regardless of ledger clock adjustments or retry races.
        let cycle_index =
            current_time.saturating_sub(vault.initial_timestamp) / vault.interval_seconds;
        assert!(
            vault.pull_sequence == PULL_SEQUENCE_UNSET || cycle_index > vault.pull_sequence,
            "Pull already settled in this billing cycle"
        );

        let token_client = token::Client::new(&env, &vault.token);
        token_client.transfer_from(
            &env.current_contract_address(),
            &user,
            &merchant,
            &vault.amount_per_interval,
        );

        vault.last_pull_timestamp = current_time;
        vault.pull_sequence = cycle_index;
        env.storage().persistent().set(&key, &vault);

        // Emit contract event
        env.events().publish(
            (Symbol::new(&env, "funds_pulled"), user, merchant),
            (vault.amount_per_interval, current_time),
        );
        // Extend TTL on each pull for both the vault entry and the contract instance
        let (threshold, extend_to) = calculate_ttl_params(vault.interval_seconds);
        env.storage().persistent().extend_ttl(&key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    // --------------------------------------------------------------------
    // METERED (USAGE-BASED) BILLING (#46)
    // --------------------------------------------------------------------

    /// Create a usage-based allowance: the merchant may pull variable amounts
    /// up to `max_amount_per_interval` in total per `interval_seconds` epoch.
    /// Re-creating replaces the terms and starts a fresh epoch.
    pub fn create_metered_vault(
        env: Env,
        user: Address,
        merchant: Address,
        token: Address,
        max_amount_per_interval: i128,
        interval_seconds: u64,
    ) {
        user.require_auth();

        assert!(
            max_amount_per_interval > 0,
            "max_amount_per_interval must be positive"
        );
        assert!(
            interval_seconds > 0,
            "interval_seconds must be greater than zero"
        );

        let key = MeteredVaultKey::Vault(user.clone(), merchant.clone());
        let vault = MeteredVaultData {
            token: token.clone(),
            max_amount_per_interval,
            interval_seconds,
            current_epoch_start: env.ledger().timestamp(),
            epoch_spent: 0,
        };
        env.storage().persistent().set(&key, &vault);

        env.events().publish(
            (Symbol::new(&env, "metered_vault_created"), user, merchant),
            (token, max_amount_per_interval, interval_seconds),
        );

        let (threshold, extend_to) = calculate_ttl_params(interval_seconds);
        env.storage()
            .persistent()
            .extend_ttl(&key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    /// Read a metered vault. No authorization and no storage mutation.
    pub fn get_metered_vault(
        env: Env,
        user: Address,
        merchant: Address,
    ) -> Option<MeteredVaultData> {
        let key = MeteredVaultKey::Vault(user, merchant);
        env.storage().persistent().get(&key)
    }

    /// Pull a variable `amount` against the current epoch's allowance. Several
    /// partial pulls per epoch are allowed until `max_amount_per_interval` is
    /// reached; the allowance resets once `interval_seconds` has elapsed since
    /// the epoch started.
    pub fn pull_metered_funds(env: Env, user: Address, merchant: Address, amount: i128) {
        merchant.require_auth();

        assert!(amount > 0, "amount must be positive");

        let key = MeteredVaultKey::Vault(user.clone(), merchant.clone());
        let mut vault: MeteredVaultData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Metered vault does not exist");

        // Epoch rollover: a new interval resets the allowance.
        let now = env.ledger().timestamp();
        if now
            >= vault
                .current_epoch_start
                .saturating_add(vault.interval_seconds)
        {
            vault.current_epoch_start = now;
            vault.epoch_spent = 0;
        }

        let new_spent = vault
            .epoch_spent
            .checked_add(amount)
            .expect("Interval spending limit exceeded");
        assert!(
            new_spent <= vault.max_amount_per_interval,
            "Interval spending limit exceeded"
        );

        // Record the spend before moving funds (checks-effects-interactions).
        vault.epoch_spent = new_spent;
        env.storage().persistent().set(&key, &vault);

        let token_client = token::Client::new(&env, &vault.token);
        token_client.transfer_from(&env.current_contract_address(), &user, &merchant, &amount);

        env.events().publish(
            (Symbol::new(&env, "metered_funds_pulled"), user, merchant),
            (amount, vault.epoch_spent, vault.max_amount_per_interval),
        );

        let (threshold, extend_to) = calculate_ttl_params(vault.interval_seconds);
        env.storage()
            .persistent()
            .extend_ttl(&key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    /// 3. THE SPLIT (Batch Payroll Disbursement)
    /// The merchant uploads a CSV of contractors. This function takes that array
    /// and routes the stablecoins to everyone globally in a single transaction block.
    pub fn batch_disburse(env: Env, sender: Address, token: Address, splits: Vec<PaymentSplit>) {
        // The sender (e.g., the Agency Owner) MUST sign this transaction to approve the payroll.
        sender.require_auth();

        assert!(!splits.is_empty(), "splits must not be empty");

        for split in splits.iter() {
            assert!(split.amount > 0, "split amount must be positive");
        }

        let token_client = token::Client::new(&env, &token);
        let recipient_count = splits.len();
        let mut total_amount: i128 = 0;

        // Loop through the array of contractors and amounts
        for split in splits.into_iter() {
            total_amount = total_amount
                .checked_add(split.amount)
                .expect("Total amount overflow");

            // Transfer the exact cut directly from the sender's wallet to the contractor
            token_client.transfer_from(
                &env.current_contract_address(),
                &sender,
                &split.recipient,
                &split.amount,
            );
        }

        // Emit contract event
        env.events().publish(
            (Symbol::new(&env, "batch_disbursed"), sender),
            (token, recipient_count, total_amount),
        );
    }

    // --------------------------------------------------------------------
    // ON-CHAIN PLAN CATALOG (#95)
    // --------------------------------------------------------------------

    /// Register a plan in the public on-chain catalog under merchant authority.
    /// Re-registering an existing `plan_id` is only allowed for the merchant
    /// that already owns it (it refreshes the terms and reactivates the plan).
    pub fn register_plan(
        env: Env,
        merchant: Address,
        plan_id: String,
        token: Address,
        amount_per_interval: i128,
        interval_seconds: u64,
        name: String,
    ) {
        merchant.require_auth();

        assert!(
            amount_per_interval > 0,
            "amount_per_interval must be positive"
        );
        assert!(
            interval_seconds > 0,
            "interval_seconds must be greater than zero"
        );

        let key = PlanKey {
            plan_id: plan_id.clone(),
        };
        if let Some(existing) = env.storage().persistent().get::<PlanKey, PlanData>(&key) {
            assert!(
                existing.merchant == merchant,
                "Plan ID is already registered by another merchant"
            );
        }

        let plan = PlanData {
            merchant: merchant.clone(),
            token: token.clone(),
            amount_per_interval,
            interval_seconds,
            name: name.clone(),
            is_active: true,
        };
        env.storage().persistent().set(&key, &plan);

        // Emit contract event
        env.events().publish(
            (
                Symbol::new(&env, "plan_registered"),
                merchant,
                plan_id,
            ),
            (token, amount_per_interval, interval_seconds, name),
        );

        // Extend plan storage TTL and contract instance TTL to prevent archival
        let (threshold, extend_to) = calculate_ttl_params(interval_seconds);
        env.storage().persistent().extend_ttl(&key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    /// Disable new subscriptions for a plan. Existing vaults created from the
    /// plan keep running, so in-flight subscribers are unaffected (#95).
    pub fn deactivate_plan(env: Env, merchant: Address, plan_id: String) {
        merchant.require_auth();

        let key = PlanKey {
            plan_id: plan_id.clone(),
        };
        let mut plan: PlanData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Plan does not exist");
        assert!(
            plan.merchant == merchant,
            "Only the owning merchant can deactivate this plan"
        );

        plan.is_active = false;
        env.storage().persistent().set(&key, &plan);

        // Emit contract event
        env.events()
            .publish((Symbol::new(&env, "plan_deactivated"), merchant, plan_id), ());

        let (threshold, extend_to) = calculate_ttl_params(plan.interval_seconds);
        env.storage().persistent().extend_ttl(&key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    /// Public read helper for the on-chain plan catalog. No authorization and
    /// no storage mutation.
    pub fn get_plan(env: Env, plan_id: String) -> Option<PlanData> {
        let key = PlanKey { plan_id };
        env.storage().persistent().get(&key)
    }

    /// Create a vault using terms read directly from the on-chain catalog, so
    /// the subscriber never has to trust off-chain plan metadata. Rejects
    /// deactivated plans while leaving existing vaults untouched (#95).
    pub fn create_vault_from_plan(env: Env, user: Address, plan_id: String) {
        user.require_auth();

        let key = PlanKey { plan_id };
        let plan: PlanData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Plan does not exist");
        assert!(plan.is_active, "Plan is not active");

        write_vault(
            &env,
            &user,
            &plan.merchant,
            &plan.token,
            plan.amount_per_interval,
            plan.interval_seconds,
        );
    }
}

#[cfg(test)]
mod test;
