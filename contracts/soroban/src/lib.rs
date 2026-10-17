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

/// Upper bound on a payroll proposal's approver list, keeping approval checks and
/// proposal storage within Soroban resource limits.
pub const MAX_PAYROLL_APPROVERS: u32 = 20;

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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentSplit {
    pub recipient: Address,
    pub amount: i128,
}

/// A batch disbursement that only executes once `required_approvals` distinct
/// addresses from `approvers` have approved it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayrollProposal {
    pub id: u64,
    pub sender: Address,
    pub token: Address,
    pub splits: Vec<PaymentSplit>,
    pub approvers: Vec<Address>,
    pub approvals: Vec<Address>,
    pub required_approvals: u32,
    pub executed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Id the next payroll proposal will receive
    NextProposalId,
    Proposal(u64),
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

        let key = VaultKey {
            user: user.clone(),
            merchant: merchant.clone(),
        };

        let vault_data = VaultData {
            token: token.clone(),
            amount_per_interval,
            interval_seconds,
            last_pull_timestamp: 0,
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

    /// 3. THE SPLIT (Batch Payroll Disbursement)
    /// The merchant uploads a CSV of contractors. This function takes that array
    /// and routes the stablecoins to everyone globally in a single transaction block.
    pub fn batch_disburse(env: Env, sender: Address, token: Address, splits: Vec<PaymentSplit>) {
        // The sender (e.g., the Agency Owner) MUST sign this transaction to approve the payroll.
        sender.require_auth();

        let total_amount = validate_splits(&splits);
        let recipient_count = splits.len();
        disburse(&env, &sender, &token, splits);

        // Emit contract event
        env.events().publish(
            (Symbol::new(&env, "batch_disbursed"), sender),
            (token, recipient_count, total_amount),
        );
    }

    /// 4. MULTI-SIG PAYROLL: PROPOSE
    /// The sender stages a batch disbursement that only executes once
    /// `required_approvals` distinct addresses from `approvers` approve it.
    /// Returns the proposal id.
    pub fn propose_batch_disburse(
        env: Env,
        sender: Address,
        token: Address,
        splits: Vec<PaymentSplit>,
        required_approvals: u32,
        approvers: Vec<Address>,
    ) -> u64 {
        sender.require_auth();

        let total_amount = validate_splits(&splits);

        assert!(!approvers.is_empty(), "approvers must not be empty");
        assert!(
            approvers.len() <= MAX_PAYROLL_APPROVERS,
            "too many approvers"
        );
        for (i, approver) in approvers.iter().enumerate() {
            assert!(
                approvers.first_index_of(&approver) == Some(i as u32),
                "approvers must be distinct"
            );
        }
        assert!(
            required_approvals > 0 && required_approvals <= approvers.len(),
            "required_approvals must be between 1 and the number of approvers"
        );

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextProposalId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::NextProposalId, &(id + 1));

        let proposal = PayrollProposal {
            id,
            sender: sender.clone(),
            token: token.clone(),
            splits,
            approvers,
            approvals: Vec::new(&env),
            required_approvals,
            executed: false,
        };
        save_proposal(&env, &proposal);

        env.events().publish(
            (Symbol::new(&env, "payroll_proposed"), sender, id),
            (
                token,
                required_approvals,
                proposal.approvers.len(),
                total_amount,
            ),
        );
        id
    }

    /// 5. MULTI-SIG PAYROLL: APPROVE
    /// An address from the proposal's approver list signs off on it. Each approver
    /// counts once.
    pub fn approve_payroll_proposal(env: Env, approver: Address, proposal_id: u64) {
        approver.require_auth();

        let mut proposal = load_proposal(&env, proposal_id);
        assert!(!proposal.executed, "Proposal already executed");
        assert!(
            proposal.approvers.contains(&approver),
            "Address is not an approver for this proposal"
        );
        assert!(
            !proposal.approvals.contains(&approver),
            "Approver has already approved this proposal"
        );

        proposal.approvals.push_back(approver.clone());
        save_proposal(&env, &proposal);

        env.events().publish(
            (Symbol::new(&env, "payroll_approved"), approver, proposal_id),
            (proposal.approvals.len(), proposal.required_approvals),
        );
    }

    /// 6. MULTI-SIG PAYROLL: EXECUTE
    /// Once the approval threshold is met, anyone may trigger the transfers. A proposal
    /// executes at most once.
    pub fn execute_payroll_proposal(env: Env, proposal_id: u64) {
        let mut proposal = load_proposal(&env, proposal_id);
        assert!(!proposal.executed, "Proposal already executed");
        assert!(
            proposal.approvals.len() >= proposal.required_approvals,
            "Approval threshold not met"
        );

        // Marked before transferring; a failed transfer reverts this along with everything else
        proposal.executed = true;
        save_proposal(&env, &proposal);

        let total_amount = validate_splits(&proposal.splits);
        let recipient_count = proposal.splits.len();
        disburse(
            &env,
            &proposal.sender,
            &proposal.token,
            proposal.splits.clone(),
        );

        env.events().publish(
            (
                Symbol::new(&env, "payroll_executed"),
                proposal.sender,
                proposal_id,
            ),
            (proposal.token, recipient_count, total_amount),
        );
    }

    /// Read a payroll proposal and its approval state.
    /// This entrypoint requires no authorization and does not modify storage.
    pub fn get_payroll_proposal(env: Env, proposal_id: u64) -> Option<PayrollProposal> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }
}

/// Checks every split upfront so a bad entry fails before any transfer. Returns the total.
fn validate_splits(splits: &Vec<PaymentSplit>) -> i128 {
    assert!(!splits.is_empty(), "splits must not be empty");

    let mut total_amount: i128 = 0;
    for split in splits.iter() {
        assert!(split.amount > 0, "split amount must be positive");
        total_amount = total_amount
            .checked_add(split.amount)
            .expect("Total amount overflow");
    }
    total_amount
}

/// Transfers each split from the sender's allowance to its recipient.
fn disburse(env: &Env, sender: &Address, token: &Address, splits: Vec<PaymentSplit>) {
    let token_client = token::Client::new(env, token);

    // Loop through the array of contractors and amounts
    for split in splits.into_iter() {
        // Transfer the exact cut directly from the sender's wallet to the contractor
        token_client.transfer_from(
            &env.current_contract_address(),
            sender,
            &split.recipient,
            &split.amount,
        );
    }
}

fn load_proposal(env: &Env, proposal_id: u64) -> PayrollProposal {
    env.storage()
        .persistent()
        .get(&DataKey::Proposal(proposal_id))
        .expect("Proposal does not exist")
}

fn save_proposal(env: &Env, proposal: &PayrollProposal) {
    let key = DataKey::Proposal(proposal.id);
    env.storage().persistent().set(&key, proposal);
    // Keep pending and executed proposals live; executed ones are kept for replay protection
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, MIN_TTL_LEDGERS);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, MIN_TTL_LEDGERS);
}

#[cfg(test)]
mod test;
