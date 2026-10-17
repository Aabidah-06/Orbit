import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

let db;
const merchant = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
const plan = 'e0b8e99b-5136-4d1d-9351-91a5db4fb056';
const subscriber = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';
const otherSubscriber = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b33';
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
  await db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  await db.query('INSERT INTO merchants (id, wallet_address, name) VALUES ($1, $2, $3)', [merchant, 'merchant-wallet', 'Merchant']);
  await db.query('INSERT INTO plans (id, merchant_id, name, usdc_amount, interval_seconds) VALUES ($1, $2, $3, 10000000, 86400)', [plan, merchant, 'Daily']);
  await db.query(`INSERT INTO subscriptions (id, plan_id, customer_wallet_address, status, next_billing_date)
    VALUES ($1, $2, 'customer', 'past_due', NOW() - INTERVAL '2 days'), ($3, $2, 'other', 'active', NOW())`, [subscriber, plan, otherSubscriber]);
}, 30000);
afterAll(async () => { await db?.close(); });

const event = (id, ledger) => ({ id, ledger_sequence: ledger, transaction_hash: `tx-${id}`, contract_id: 'contract',
  event_name: 'funds_pulled', merchant_address: 'merchant-wallet', topics: [], value: ['10000000'], closed_at: '2026-10-01T00:00:00Z' });
const commit = (expected, last, events) => db.query('SELECT commit_ledger_batch($1, $2, $3, $4::JSONB)', ['network:contract', expected, last, JSON.stringify(events)]);

describe('PostgreSQL atomic checkpoint and billing transactions', () => {
  it('rolls back the entire first batch and checkpoint when any event cannot be persisted', async () => {
    const invalid = { ...event('bad', 12), closed_at: 'invalid date' };
    await expect(commit(10, 12, [event('a', 11), invalid])).rejects.toThrow();
    expect((await db.query('SELECT * FROM ledger_checkpoints')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM contract_events')).rows).toHaveLength(0);
    await commit(10, 12, [event('a', 11), event('b', 12)]);
    expect((await db.query('SELECT last_processed_ledger_sequence FROM ledger_checkpoints')).rows[0].last_processed_ledger_sequence).toBe(12);
    expect((await db.query('SELECT * FROM contract_events')).rows).toHaveLength(2);
  });

  it('rejects stale worker commits and out-of-range events without corrupting the checkpoint', async () => {
    await expect(commit(10, 15, [event('stale', 13)])).rejects.toThrow('Checkpoint changed');
    await expect(commit(12, 15, [event('outside', 16)])).rejects.toThrow('outside checkpoint');
    expect((await db.query('SELECT * FROM contract_events')).rows).toHaveLength(2);
    await commit(12, 15, []);
    expect((await db.query('SELECT last_processed_ledger_sequence FROM ledger_checkpoints')).rows[0].last_processed_ledger_sequence).toBe(15);
  });

  it('protects backend functions from anonymous execution', async () => {
    const result = await db.query(`SELECT has_function_privilege('anon', 'commit_ledger_batch(text,bigint,bigint,jsonb)', 'EXECUTE') AS checkpoint,
      has_function_privilege('authenticated', 'waive_subscription_interval(uuid,uuid,text)', 'EXECUTE') AS waiver,
      has_function_privilege('anon', 'merchant_analytics(uuid,timestamptz,timestamptz)', 'EXECUTE') AS analytics`);
    expect(result.rows[0]).toEqual({ checkpoint: false, waiver: false, analytics: false });
  });

  it('waives one interval with an audit record, prevents double-waiving, and scopes ownership', async () => {
    const wrong = await db.query('SELECT waive_subscription_interval($1, $2, $3) AS subscription', [subscriber, '00000000-0000-4000-8000-000000000000', 'attacker']);
    expect(wrong.rows[0].subscription).toBeNull();
    const result = await db.query('SELECT waive_subscription_interval($1, $2, $3) AS subscription', [subscriber, merchant, 'merchant-wallet']);
    expect(result.rows[0].subscription.status).toBe('active');
    expect(new Date(result.rows[0].subscription.next_billing_date).getTime()).toBeGreaterThan(Date.now() + 86300000);
    const again = await db.query('SELECT waive_subscription_interval($1, $2, $3) AS subscription', [subscriber, merchant, 'merchant-wallet']);
    expect(again.rows[0].subscription).toBeNull();
    expect((await db.query("SELECT * FROM audit_logs WHERE action = 'subscription.interval_waived'")).rows).toHaveLength(1);
  });

  it('batches independent nested payment pages and excludes other merchants in SQL', async () => {
    for (let index = 0; index < 4; index++) await db.query(`INSERT INTO audit_logs
      (merchant_id, action, resource_type, resource_id, changes_after, created_at)
      VALUES ($1, 'pull.execute', 'subscription', $2, '{"amount":"10000000"}', $3)`,
    [merchant, index < 2 ? subscriber : otherSubscriber, `2026-10-0${index + 1}T00:00:00Z`]);
    const result = await db.query('SELECT * FROM graphql_subscription_payments($1, $2::JSONB)', [merchant,
      JSON.stringify([{ id: subscriber, limit: 1, offset: 1 }, { id: otherSubscriber, limit: 2, offset: 0 }])]);
    expect(result.rows.filter((row) => row.request_index === 0)).toHaveLength(1);
    expect(result.rows.filter((row) => row.request_index === 1)).toHaveLength(2);
    const denied = await db.query('SELECT * FROM graphql_subscription_payments($1, $2::JSONB)', [
      '00000000-0000-4000-8000-000000000000', JSON.stringify([{ id: subscriber, limit: 50, offset: 0 }])]);
    expect(denied.rows).toHaveLength(0);
    const analytics = await db.query("SELECT merchant_analytics($1, '2026-10-02', '2026-10-04') AS result", [merchant]);
    expect(analytics.rows[0].result).toMatchObject({ settledPayments: 2, settledAmount: '20000000', activeSubscribers: 2 });
  });
  it('reconciles an uncertain transaction atomically and prevents double settlement or waiver', async () => {
    await db.query(`UPDATE subscriptions SET status = 'past_due', last_failure =
      '{"code":"rpc_timeout","transaction_hash":"pending-hash"}' WHERE id = $1`, [subscriber]);
    const waiver = await db.query('SELECT waive_subscription_interval($1,$2,$3) AS subscription', [subscriber, merchant, 'merchant-wallet']);
    expect(waiver.rows[0].subscription).toBeNull();
    const reconcile = () => db.query("SELECT resolve_pending_pull($1,$2,'pending-hash',true,'2026-10-10') AS subscription", [subscriber, merchant]);
    const result = await reconcile();
    expect(result.rows[0].subscription.status).toBe('active');
    expect(result.rows[0].subscription.last_failure).toBeNull();
    expect((await reconcile()).rows[0].subscription).toBeNull();
    expect((await db.query("SELECT * FROM audit_logs WHERE changes_after->>'txHash' = 'pending-hash'")).rows).toHaveLength(1);
  });
});
