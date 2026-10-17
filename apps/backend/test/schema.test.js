import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Database Schema & Row Level Security (RLS) Policies', () => {
  const schemaPath = path.resolve(__dirname, '../schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  it('enables Row Level Security on all core tables', () => {
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+merchants\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+plans\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+subscriptions\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
  });

  it('contains no open or public INSERT policies', () => {
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*FOR\s+INSERT/i);
  });

  it('contains no open or public UPDATE policies', () => {
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*FOR\s+UPDATE/i);
  });

  it('contains no open or public DELETE policies', () => {
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*FOR\s+DELETE/i);
  });

  it('enforces default-deny on subscriptions by defining no policies for subscriptions', () => {
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*ON\s+subscriptions\b/i);
  });

  it('allows public read (SELECT) only on plans and merchants for checkout', () => {
    const selectPolicies = schemaSql.match(/CREATE\s+POLICY[\s\S]*?ON\s+(\w+)\s+FOR\s+SELECT/gi) || [];
    expect(selectPolicies.length).toBe(2);

    expect(schemaSql).toMatch(/CREATE\s+POLICY[\s\S]*?ON\s+merchants\s+FOR\s+SELECT/i);
    expect(schemaSql).toMatch(/CREATE\s+POLICY[\s\S]*?ON\s+plans\s+FOR\s+SELECT/i);
  });

  it('defines merchant-scoped idempotency keys with a TTL', () => {
    const table = schemaSql.match(/CREATE\s+TABLE\s+idempotency_keys\s*\(([\s\S]*?)\n\);/i)?.[1];
    expect(table).toBeDefined();
    expect(table).toMatch(/merchant_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+merchants\(id\)\s+ON\s+DELETE\s+CASCADE/i);
    expect(table).toMatch(/request_hash\s+VARCHAR\(64\)\s+NOT\s+NULL/i);
    expect(table).toMatch(/expires_at\s+TIMESTAMP\s+WITH\s+TIME\s+ZONE\s+NOT\s+NULL/i);
    expect(table).toMatch(/UNIQUE\s*\(\s*merchant_id\s*,\s*key\s*\)/i);
  });

  it('defines subscriptions table with dunning schedule columns', () => {
    const table = schemaSql.match(/CREATE\s+TABLE\s+subscriptions\s*\(([\s\S]*?)\n\);/i)?.[1];
    expect(table).toBeDefined();
    expect(table).toMatch(/retry_count\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
    expect(table).toMatch(/next_dunning_retry_at\s+TIMESTAMP\s+WITH\s+TIME\s+ZONE/i);
    expect(table).toMatch(/dunning_status\s+VARCHAR\(50\)/i);
  });

  it('defines audit_logs table for financial mutations and administrative actions', () => {
    const table = schemaSql.match(/CREATE\s+TABLE\s+audit_logs\s*\(([\s\S]*?)\n\);/i)?.[1];
    expect(table).toBeDefined();
    expect(table).toMatch(/merchant_id\s+UUID\s+REFERENCES\s+merchants\(id\)\s+ON\s+DELETE\s+CASCADE/i);
    expect(table).toMatch(/actor_address\s+VARCHAR\(255\)/i);
    expect(table).toMatch(/action\s+VARCHAR\(100\)\s+NOT\s+NULL/i);
    expect(table).toMatch(/resource_type\s+VARCHAR\(100\)\s+NOT\s+NULL/i);
    expect(table).toMatch(/resource_id\s+VARCHAR\(255\)/i);
    expect(table).toMatch(/ip_address\s+VARCHAR\(100\)/i);
    expect(table).toMatch(/changes_before\s+JSONB/i);
    expect(table).toMatch(/changes_after\s+JSONB/i);
  });

  it('defines webhooks and webhook_deliveries tables', () => {
    const webhooksTable = schemaSql.match(/CREATE\s+TABLE\s+webhooks\s*\(([\s\S]*?)\n\);/i)?.[1];
    expect(webhooksTable).toBeDefined();
    expect(webhooksTable).toMatch(/url\s+TEXT\s+NOT\s+NULL/i);
    expect(webhooksTable).toMatch(/signing_secret\s+VARCHAR\(255\)\s+NOT\s+NULL/i);
    expect(webhooksTable).toMatch(/events\s+JSONB\s+NOT\s+NULL/i);

    const deliveriesTable = schemaSql.match(/CREATE\s+TABLE\s+webhook_deliveries\s*\(([\s\S]*?)\n\);/i)?.[1];
    expect(deliveriesTable).toBeDefined();
    expect(deliveriesTable).toMatch(/event_type\s+VARCHAR\(100\)\s+NOT\s+NULL/i);
    expect(deliveriesTable).toMatch(/payload\s+JSONB\s+NOT\s+NULL/i);
    expect(deliveriesTable).toMatch(/response_status\s+INTEGER/i);
    expect(deliveriesTable).toMatch(/attempt_count\s+INTEGER/i);
  });

  it('keeps idempotency, lock, audit, and webhook tables private to the backend', () => {
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+idempotency_keys\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+billing_locks\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+audit_logs\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+webhooks\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+webhook_deliveries\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*ON\s+(idempotency_keys|billing_locks|audit_logs|webhooks|webhook_deliveries)\b/i);
    for (const fn of ['claim_idempotency_key', 'acquire_billing_lock', 'release_billing_lock']) {
      expect(schemaSql).toMatch(new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${fn}\\(`, 'i'));
    }
  });

  it('keeps reconciliation_state private to the backend', () => {
    const table = schemaSql.match(/CREATE\s+TABLE\s+reconciliation_state\s*\(([\s\S]*?)\n\);/i)?.[1];
    expect(table).toBeDefined();
    expect(table).toMatch(/event_cursor\s+TEXT/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+reconciliation_state\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*ON\s+reconciliation_state\b/i);
  });

  it('defines api_keys storing only a SHA-256 hash of each key', () => {
    const table = schemaSql.match(/CREATE\s+TABLE\s+api_keys\s*\(([\s\S]*?)\n\);/i)?.[1];
    expect(table).toBeDefined();
    expect(table).toMatch(/id\s+UUID\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i);
    expect(table).toMatch(/merchant_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+merchants\(id\)\s+ON\s+DELETE\s+CASCADE/i);
    expect(table).toMatch(/name\s+VARCHAR\(255\)\s+NOT\s+NULL/i);
    expect(table).toMatch(/key_prefix\s+VARCHAR\(16\)\s+NOT\s+NULL/i);
    expect(table).toMatch(/key_hash\s+VARCHAR\(64\)\s+NOT\s+NULL/i);
    expect(table).toMatch(/environment\s+VARCHAR\(20\)\s+NOT\s+NULL\s+CHECK\s*\(\s*environment\s+IN\s*\('live',\s*'test'\)\s*\)/i);
    expect(table).toMatch(/last_used_at\s+TIMESTAMP\s+WITH\s+TIME\s+ZONE/i);
    expect(table).toMatch(/created_at\s+TIMESTAMP\s+WITH\s+TIME\s+ZONE\s+DEFAULT\s+NOW\(\)/i);
    expect(table).toMatch(/revoked_at\s+TIMESTAMP\s+WITH\s+TIME\s+ZONE/i);
    expect(table).not.toMatch(/\bsecret\b|raw_key/i);
    expect(schemaSql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+\w+\s+ON\s+api_keys\s*\(\s*key_hash\s*\)/i);
  });

  it('keeps api_keys private to the backend', () => {
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+api_keys\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*ON\s+api_keys\b/i);
  });

  it('tracks relayer fee usage per merchant per day, private to the backend', () => {
    const table = schemaSql.match(/CREATE\s+TABLE\s+relayer_fee_usage\s*\(([\s\S]*?)\n\);/i)?.[1];
    expect(table).toBeDefined();
    expect(table).toMatch(/merchant_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+merchants\(id\)\s+ON\s+DELETE\s+CASCADE/i);
    expect(table).toMatch(/fee_stroops\s+BIGINT\s+NOT\s+NULL/i);
    expect(table).toMatch(/PRIMARY\s+KEY\s*\(\s*merchant_id\s*,\s*usage_date\s*\)/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+relayer_fee_usage\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*ON\s+relayer_fee_usage\b/i);
    for (const fn of ['reserve_relayer_fee', 'adjust_relayer_fee']) {
      expect(schemaSql).toMatch(new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${fn}\\(`, 'i'));
    }
  });

  it('contains no leftover merge conflict markers', () => {
    expect(schemaSql).not.toMatch(/^(<{7}|={7}|>{7})( |$)/m);
  });
});
