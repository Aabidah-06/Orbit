-- Issue #75: append after existing schema.sql (fiat plan columns are already defined).
-- Application coupon values are in the plan's denomination:
-- USDC plans use raw 7-decimal token units; USD/EUR plans use major fiat units.
CREATE TABLE IF NOT EXISTS coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    code VARCHAR(32) NOT NULL CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
    discount_type VARCHAR(16) NOT NULL CHECK (discount_type IN ('percent', 'amount')),
    discount_value NUMERIC NOT NULL CHECK (discount_value > 0),
    duration_months INTEGER NOT NULL DEFAULT 1 CHECK (duration_months BETWEEN 1 AND 120),
    max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
    redemptions_count INTEGER NOT NULL DEFAULT 0 CHECK (redemptions_count >= 0),
    expires_at TIMESTAMP WITH TIME ZONE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT coupons_percent_cap CHECK (discount_type <> 'percent' OR discount_value <= 99),
    CONSTRAINT coupons_limit_floor CHECK (max_redemptions IS NULL OR max_redemptions >= redemptions_count)
);
CREATE UNIQUE INDEX IF NOT EXISTS coupons_merchant_code_idx ON coupons (merchant_id, code);
CREATE INDEX IF NOT EXISTS coupons_expiry_idx ON coupons (expires_at);
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
-- No public RLS policies: merchant access is enforced through backend API keys.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promotion_original_amount NUMERIC;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promotion_discounted_amount NUMERIC;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promotion_currency VARCHAR(8);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promotion_duration_months INTEGER;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promotion_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promotion_onchain_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Atomic redemption: coupon is locked for the full transaction, and insertion
-- and redemption-count increment roll back together on duplicate subscription.
-- Call through the backend using the Supabase service role only.
CREATE OR REPLACE FUNCTION redeem_coupon_subscription(
    p_plan_id UUID,
    p_customer_wallet_address VARCHAR,
    p_metadata JSONB,
    p_code VARCHAR,
    p_quoted_rate NUMERIC DEFAULT NULL
) RETURNS subscriptions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_plan plans%ROWTYPE;
    v_coupon coupons%ROWTYPE;
    v_original NUMERIC;
    v_discounted NUMERIC;
    v_currency VARCHAR(8);
    v_sub subscriptions%ROWTYPE;
BEGIN
    SELECT * INTO v_plan FROM plans WHERE id = p_plan_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Plan not found' USING ERRCODE = 'P7503';
    END IF;
    -- Concurrent redemptions serialize on the coupon row.
    SELECT * INTO v_coupon FROM coupons
      WHERE merchant_id = v_plan.merchant_id AND code = UPPER(TRIM(p_code))
      FOR UPDATE;
    IF NOT FOUND OR NOT v_coupon.active OR
       (v_coupon.expires_at IS NOT NULL AND v_coupon.expires_at <= NOW()) THEN
        RAISE EXCEPTION 'Coupon invalid or expired' USING ERRCODE = 'P7501';
    END IF;
    IF v_coupon.max_redemptions IS NOT NULL AND
       v_coupon.redemptions_count >= v_coupon.max_redemptions THEN
        RAISE EXCEPTION 'Coupon redemption limit reached' USING ERRCODE = 'P7502';
    END IF;
    v_currency := COALESCE(v_plan.currency, 'USDC');
    IF v_currency = 'USDC' THEN
        v_original := v_plan.usdc_amount;
    ELSIF v_currency IN ('USD', 'EUR') THEN
        v_original := v_plan.price_amount;
    ELSE
        RAISE EXCEPTION 'Unsupported plan currency' USING ERRCODE = 'P7501';
    END IF;
    IF v_original IS NULL OR v_original <= 0 THEN
        RAISE EXCEPTION 'Invalid plan price' USING ERRCODE = 'P7501';
    END IF;
    v_discounted := CASE WHEN v_coupon.discount_type = 'percent' THEN
        v_original * (100 - v_coupon.discount_value) / 100
      ELSE v_original - v_coupon.discount_value END;
    v_discounted := TRUNC(v_discounted, CASE WHEN v_currency = 'USDC' THEN 0 ELSE 2 END);
    IF v_discounted <= 0 OR v_discounted >= v_original THEN
        RAISE EXCEPTION 'Discount is not valid for this plan price' USING ERRCODE = 'P7501';
    END IF;
    -- No on-chain authorization has been verified at checkout yet. The legacy
    -- contract uses a fixed vault amount, so never label a coupon checkout as
    -- an activated discounted subscription without confirming compatible terms.
    INSERT INTO subscriptions (
        plan_id, customer_wallet_address, metadata, next_billing_date, status,
        quoted_rate, coupon_id, promotion_original_amount, promotion_discounted_amount,
        promotion_currency, promotion_duration_months, promotion_expires_at,
        promotion_onchain_verified
    ) VALUES (
        p_plan_id, p_customer_wallet_address, COALESCE(p_metadata, '{}'::jsonb), NOW(), 'pending_promo',
        p_quoted_rate, v_coupon.id, v_original, v_discounted,
        v_currency, v_coupon.duration_months, NOW() + make_interval(months => v_coupon.duration_months),
        FALSE
    ) RETURNING * INTO v_sub;
    UPDATE coupons SET redemptions_count = redemptions_count + 1 WHERE id = v_coupon.id;
    RETURN v_sub;
END;
$$;
REVOKE ALL ON FUNCTION redeem_coupon_subscription(UUID, VARCHAR, JSONB, VARCHAR, NUMERIC)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION redeem_coupon_subscription(UUID, VARCHAR, JSONB, VARCHAR, NUMERIC)
    TO service_role;
