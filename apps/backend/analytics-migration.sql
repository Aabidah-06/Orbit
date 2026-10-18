-- Issue #77. Requires the verified payment_transactions table from #76.
-- Apply in a staging Supabase project after the #76 migration.
CREATE TABLE IF NOT EXISTS merchant_analytics_challenges (
    id UUID PRIMARY KEY,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS merchant_analytics_challenges_expiry_idx
    ON merchant_analytics_challenges(expires_at);
ALTER TABLE merchant_analytics_challenges ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies. Access only with backend service_role.

CREATE OR REPLACE FUNCTION merchant_analytics_overview(
    p_merchant_id UUID, p_start TIMESTAMPTZ, p_end TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH merchant_subs AS (
    SELECT s.status, s.created_at, p.currency, p.usdc_amount, p.interval_seconds
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
     WHERE p.merchant_id = p_merchant_id
  ),
  subscriber_totals AS (
    SELECT
      count(*) FILTER (WHERE status = 'active')::integer AS active_count,
      count(*) FILTER (WHERE created_at >= p_start AND created_at < p_end)::integer AS new_count,
      count(*) FILTER (WHERE created_at >= p_start - (p_end - p_start) AND created_at < p_start)::integer AS previous_count,
      COALESCE(sum(CASE
          WHEN status = 'active' AND (currency IS NULL OR currency = 'USDC')
            AND interval_seconds > 0 AND usdc_amount >= 0
          THEN usdc_amount::numeric * 2629800 / interval_seconds
          ELSE 0::numeric END), 0::numeric) AS mrr_units,
      count(*) FILTER (WHERE status = 'active' AND
          (currency IS DISTINCT FROM 'USDC' AND currency IS NOT NULL
           OR usdc_amount IS NULL OR interval_seconds IS NULL OR interval_seconds <= 0))::integer AS excluded_count
    FROM merchant_subs
  ),
  settled AS (
    SELECT settled_at, amount_usdc_units::numeric AS amount
      FROM payment_transactions
     WHERE merchant_id = p_merchant_id AND status = 'settled'
  ),
  revenue_totals AS (
    SELECT COALESCE(sum(amount), 0::numeric) AS all_time,
           COALESCE(sum(amount) FILTER (WHERE settled_at >= p_start AND settled_at < p_end), 0::numeric) AS in_range
    FROM settled
  ),
  grouped AS (
    SELECT (settled_at AT TIME ZONE 'UTC')::date AS day,
           sum(amount) AS units
      FROM settled
     WHERE settled_at >= p_start AND settled_at < p_end
     GROUP BY (settled_at AT TIME ZONE 'UTC')::date
  )
  SELECT jsonb_build_object(
      'active_subscribers', st.active_count,
      'new_subscribers', st.new_count,
      'previous_new_subscribers', st.previous_count,
      'mrr_usdc_units', round(st.mrr_units)::text,
      'mrr_incomplete', (st.excluded_count > 0),
      'settled_volume_usdc_units', rt.all_time::text,
      'period_settled_usdc_units', rt.in_range::text,
      'points', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'date', g.day::text, 'amount_usdc_units', g.units::text) ORDER BY g.day) FROM grouped g), '[]'::jsonb)
  )
  FROM subscriber_totals st CROSS JOIN revenue_totals rt;
$$;
REVOKE ALL ON FUNCTION merchant_analytics_overview(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merchant_analytics_overview(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
