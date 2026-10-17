ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_failure JSONB;

-- The audit record and billing-date advancement either both commit or both roll back.
CREATE OR REPLACE FUNCTION waive_subscription_interval(p_subscription_id UUID, p_merchant_id UUID, p_actor_address TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_sub subscriptions; v_interval BIGINT; v_before JSONB;
BEGIN
    SELECT s.* INTO v_sub FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.id = p_subscription_id AND p.merchant_id = p_merchant_id FOR UPDATE OF s;
    IF NOT FOUND OR v_sub.status <> 'past_due' THEN RETURN NULL; END IF;
    IF v_sub.last_failure->>'code' = 'rpc_timeout' AND v_sub.last_failure->>'transaction_hash' IS NOT NULL THEN RETURN NULL; END IF;
    SELECT interval_seconds INTO v_interval FROM plans WHERE id = v_sub.plan_id;
    v_before := to_jsonb(v_sub);
    UPDATE subscriptions SET status = 'active', retry_count = 0,
        dunning_status = NULL, next_dunning_retry_at = NULL, last_failure = NULL,
        next_billing_date = GREATEST(next_billing_date, NOW()) + make_interval(secs => v_interval::DOUBLE PRECISION)
        WHERE id = p_subscription_id RETURNING * INTO v_sub;
    INSERT INTO audit_logs (merchant_id, actor_address, action, resource_type, resource_id, changes_before, changes_after)
        VALUES (p_merchant_id, p_actor_address, 'subscription.interval_waived', 'subscription',
            p_subscription_id::TEXT, v_before, to_jsonb(v_sub));
    RETURN to_jsonb(v_sub);
END;
$$;
REVOKE EXECUTE ON FUNCTION waive_subscription_interval(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION waive_subscription_interval(UUID, UUID, TEXT) TO service_role;

-- Reconcile an RPC timeout exactly once, using only the hash previously stored
-- by the backend. The HTTP route verifies its outcome with Soroban RPC first.
CREATE OR REPLACE FUNCTION resolve_pending_pull(p_subscription_id UUID, p_merchant_id UUID,
    p_transaction_hash TEXT, p_succeeded BOOLEAN, p_settled_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_sub subscriptions; v_plan plans; v_before JSONB;
BEGIN
    SELECT s.* INTO v_sub FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.id = p_subscription_id AND p.merchant_id = p_merchant_id FOR UPDATE OF s;
    IF NOT FOUND OR v_sub.last_failure->>'code' IS DISTINCT FROM 'rpc_timeout'
        OR v_sub.last_failure->>'transaction_hash' IS DISTINCT FROM p_transaction_hash THEN RETURN NULL; END IF;
    v_before := to_jsonb(v_sub);
    SELECT * INTO v_plan FROM plans WHERE id = v_sub.plan_id;
    IF p_succeeded THEN
        UPDATE subscriptions SET status = 'active', retry_count = 0, dunning_status = NULL,
            next_dunning_retry_at = NULL, last_failure = NULL,
            next_billing_date = p_settled_at + make_interval(secs => v_plan.interval_seconds::DOUBLE PRECISION)
            WHERE id = p_subscription_id RETURNING * INTO v_sub;
        INSERT INTO audit_logs (merchant_id, actor_address, action, resource_type, resource_id, changes_before, changes_after)
            VALUES (p_merchant_id, NULL, 'pull.execute', 'subscription', p_subscription_id::TEXT,
                v_before, jsonb_build_object('txHash', p_transaction_hash, 'amount', v_plan.usdc_amount::TEXT,
                    'status', v_sub.status, 'next_billing_date', v_sub.next_billing_date));
    ELSE
        UPDATE subscriptions SET last_failure = jsonb_build_object('code', 'unknown',
            'message', 'The previously pending transaction failed on-chain. A fresh retry can now be prepared.',
            'transaction_hash', p_transaction_hash, 'occurred_at', NOW())
            WHERE id = p_subscription_id RETURNING * INTO v_sub;
    END IF;
    RETURN to_jsonb(v_sub);
END;
$$;
REVOKE EXECUTE ON FUNCTION resolve_pending_pull(UUID, UUID, TEXT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_pending_pull(UUID, UUID, TEXT, BOOLEAN, TIMESTAMPTZ) TO service_role;
