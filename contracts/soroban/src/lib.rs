#![no_std]
#![allow(deprecated)]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol, Vec};

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

/// Vault terms as returned by `get_vault`. On the ledger they are stored as a
/// `StoredVault` instead; see `save_vault`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultData {
    pub token: Address,
    pub amount_per_interval: i128,
    pub interval_seconds: u64,
    pub last_pull_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentSplit {
    pub recipient: Address,
    pub amount: i128,
}

// ----------------------------------------------------------------------------
// STORAGE LAYOUT
// ----------------------------------------------------------------------------
//
// Vaults are the contract's only ledger state, and they are long-lived, so they
// stay in persistent storage. Every byte of a persistent entry is paid for on
// each write and for every ledger of rent, so entries are encoded positionally:
//
//   key:   (user, merchant)                                         an ScVec
//   value: StoredVault(token, amount, interval, last_pull)          an ScVec
//
// A named struct is encoded as an ScMap that repeats its field names ("user",
// "merchant", "amount_per_interval", ...) in every entry; tuples do not. The
// contract has no upgrade entrypoint, so every deployment starts from empty
// storage and there is no older layout to migrate.

/// On-ledger form of `VaultData`: (token, amount_per_interval, interval_seconds,
/// last_pull_timestamp).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredVault(pub Address, pub i128, pub u64, pub u64);

impl From<StoredVault> for VaultData {
    fn from(stored: StoredVault) -> Self {
        VaultData {
            token: stored.0,
            amount_per_interval: stored.1,
            interval_seconds: stored.2,
            last_pull_timestamp: stored.3,
        }
    }
}

impl From<VaultData> for StoredVault {
    fn from(vault: VaultData) -> Self {
        StoredVault(
            vault.token,
            vault.amount_per_interval,
            vault.interval_seconds,
            vault.last_pull_timestamp,
        )
    }
}

fn vault_key(user: &Address, merchant: &Address) -> (Address, Address) {
    (user.clone(), merchant.clone())
}

fn load_vault(env: &Env, key: &(Address, Address)) -> Option<VaultData> {
    env.storage()
        .persistent()
        .get::<_, StoredVault>(key)
        .map(VaultData::from)
}

fn save_vault(env: &Env, key: &(Address, Address), vault: VaultData) {
    env.storage()
        .persistent()
        .set(key, &StoredVault::from(vault));
}

// ----------------------------------------------------------------------------
// CONTRACT LOGIC
// ----------------------------------------------------------------------------

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

        assert!(
            amount_per_interval > 0,
            "amount_per_interval must be positive"
        );
        assert!(
            interval_seconds > 0,
            "interval_seconds must be greater than zero"
        );

        let key = vault_key(&user, &merchant);

        let vault_data = VaultData {
            token: token.clone(),
            amount_per_interval,
            interval_seconds,
            last_pull_timestamp: 0,
        };

        save_vault(&env, &key, vault_data);

        // Emit contract event
        env.events().publish(
            (Symbol::new(&env, "vault_created"), user, merchant),
            (token, amount_per_interval, interval_seconds),
        );
        // Extend vault storage TTL and contract instance TTL to prevent archival
        let (threshold, extend_to) = calculate_ttl_params(interval_seconds);
        env.storage().persistent().extend_ttl(&key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    /// Read the current terms for a user/merchant vault.
    /// This entrypoint requires no authorization and does not modify storage.
    pub fn get_vault(env: Env, user: Address, merchant: Address) -> Option<VaultData> {
        load_vault(&env, &vault_key(&user, &merchant))
    }

    /// Close a vault so the merchant can no longer pull from it.
    /// Only the user can cancel. The token allowance is left untouched.
    pub fn cancel_vault(env: Env, user: Address, merchant: Address) {
        user.require_auth();

        let key = vault_key(&user, &merchant);

        assert!(env.storage().persistent().has(&key), "Vault does not exist");

        // The vault is the only entry kept per (user, merchant), so removing it
        // returns all of the pair's ledger state and stops its rent
        env.storage().persistent().remove(&key);

        // Emit contract event
        env.events()
            .publish((Symbol::new(&env, "vault_cancelled"), user, merchant), ());
    }

    /// 2. THE PULL (Execute Billing)
    /// The merchant (or the Orbit backend) calls this to pull the funds.
    pub fn pull_funds(env: Env, user: Address, merchant: Address) {
        merchant.require_auth();

        let key = vault_key(&user, &merchant);
        let mut vault = load_vault(&env, &key).expect("Vault does not exist");
        let current_time = env.ledger().timestamp();

        if vault.last_pull_timestamp != 0 {
            assert!(
                current_time >= vault.last_pull_timestamp + vault.interval_seconds,
                "Too early to pull funds"
            );
        }

        let token_client = token::Client::new(&env, &vault.token);
        token_client.transfer_from(
            &env.current_contract_address(),
            &user,
            &merchant,
            &vault.amount_per_interval,
        );

        vault.last_pull_timestamp = current_time;
        let amount_per_interval = vault.amount_per_interval;
        let interval_seconds = vault.interval_seconds;
        save_vault(&env, &key, vault);

        // Emit contract event
        env.events().publish(
            (Symbol::new(&env, "funds_pulled"), user, merchant),
            (amount_per_interval, current_time),
        );
        // Extend TTL on each pull for both the vault entry and the contract instance
        let (threshold, extend_to) = calculate_ttl_params(interval_seconds);
        env.storage().persistent().extend_ttl(&key, threshold, extend_to);
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
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod test_storage;
