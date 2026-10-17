#![no_std]
#![allow(deprecated)]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, String, Symbol, Vec, contractclient};

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
// SUBSCRIPTION CREDENTIALS, BITMAP INDEX, PAYMENT ROUTING & ESCROW (#123–126)
// ----------------------------------------------------------------------------

pub const DEFAULT_ESCROW_WINDOW_SECONDS: u64 = 86_400;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubscriptionKey {
    Badge(Address, Address),
    NextId(Address),
    Bitmap(Address, u32),
    Swap(Address, Address),
    EscrowPolicy(Address, Address),
    Escrow(u64),
    NextEscrowId,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BadgeData {
    pub active: bool,
    pub tier: u32,
    pub expiration_timestamp: u64,
    pub subscriber_id: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapConfig {
    pub payment_token: Address,
    pub settlement_token: Address,
    pub router: Address,
    pub max_input_amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowPolicy {
    pub arbitrator: Address,
    pub window_seconds: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowHold {
    pub user: Address,
    pub merchant: Address,
    pub token: Address,
    pub amount: i128,
    pub release_at: u64,
    pub arbitrator: Address,
    pub disputed: bool,
}

/// A trusted Soroban AMM router receives only the exact reserved input transferred
/// for this swap (never an approval to drain pooled escrow holdings), sends
/// settlement tokens to `recipient`, refunds unused input, and reports spent input.
/// It must execute atomically and enforce its own route/oracle protections.
#[contractclient(name = "SwapRouterClient")]
pub trait SwapRouter {
    fn swap_exact_output(
        env: Env,
        payment_token: Address,
        settlement_token: Address,
        amount_out: i128,
        max_amount_in: i128,
        recipient: Address,
    ) -> i128;
}

fn extend_key(env: &Env, key: &SubscriptionKey, interval: u64) {
    let (threshold, extend_to) = calculate_ttl_params(interval);
    env.storage().persistent().extend_ttl(key, threshold, extend_to);
}

fn bitmap_status(env: &Env, merchant: &Address, id: u32, active: bool, interval: u64) {
    let key = SubscriptionKey::Bitmap(merchant.clone(), id / 256);
    let mut bytes = env.storage().persistent()
        .get::<_, BytesN<32>>(&key)
        .unwrap_or_else(|| BytesN::from_array(env, &[0u8; 32]))
        .to_array();
    let offset = ((id % 256) / 8) as usize;
    let mask = 1u8 << (id % 8);
    if active { bytes[offset] |= mask; } else { bytes[offset] &= !mask; }
    env.storage().persistent().set(&key, &BytesN::from_array(env, &bytes));
    extend_key(env, &key, interval);
}

fn activate_badge(env: &Env, user: &Address, merchant: &Address, tier: u32, until: u64, interval: u64) {
    let key = SubscriptionKey::Badge(user.clone(), merchant.clone());
    let id = if let Some(existing) = env.storage().persistent().get::<_, BadgeData>(&key) {
        existing.subscriber_id
    } else {
        let next_key = SubscriptionKey::NextId(merchant.clone());
        let next: u32 = env.storage().persistent().get(&next_key).unwrap_or(0);
        env.storage().persistent().set(&next_key, &next.checked_add(1).expect("Subscriber ID exhausted"));
        extend_key(env, &next_key, interval);
        next
    };
    env.storage().persistent().set(&key, &BadgeData {
        active: true, tier, expiration_timestamp: until, subscriber_id: id,
    });
    extend_key(env, &key, interval);
    bitmap_status(env, merchant, id, true, interval);
}

fn deactivate_badge(env: &Env, user: &Address, merchant: &Address, interval: u64) {
    let key = SubscriptionKey::Badge(user.clone(), merchant.clone());
    if let Some(mut badge) = env.storage().persistent().get::<_, BadgeData>(&key) {
        badge.active = false;
        env.storage().persistent().set(&key, &badge);
        extend_key(env, &key, interval);
        bitmap_status(env, merchant, badge.subscriber_id, false, interval);
    }
}

/// Performs exact-output conversion into the vault settlement token.
/// Input is collected from the subscriber before invoking the approved router;
/// failure to receive the full output reverts the whole Soroban invocation.
fn pull_payment(env: &Env, user: &Address, merchant: &Address, vault: &VaultData, recipient: &Address) {
    let config_key = SubscriptionKey::Swap(user.clone(), merchant.clone());
    if let Some(config) = env.storage().persistent().get::<_, SwapConfig>(&config_key) {
        assert!(config.settlement_token == vault.token, "Wrong settlement token");
        assert!(config.payment_token != config.settlement_token, "Swap requires distinct tokens");
        assert!(config.max_input_amount > 0, "Invalid maximum input");
        let contract = env.current_contract_address();
        let input = token::Client::new(env, &config.payment_token);
        let output = token::Client::new(env, &config.settlement_token);
        let input_before = input.balance(&contract);
        let output_before = output.balance(&contract);
        input.transfer_from(&contract, user, &config.router, &config.max_input_amount);
        let spent = SwapRouterClient::new(env, &config.router).swap_exact_output(
            &config.payment_token, &config.settlement_token, &vault.amount_per_interval,
            &config.max_input_amount, &contract,
        );
        assert!(spent > 0 && spent <= config.max_input_amount, "Slippage limit exceeded");
        let received = output.balance(&contract) - output_before;
        assert!(received >= vault.amount_per_interval, "Insufficient settlement output");
        let unspent = input.balance(&contract) - input_before;
        assert!(unspent >= 0 && unspent <= config.max_input_amount,
            "Invalid swap input refund");
        assert!(config.max_input_amount - unspent == spent, "Router input accounting mismatch");
        if unspent > 0 { input.transfer(&contract, user, &unspent); }
        if received > vault.amount_per_interval {
            output.transfer(&contract, user, &(received - vault.amount_per_interval));
        }
        output.transfer(&contract, recipient, &vault.amount_per_interval);
        extend_key(env, &config_key, vault.interval_seconds);
    } else {
        token::Client::new(env, &vault.token).transfer_from(
            &env.current_contract_address(), user, recipient, &vault.amount_per_interval,
        );
    }
}

fn store_escrow(env: &Env, user: &Address, merchant: &Address, vault: &VaultData, policy: &EscrowPolicy) -> u64 {
    let counter_key = SubscriptionKey::NextEscrowId;
    let next: u64 = env.storage().instance().get(&counter_key).unwrap_or(0);
    env.storage().instance().set(&counter_key, &next.checked_add(1).expect("Escrow ID exhausted"));
    let hold_key = SubscriptionKey::Escrow(next);
    let hold = EscrowHold {
        user: user.clone(), merchant: merchant.clone(), token: vault.token.clone(),
        amount: vault.amount_per_interval,
        release_at: env.ledger().timestamp().saturating_add(policy.window_seconds),
        arbitrator: policy.arbitrator.clone(), disputed: false,
    };
    env.storage().persistent().set(&hold_key, &hold);
    extend_key(env, &hold_key, policy.window_seconds);
    next
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

    // A replacement subscription resets payment policies, but retains the
    // sequential badge identity previously assigned to this subscriber.
    env.storage().persistent().remove(&SubscriptionKey::Swap(user.clone(), merchant.clone()));
    env.storage().persistent().remove(&SubscriptionKey::EscrowPolicy(user.clone(), merchant.clone()));
    let tier = env.storage().persistent()
        .get::<_, BadgeData>(&SubscriptionKey::Badge(user.clone(), merchant.clone()))
        .map(|badge| badge.tier).unwrap_or(1);
    activate_badge(env, user, merchant, tier,
        env.ledger().timestamp().saturating_add(interval_seconds), interval_seconds);

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

    /// Contract-native soulbound credential: no transfer or approval method
    /// exists; third-party contracts can call this public read once per pair.
    pub fn get_subscriber_badge(env: Env, user: Address, merchant: Address) -> Option<BadgeData> {
        env.storage().persistent().get(&SubscriptionKey::Badge(user, merchant))
    }

    pub fn is_subscriber_active(env: Env, user: Address, merchant: Address) -> bool {
        let key = VaultKey { user: user.clone(), merchant: merchant.clone() };
        let vault: Option<VaultData> = env.storage().persistent().get(&key);
        let badge: Option<BadgeData> = env.storage().persistent().get(
            &SubscriptionKey::Badge(user, merchant));
        match (vault, badge) {
            (Some(vault), Some(badge)) => badge.active && !vault.is_paused
                && env.ledger().timestamp() < badge.expiration_timestamp,
            _ => false,
        }
    }

    /// Merchant-assigned tier, without allowing arbitrary minting by a user.
    pub fn set_subscriber_tier(env: Env, user: Address, merchant: Address, tier: u32) {
        merchant.require_auth();
        assert!(tier > 0, "Tier must be positive");
        let key = SubscriptionKey::Badge(user.clone(), merchant.clone());
        let mut badge: BadgeData = env.storage().persistent().get(&key)
            .expect("Subscription badge does not exist");
        assert!(env.storage().persistent().has(&VaultKey { user, merchant }),
            "Vault does not exist");
        badge.tier = tier;
        env.storage().persistent().set(&key, &badge);
    }

    /// Permissionless keeper hook synchronizes a time-expired credential with
    /// its packed bitmap. Validity reads also enforce expiration independently.
    pub fn mark_subscription_default(env: Env, user: Address, merchant: Address) -> bool {
        let key = SubscriptionKey::Badge(user.clone(), merchant.clone());
        if let Some(badge) = env.storage().persistent().get::<_, BadgeData>(&key) {
            if badge.active && env.ledger().timestamp() >= badge.expiration_timestamp {
                let interval = env.storage().persistent()
                    .get::<_, VaultData>(&VaultKey { user: user.clone(), merchant: merchant.clone() })
                    .map(|v| v.interval_seconds).unwrap_or(DEFAULT_ESCROW_WINDOW_SECONDS);
                deactivate_badge(&env, &user, &merchant, interval);
                return true;
            }
        }
        false
    }

    pub fn get_subscriber_bitmap_chunk(env: Env, merchant: Address, chunk_index: u32) -> BytesN<32> {
        env.storage().persistent()
            .get(&SubscriptionKey::Bitmap(merchant, chunk_index))
            .unwrap_or_else(|| BytesN::from_array(&env, &[0u8; 32]))
    }

    /// Configure a per-vault cross-asset exact-output Soroban AMM router.
    /// Both parties consent to the trusted router, token choice, and cap.
    pub fn configure_swap(
        env: Env, user: Address, merchant: Address,
        payment_token: Address, router: Address, max_input_amount: i128,
    ) {
        user.require_auth();
        merchant.require_auth();
        assert!(max_input_amount > 0, "Maximum input must be positive");
        let vault: VaultData = env.storage().persistent()
            .get(&VaultKey { user: user.clone(), merchant: merchant.clone() })
            .expect("Vault does not exist");
        assert!(payment_token != vault.token, "Use regular billing for same-token settlement");
        let key = SubscriptionKey::Swap(user, merchant);
        env.storage().persistent().set(&key, &SwapConfig {
            payment_token, settlement_token: vault.token,
            router, max_input_amount,
        });
        extend_key(&env, &key, vault.interval_seconds);
    }

    pub fn clear_swap(env: Env, user: Address, merchant: Address) {
        user.require_auth();
        env.storage().persistent().remove(&SubscriptionKey::Swap(user, merchant));
    }

    /// Opt into dispute-protected settlement with a pre-agreed arbitrator.
    /// Legacy vaults continue immediate settlement for backward compatibility.
    pub fn configure_escrow(
        env: Env, user: Address, merchant: Address,
        arbitrator: Address, escrow_window_seconds: u64,
    ) {
        user.require_auth();
        merchant.require_auth();
        assert!(escrow_window_seconds > 0, "Escrow window must be positive");
        let vault: VaultData = env.storage().persistent()
            .get(&VaultKey { user: user.clone(), merchant: merchant.clone() })
            .expect("Vault does not exist");
        let key = SubscriptionKey::EscrowPolicy(user, merchant);
        env.storage().persistent().set(&key, &EscrowPolicy {
            arbitrator, window_seconds: escrow_window_seconds,
        });
        extend_key(&env, &key, vault.interval_seconds.max(escrow_window_seconds));
    }

    /// Subscriber-only dispute during an open claim window. A disputed hold
    /// cannot be claimed until the designated arbitrator resolves it.
    pub fn raise_dispute(env: Env, user: Address, merchant: Address, pull_id: u64) {
        user.require_auth();
        let key = SubscriptionKey::Escrow(pull_id);
        let mut hold: EscrowHold = env.storage().persistent().get(&key)
            .expect("Escrow does not exist");
        assert!(hold.user == user && hold.merchant == merchant, "Wrong escrow parties");
        assert!(env.ledger().timestamp() < hold.release_at, "Dispute window closed");
        assert!(!hold.disputed, "Already disputed");
        hold.disputed = true;
        env.storage().persistent().set(&key, &hold);
    }

    /// The escrow's designated arbitrator is the only entity authorized to
    /// apportion funds. Percentages outside 0–100 are rejected.
    pub fn resolve_dispute(env: Env, arbitrator: Address, pull_id: u64, refund_percentage: u32) {
        arbitrator.require_auth();
        assert!(refund_percentage <= 100, "Invalid refund percentage");
        let key = SubscriptionKey::Escrow(pull_id);
        let hold: EscrowHold = env.storage().persistent().get(&key)
            .expect("Escrow does not exist");
        assert!(hold.disputed, "Escrow is not disputed");
        assert!(hold.arbitrator == arbitrator, "Unauthorized arbitrator");
        env.storage().persistent().remove(&key);
        let refund = (hold.amount / 100) * i128::from(refund_percentage)
            + ((hold.amount % 100) * i128::from(refund_percentage) / 100);
        let contract = env.current_contract_address();
        let token = token::Client::new(&env, &hold.token);
        if refund > 0 { token.transfer(&contract, &hold.user, &refund); }
        if hold.amount > refund {
            token.transfer(&contract, &hold.merchant, &(hold.amount - refund));
        }
    }

    pub fn claim_escrow_funds(env: Env, merchant: Address, pull_id: u64) {
        merchant.require_auth();
        let key = SubscriptionKey::Escrow(pull_id);
        let hold: EscrowHold = env.storage().persistent().get(&key)
            .expect("Escrow does not exist");
        assert!(hold.merchant == merchant, "Wrong escrow merchant");
        assert!(!hold.disputed, "Escrow disputed");
        assert!(env.ledger().timestamp() >= hold.release_at, "Escrow window still open");
        env.storage().persistent().remove(&key);
        token::Client::new(&env, &hold.token)
            .transfer(&env.current_contract_address(), &merchant, &hold.amount);
    }

    pub fn get_escrow(env: Env, pull_id: u64) -> Option<EscrowHold> {
        env.storage().persistent().get(&SubscriptionKey::Escrow(pull_id))
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
            let vault: VaultData = env.storage().persistent().get(&key).expect("Vault missing");
            deactivate_badge(&env, &user, &merchant, vault.interval_seconds);
            env.storage().persistent().remove(&key);
            env.storage().persistent().remove(&SubscriptionKey::Swap(user.clone(), merchant.clone()));
            env.storage().persistent().remove(&SubscriptionKey::EscrowPolicy(user.clone(), merchant.clone()));
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
        deactivate_badge(&env, &user, &merchant, vault.interval_seconds);

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
        let tier = env.storage().persistent()
            .get::<_, BadgeData>(&SubscriptionKey::Badge(user.clone(), merchant.clone()))
            .map(|b| b.tier).unwrap_or(1);
        activate_badge(&env, &user, &merchant, tier,
            env.ledger().timestamp().saturating_add(vault.interval_seconds), vault.interval_seconds);

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

        let policy_key = SubscriptionKey::EscrowPolicy(user.clone(), merchant.clone());
        let policy: Option<EscrowPolicy> = env.storage().persistent().get(&policy_key);
        let recipient = if policy.is_some() { env.current_contract_address() }
            else { merchant.clone() };
        pull_payment(&env, &user, &merchant, &vault, &recipient);
        if let Some(policy) = policy {
            let pull_id = store_escrow(&env, &user, &merchant, &vault, &policy);
            extend_key(&env, &policy_key, vault.interval_seconds.max(policy.window_seconds));
            env.events().publish(
                (Symbol::new(&env, "escrow_held"), pull_id),
                (user.clone(), merchant.clone(), vault.amount_per_interval),
            );
        }

        let tier = env.storage().persistent()
            .get::<_, BadgeData>(&SubscriptionKey::Badge(user.clone(), merchant.clone()))
            .map(|b| b.tier).unwrap_or(1);
        activate_badge(&env, &user, &merchant, tier,
            current_time.saturating_add(vault.interval_seconds), vault.interval_seconds);

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
