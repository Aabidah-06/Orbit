-- Automated smart contract state snapshot backup and disaster recovery sync (#185)
-- Stores metadata and integrity checksums for daily Soroban contract state snapshots
-- exported to cold storage, plus audit history of disaster recovery restores.

CREATE TABLE IF NOT EXISTS contract_state_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id VARCHAR(128) NOT NULL UNIQUE,
    contract_id VARCHAR(128) NOT NULL,
    ledger_sequence BIGINT NOT NULL CHECK (ledger_sequence >= 0),
    schema_version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    checksum_sha256 VARCHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    vault_count INTEGER NOT NULL DEFAULT 0 CHECK (vault_count >= 0),
    plan_count INTEGER NOT NULL DEFAULT 0 CHECK (plan_count >= 0),
    config_count INTEGER NOT NULL DEFAULT 0 CHECK (config_count >= 0),
    storage_location TEXT,
    encrypted BOOLEAN NOT NULL DEFAULT FALSE,
    snapshot_payload JSONB,
    captured_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    restored_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contract_state_snapshots_contract_ledger_idx
    ON contract_state_snapshots (contract_id, ledger_sequence DESC);
CREATE INDEX IF NOT EXISTS contract_state_snapshots_captured_at_idx
    ON contract_state_snapshots (captured_at DESC);

ALTER TABLE contract_state_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE contract_state_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_state_snapshots TO service_role;
