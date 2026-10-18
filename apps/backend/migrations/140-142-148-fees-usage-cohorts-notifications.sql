-- Exact metered usage, history-correct retention, and merchant notification templates.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS notification_email TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS usage_metric VARCHAR(64);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS usage_limit BIGINT CHECK (usage_limit IS NULL OR usage_limit >= 0);

CREATE TABLE IF NOT EXISTS usage_rollup_windows (window_key TEXT PRIMARY KEY, merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE, committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS usage_rollups (
 merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE, subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
 metric VARCHAR(64) NOT NULL, hour_start TIMESTAMPTZ NOT NULL, quantity BIGINT NOT NULL DEFAULT 0 CHECK(quantity>=0),
 event_count BIGINT NOT NULL DEFAULT 0 CHECK(event_count>=0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(merchant_id,subscription_id,metric,hour_start));
ALTER TABLE usage_rollup_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_rollups ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION commit_usage_window(p_window_key TEXT,p_merchant_id UUID,p_subscription_id UUID,p_metric TEXT,p_window_start TIMESTAMPTZ,p_quantity BIGINT,p_event_count BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 INSERT INTO usage_rollup_windows(window_key,merchant_id) VALUES(p_window_key,p_merchant_id) ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 IF NOT EXISTS(SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=p_subscription_id AND p.merchant_id=p_merchant_id) THEN RAISE EXCEPTION 'subscription does not belong to merchant'; END IF;
 INSERT INTO usage_rollups VALUES(p_merchant_id,p_subscription_id,p_metric,date_trunc('hour',p_window_start),p_quantity,p_event_count,NOW())
 ON CONFLICT(merchant_id,subscription_id,metric,hour_start) DO UPDATE SET quantity=usage_rollups.quantity+EXCLUDED.quantity,event_count=usage_rollups.event_count+EXCLUDED.event_count,updated_at=NOW();
 RETURN TRUE;
END $$;
REVOKE EXECUTE ON FUNCTION commit_usage_window(TEXT,UUID,UUID,TEXT,TIMESTAMPTZ,BIGINT,BIGINT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION commit_usage_window(TEXT,UUID,UUID,TEXT,TIMESTAMPTZ,BIGINT,BIGINT) TO service_role;

CREATE TABLE IF NOT EXISTS subscription_status_history(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,status VARCHAR(50) NOT NULL,changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS subscription_status_history_lookup_idx ON subscription_status_history(subscription_id,changed_at);
ALTER TABLE subscription_status_history ENABLE ROW LEVEL SECURITY;
INSERT INTO subscription_status_history(subscription_id,status,changed_at) SELECT id,'active',created_at FROM subscriptions s WHERE NOT EXISTS(SELECT 1 FROM subscription_status_history h WHERE h.subscription_id=s.id);
-- Do not invent historical cancellation dates: legacy current state starts now.
INSERT INTO subscription_status_history(subscription_id,status,changed_at) SELECT id,status,NOW() FROM subscriptions s WHERE status<>'active' AND NOT EXISTS(SELECT 1 FROM subscription_status_history h WHERE h.subscription_id=s.id AND h.status=s.status);
CREATE OR REPLACE FUNCTION record_subscription_status() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN INSERT INTO subscription_status_history(subscription_id,status,changed_at) VALUES(NEW.id,NEW.status,CASE WHEN TG_OP='INSERT' THEN COALESCE(NEW.created_at,NOW()) ELSE NOW() END); END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS subscription_status_history_trigger ON subscriptions;
CREATE TRIGGER subscription_status_history_trigger AFTER INSERT OR UPDATE OF status ON subscriptions FOR EACH ROW EXECUTE FUNCTION record_subscription_status();

CREATE TABLE IF NOT EXISTS notification_templates(merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,type VARCHAR(48) NOT NULL CHECK(type IN('payment_receipt','subscription_activated','payment_failed','subscription_cancelled')),subject VARCHAR(200) NOT NULL,markdown TEXT NOT NULL CHECK(length(markdown)<=20000),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(merchant_id,type));
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
