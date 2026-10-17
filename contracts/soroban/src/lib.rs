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
pub const DEFAULT_GRACE_PERIOD_SECONDS: u64 = 3 * 24 * 60 * 60;
pub const PAYMENT_ACTIVE: u32 = 0;
pub const PAYMENT_GRACE_PERIOD: u32 = 1;
pub const PAYMENT_DEFAULTED: u32 = 2;

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
    pub grace_period_seconds: u64,
    pub payment_status: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamKey {
    pub id: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamData {
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit_amount: i128,
    pub start_time: u64,
    pub stop_time: u64,
    pub amount_withdrawn: i128,
}

#[contracttype]
pub enum StorageKey {
    NextStreamId,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentSplit {
    pub recipient: Address,
    pub amount: i128,
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
        Self::create_vault_with_grace_period(
            env,
            user,
            merchant,
            token,
            amount_per_interval,
            interval_seconds,
            DEFAULT_GRACE_PERIOD_SECONDS,
        );
    }

    pub fn create_vault_with_grace_period(
        env: Env,
        user: Address,
        merchant: Address,
        token: Address,
        amount_per_interval: i128,
        interval_seconds: u64,
        grace_period_seconds: u64,
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
        assert!(
            grace_period_seconds > 0,
            "grace_period_seconds must be greater than zero"
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
            grace_period_seconds,
            payment_status: PAYMENT_ACTIVE,
        };

        env.storage().persistent().set(&key, &vault_data);

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
        let key = VaultKey { user, merchant };

        env.storage().persistent().get(&key)
    }

    /// Close a vault so the merchant can no longer pull from it.
    /// Only the user can cancel. The token allowance is left untouched.
    pub fn cancel_vault(env: Env, user: Address, merchant: Address) {
        user.require_auth();

        let key = VaultKey {
            user: user.clone(),
            merchant: merchant.clone(),
        };

        assert!(env.storage().persistent().has(&key), "Vault does not exist");

        env.storage().persistent().remove(&key);

        // Emit contract event
        env.events()
            .publish((Symbol::new(&env, "vault_cancelled"), user, merchant), ());
    }

    pub fn merchant_cancel_vault(env: Env, merchant: Address, user: Address) {
        merchant.require_auth();
        let key = VaultKey {
            user: user.clone(),
            merchant: merchant.clone(),
        };
        assert!(env.storage().persistent().has(&key), "Vault does not exist");
        env.storage().persistent().remove(&key);
        env.events().publish(
            (Symbol::new(&env, "merchant_vault_cancelled"), user, merchant),
            (),
        );
    }

    pub fn refund_subscriber(
        env: Env,
        merchant: Address,
        user: Address,
        token: Address,
        refund_amount: i128,
    ) {
        merchant.require_auth();
        assert!(refund_amount > 0, "refund_amount must be positive");
        token::Client::new(&env, &token).transfer_from(
            &env.current_contract_address(),
            &merchant,
            &user,
            &refund_amount,
        );
        env.events().publish(
            (Symbol::new(&env, "subscriber_refunded"), merchant, user),
            (token, refund_amount),
        );
    }

    pub fn record_failed_pull(env: Env, merchant: Address, user: Address) {
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
        let current_time = env.ledger().timestamp();
        let due_date = vault
            .last_pull_timestamp
            .checked_add(vault.interval_seconds)
            .expect("Due date overflow");

        if vault.payment_status == PAYMENT_DEFAULTED {
            return;
        }
        if current_time > due_date {
            let grace_end = due_date
                .checked_add(vault.grace_period_seconds)
                .expect("Grace period overflow");
            vault.payment_status = if current_time >= grace_end {
                PAYMENT_DEFAULTED
            } else {
                PAYMENT_GRACE_PERIOD
            };
            env.storage().persistent().set(&key, &vault);
            env.events().publish(
                (Symbol::new(&env, "payment_status_updated"), user, merchant),
                (vault.payment_status, current_time),
            );
        }
    }

    pub fn update_vault_terms(
        env: Env,
        user: Address,
        merchant: Address,
        new_amount: i128,
        new_interval_seconds: u64,
    ) {
        user.require_auth();
        assert!(new_amount > 0, "new_amount must be positive");
        assert!(
            new_interval_seconds > 0,
            "new_interval_seconds must be greater than zero"
        );
        let key = VaultKey {
            user: user.clone(),
            merchant: merchant.clone(),
        };
        let mut vault: VaultData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Vault does not exist");
        vault.amount_per_interval = new_amount;
        vault.interval_seconds = new_interval_seconds;
        env.storage().persistent().set(&key, &vault);
        env.events().publish(
            (Symbol::new(&env, "vault_terms_updated"), user, merchant),
            (new_amount, new_interval_seconds),
        );
        let (threshold, extend_to) = calculate_ttl_params(new_interval_seconds);
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
        let current_time = env.ledger().timestamp();

        let due_date = vault
            .last_pull_timestamp
            .checked_add(vault.interval_seconds)
            .expect("Due date overflow");
        if vault.payment_status == PAYMENT_GRACE_PERIOD {
            let grace_end = due_date
                .checked_add(vault.grace_period_seconds)
                .expect("Grace period overflow");
            if current_time >= grace_end {
                vault.payment_status = PAYMENT_DEFAULTED;
                env.storage().persistent().set(&key, &vault);
            }
        }
        assert!(
            vault.payment_status != PAYMENT_DEFAULTED,
            "Vault is defaulted"
        );

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
        vault.payment_status = PAYMENT_ACTIVE;
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

    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit_amount: i128,
        start_time: u64,
        stop_time: u64,
    ) -> u64 {
        sender.require_auth();
        assert!(deposit_amount > 0, "deposit_amount must be positive");
        assert!(stop_time > start_time, "stop_time must be after start_time");

        let stream_id: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::NextStreamId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&StorageKey::NextStreamId, &(stream_id + 1));

        token::Client::new(&env, &token).transfer_from(
            &env.current_contract_address(),
            &sender,
            &env.current_contract_address(),
            &deposit_amount,
        );
        let key = StreamKey { id: stream_id };
        env.storage().persistent().set(
            &key,
            &StreamData {
                sender: sender.clone(),
                recipient: recipient.clone(),
                token: token.clone(),
                deposit_amount,
                start_time,
                stop_time,
                amount_withdrawn: 0,
            },
        );
        env.events().publish(
            (Symbol::new(&env, "stream_created"), sender, recipient),
            (stream_id, deposit_amount, start_time, stop_time),
        );
        stream_id
    }

    pub fn withdraw_from_stream(env: Env, stream_id: u64, amount: i128) {
        let key = StreamKey { id: stream_id };
        let mut stream: StreamData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Stream does not exist");
        stream.recipient.require_auth();
        assert!(amount > 0, "amount must be positive");
        let vested = Self::vested_amount(&env, &stream);
        let available = vested - stream.amount_withdrawn;
        assert!(amount <= available, "Amount exceeds vested balance");
        stream.amount_withdrawn = stream
            .amount_withdrawn
            .checked_add(amount)
            .expect("Withdrawn amount overflow");
        token::Client::new(&env, &stream.token).transfer(
            &env.current_contract_address(),
            &stream.recipient,
            &amount,
        );
        env.storage().persistent().set(&key, &stream);
    }

    pub fn cancel_stream(env: Env, stream_id: u64) {
        let key = StreamKey { id: stream_id };
        let stream: StreamData = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Stream does not exist");
        let caller = env.invoker();
        assert!(
            caller == stream.sender || caller == stream.recipient,
            "Sender or recipient authorization required"
        );
        caller.require_auth();
        let vested = Self::vested_amount(&env, &stream);
        let recipient_amount = vested - stream.amount_withdrawn;
        let sender_amount = stream.deposit_amount - vested;
        let token_client = token::Client::new(&env, &stream.token);
        if recipient_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &stream.recipient,
                &recipient_amount,
            );
        }
        if sender_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &stream.sender,
                &sender_amount,
            );
        }
        env.storage().persistent().remove(&key);
    }

    fn vested_amount(env: &Env, stream: &StreamData) -> i128 {
        let now = env.ledger().timestamp();
        if now <= stream.start_time {
            return 0;
        }
        if now >= stream.stop_time {
            return stream.deposit_amount;
        }
        let elapsed = now - stream.start_time;
        let duration = stream.stop_time - stream.start_time;
        stream
            .deposit_amount
            .checked_mul(elapsed as i128)
            .expect("Vested amount overflow")
            / duration as i128
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
