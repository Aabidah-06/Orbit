-- Branded payment links (#80).
-- migrate:up
CREATE TABLE IF NOT EXISTS payment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 140),
  cta_text text NOT NULL DEFAULT 'Pay with USDC',
  accent_color text NOT NULL DEFAULT '#111827' CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  redirect_url text,
  collect_email boolean NOT NULL DEFAULT false,
  collect_discord boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, plan_id)
);
CREATE INDEX IF NOT EXISTS payment_links_merchant_created_idx ON payment_links (merchant_id, created_at DESC);
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
-- Merchant access is enforced through authenticated API routes; no direct anonymous table writes.

REVOKE ALL ON payment_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_links TO service_role;

-- migrate:down
DROP TABLE IF EXISTS payment_links;
