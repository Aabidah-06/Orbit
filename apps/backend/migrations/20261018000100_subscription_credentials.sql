-- Privacy-preserving subscription credentials (#132): issued credential ids
-- and the revocation list consulted by POST /credentials/verify.

-- migrate:up
CREATE TABLE IF NOT EXISTS subscription_credentials (
    jti UUID PRIMARY KEY,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    -- Pairwise pseudonym of the subscriber wallet; the raw address is never stored here
    subject_hash VARCHAR(64) NOT NULL,
    plan_tier VARCHAR(255) NOT NULL,
    valid_until TIMESTAMP WITH TIME ZONE NOT NULL,
    issued_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS subscription_credentials_subscription_idx ON subscription_credentials (subscription_id);

CREATE TABLE IF NOT EXISTS credential_revocations (
    jti UUID PRIMARY KEY,
    subscription_id UUID,
    reason VARCHAR(200) NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE subscription_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE subscription_credentials, credential_revocations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_credentials, credential_revocations TO service_role;

-- migrate:down
DROP TABLE IF EXISTS credential_revocations;
DROP TABLE IF EXISTS subscription_credentials;
