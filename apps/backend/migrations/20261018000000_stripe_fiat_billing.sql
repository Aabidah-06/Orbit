-- Stripe fiat billing bridge (#131): mirrors Stripe subscriptions and paid
-- invoices under the Orbit merchant so MRR and subscriber counts can be
-- reported across fiat and USDC rails.

-- migrate:up
-- Stripe Connect account linked to a merchant, used to route Connect events
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(255) UNIQUE;

-- Idempotency guard: one row per Stripe event id ever processed
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    event_id VARCHAR(255) PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('processing', 'processed', 'ignored')),
    outcome VARCHAR(50),
    received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS fiat_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    stripe_subscription_id VARCHAR(255) NOT NULL UNIQUE,
    stripe_customer_id VARCHAR(255),
    status VARCHAR(50) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    -- Monthly recurring revenue in the currency's minor units (e.g. cents)
    mrr_minor BIGINT NOT NULL DEFAULT 0 CHECK (mrr_minor >= 0),
    current_period_end TIMESTAMP WITH TIME ZONE,
    canceled_at TIMESTAMP WITH TIME ZONE,
    -- Stripe event.created of the newest applied event; older events are skipped
    last_event_created BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fiat_subscriptions_merchant_status_idx ON fiat_subscriptions (merchant_id, status);

CREATE TABLE IF NOT EXISTS fiat_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    stripe_invoice_id VARCHAR(255) NOT NULL UNIQUE,
    stripe_subscription_id VARCHAR(255),
    stripe_customer_id VARCHAR(255),
    amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
    currency VARCHAR(3) NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fiat_payments_merchant_paid_at_idx ON fiat_payments (merchant_id, paid_at DESC);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiat_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiat_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE stripe_webhook_events, fiat_subscriptions, fiat_payments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON stripe_webhook_events, fiat_subscriptions, fiat_payments TO service_role;

-- migrate:down
DROP TABLE IF EXISTS fiat_payments;
DROP TABLE IF EXISTS fiat_subscriptions;
DROP TABLE IF EXISTS stripe_webhook_events;
ALTER TABLE merchants DROP COLUMN IF EXISTS stripe_account_id;
