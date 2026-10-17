-- Issue #74: backend-only customer portal wallet sign-in and session revocation.
-- Execute with a DB migration tool in environments with existing deployments.
CREATE TABLE IF NOT EXISTS customer_portal_challenges (
    id UUID PRIMARY KEY,
    wallet_address VARCHAR(56) NOT NULL,
    message TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS portal_challenges_expiry_idx
    ON customer_portal_challenges (expires_at);
CREATE TABLE IF NOT EXISTS customer_portal_sessions (
    id UUID PRIMARY KEY,
    wallet_address VARCHAR(56) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS portal_sessions_wallet_idx
    ON customer_portal_sessions (wallet_address, expires_at);

-- A receipt is only formed from a confirmed pull.execute audit event.
-- The wallet predicate is applied in the view before pagination by backend queries.
-- Do not claim an exact amount: old audit entries do not contain a verified amount.
CREATE OR REPLACE VIEW customer_portal_receipts WITH (security_invoker = true) AS
SELECT a.id, s.id AS subscription_id, s.customer_wallet_address,
       p.name AS plan_name, m.name AS merchant_name,
       a.created_at, a.changes_after->>'txHash' AS tx_hash
FROM audit_logs AS a
JOIN subscriptions AS s ON a.resource_id = s.id::text
JOIN plans AS p ON s.plan_id = p.id
JOIN merchants AS m ON p.merchant_id = m.id
WHERE a.action = 'pull.execute'
  AND a.changes_after->>'txHash' IS NOT NULL;

ALTER TABLE customer_portal_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_portal_sessions ENABLE ROW LEVEL SECURITY;
-- Backend service-role only: the view must never bypass subscription RLS
-- for anon users or leak transaction history through a public endpoint.
REVOKE ALL ON TABLE customer_portal_challenges FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE customer_portal_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE customer_portal_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_portal_challenges TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_portal_sessions TO service_role;
GRANT SELECT ON customer_portal_receipts TO service_role;
-- Optional housekeeping job: periodically DELETE expired rows.
