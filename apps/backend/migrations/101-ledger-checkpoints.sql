-- Apply once to existing Supabase projects before enabling the indexer.
CREATE TABLE IF NOT EXISTS ledger_checkpoints (
    stream_id TEXT PRIMARY KEY,
    last_processed_ledger_sequence BIGINT NOT NULL CHECK (last_processed_ledger_sequence >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS contract_events (
    stream_id TEXT NOT NULL REFERENCES ledger_checkpoints(stream_id),
    id TEXT NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    transaction_hash TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    merchant_address TEXT,
    topics JSONB NOT NULL,
    value JSONB NOT NULL,
    closed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (stream_id, id)
);
CREATE INDEX IF NOT EXISTS contract_events_merchant_ledger_idx ON contract_events (merchant_address, ledger_sequence);
ALTER TABLE ledger_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION commit_ledger_batch(
    p_stream_id TEXT, p_expected_sequence BIGINT, p_last_sequence BIGINT, p_events JSONB
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_saved BIGINT;
BEGIN
    IF p_expected_sequence < 0 OR p_last_sequence <= p_expected_sequence THEN
        RAISE EXCEPTION 'Invalid checkpoint range';
    END IF;
    INSERT INTO ledger_checkpoints (stream_id, last_processed_ledger_sequence)
        VALUES (p_stream_id, p_expected_sequence) ON CONFLICT DO NOTHING;
    SELECT last_processed_ledger_sequence INTO v_saved FROM ledger_checkpoints
        WHERE stream_id = p_stream_id FOR UPDATE;
    IF v_saved <> p_expected_sequence THEN
        RAISE EXCEPTION 'Checkpoint changed; reload before retrying';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_events) e
        WHERE (e->>'ledger_sequence')::BIGINT <= p_expected_sequence
           OR (e->>'ledger_sequence')::BIGINT > p_last_sequence) THEN
        RAISE EXCEPTION 'Event outside checkpoint range';
    END IF;
    INSERT INTO contract_events (stream_id, id, ledger_sequence, transaction_hash,
        contract_id, event_name, merchant_address, topics, value, closed_at)
    SELECT p_stream_id, e.id, e.ledger_sequence, e.transaction_hash, e.contract_id,
        e.event_name, e.merchant_address, e.topics, e.value, e.closed_at
    FROM jsonb_to_recordset(p_events) AS e(id TEXT, ledger_sequence BIGINT,
        transaction_hash TEXT, contract_id TEXT, event_name TEXT, merchant_address TEXT,
        topics JSONB, value JSONB, closed_at TIMESTAMPTZ)
    ON CONFLICT (stream_id, id) DO NOTHING;
    UPDATE ledger_checkpoints SET last_processed_ledger_sequence = p_last_sequence,
        updated_at = NOW() WHERE stream_id = p_stream_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION commit_ledger_batch(TEXT, BIGINT, BIGINT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION commit_ledger_batch(TEXT, BIGINT, BIGINT, JSONB) TO service_role;
