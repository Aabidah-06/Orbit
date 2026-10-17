-- Batches nested payment pages in one query. Payment amounts are raw USDC units.
CREATE OR REPLACE FUNCTION graphql_subscription_payments(p_merchant_id UUID, p_requests JSONB)
RETURNS TABLE(request_index INTEGER, payment JSONB) LANGUAGE sql STABLE AS $$
    SELECT (r.ordinality - 1)::INTEGER, to_jsonb(a)
    FROM jsonb_array_elements(p_requests) WITH ORDINALITY r(request, ordinality)
    CROSS JOIN LATERAL (
        SELECT * FROM audit_logs a WHERE a.merchant_id = p_merchant_id
          AND a.action = 'pull.execute' AND a.resource_type = 'subscription'
          AND a.resource_id = r.request->>'id'
        ORDER BY a.created_at DESC, a.id
        LIMIT LEAST(GREATEST((r.request->>'limit')::INTEGER, 1), 100)
        OFFSET LEAST(GREATEST((r.request->>'offset')::INTEGER, 0), 100000)
    ) a;
$$;

CREATE OR REPLACE FUNCTION merchant_analytics(p_merchant_id UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'activeSubscribers', (SELECT COUNT(*) FROM subscriptions s JOIN plans p ON p.id = s.plan_id
            WHERE p.merchant_id = p_merchant_id AND s.status = 'active'),
        'settledPayments', COUNT(*),
        'settledAmount', COALESCE(SUM((changes_after->>'amount')::NUMERIC), 0)::TEXT
    ) FROM audit_logs WHERE merchant_id = p_merchant_id AND action = 'pull.execute'
        AND created_at >= p_from AND created_at < p_to;
$$;
REVOKE EXECUTE ON FUNCTION graphql_subscription_payments(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION merchant_analytics(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION graphql_subscription_payments(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION merchant_analytics(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
