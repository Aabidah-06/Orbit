-- 160-payout-splits.sql
-- Automated merchant payout split engine: recipients that share every settlement,
-- plus the distribution ledger that links a primary pull transaction to each
-- secondary forward transfer. Apply to existing databases before enabling the
-- split dispatcher; the same DDL is appended to schema.sql for fresh installs.

CREATE TABLE IF NOT EXISTS merchant_payout_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    recipient_wallet VARCHAR(255) NOT NULL,
    percentage_basis_points INTEGER NOT NULL
        CHECK (percentage_basis_points > 0 AND percentage_basis_points <= 10000),
    label VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- One split per recipient per merchant keeps allocation deterministic.
    UNIQUE (merchant_id, recipient_wallet)
);
CREATE INDEX IF NOT EXISTS merchant_payout_splits_merchant_active_idx
    ON merchant_payout_splits (merchant_id, is_active);

-- Distribution ledger. amount_usdc_units and percentage_basis_points are the
-- frozen terms of the settlement, never reconstructed from mutable split rows.
-- The unique (primary_tx_hash, recipient_wallet) pair makes redelivered
-- payment.settled events idempotent.
CREATE TABLE IF NOT EXISTS payout_distributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    primary_tx_hash VARCHAR(128) NOT NULL,
    recipient_wallet VARCHAR(255) NOT NULL,
    split_id UUID REFERENCES merchant_payout_splits(id) ON DELETE SET NULL,
    label VARCHAR(255),
    percentage_basis_points INTEGER NOT NULL
        CHECK (percentage_basis_points > 0 AND percentage_basis_points <= 10000),
    amount_usdc_units NUMERIC NOT NULL CHECK (amount_usdc_units >= 0),
    status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'submitted', 'settled', 'failed')),
    split_tx_hash VARCHAR(128),
    error TEXT,
    settled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (primary_tx_hash, recipient_wallet)
);
CREATE INDEX IF NOT EXISTS payout_distributions_merchant_created_idx
    ON payout_distributions (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payout_distributions_status_idx
    ON payout_distributions (status);
CREATE INDEX IF NOT EXISTS payout_distributions_primary_tx_idx
    ON payout_distributions (primary_tx_hash);

-- Backend-only: service role bypasses RLS; no anon/authenticated policy is defined.
ALTER TABLE merchant_payout_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_distributions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE merchant_payout_splits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE payout_distributions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON merchant_payout_splits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON payout_distributions TO service_role;
