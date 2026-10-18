import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { Keypair, Address, xdr, nativeToScVal } from '@stellar/stellar-sdk';
import app from '../index.js';
import { makeApiKey } from './helpers.js';
import {
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotIntegrityError,
  canonicalizeJson,
  computeSnapshotChecksum,
  verifySnapshotIntegrity,
  assertValidSnapshot,
  encryptSnapshot,
  decryptSnapshot,
  exportContractStateSnapshot,
  uploadSnapshotToColdStorage,
  restoreDatabaseFromSnapshot,
  createSnapshotExportWorker,
} from '../contract-state-snapshot.js';
import { runCliRecovery } from '../scripts/restore-from-ledger.js';

const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const MERCHANT_WALLET = Keypair.random().publicKey();
const SUBSCRIBER_1 = Keypair.random().publicKey();
const SUBSCRIBER_2 = Keypair.random().publicKey();
const TOKEN_ADDRESS = Keypair.random().publicKey();
const CONTRACT_ID = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

// Helper to build a real XDR base64 LedgerEntryData for a VaultKey -> VaultData entry
const buildXdrVaultLedgerEntry = ({ user, merchant, token, amount, intervalSeconds, lastPullTimestamp }) => {
  const contractScAddress = Address.fromString(CONTRACT_ID).toScAddress();
  const keyScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('merchant'),
      val: Address.fromString(merchant).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('user'),
      val: Address.fromString(user).toScVal(),
    }),
  ]);

  const valScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('amount_per_interval'),
      val: nativeToScVal(BigInt(amount), { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('grace_period_seconds'),
      val: nativeToScVal(BigInt(259200), { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('initial_timestamp'),
      val: nativeToScVal(BigInt(1700000000), { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('interval_seconds'),
      val: nativeToScVal(BigInt(intervalSeconds), { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('is_paused'),
      val: xdr.ScVal.scvBool(false),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('last_pull_timestamp'),
      val: nativeToScVal(BigInt(lastPullTimestamp), { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('payment_status'),
      val: nativeToScVal(0, { type: 'u32' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('pull_sequence'),
      val: nativeToScVal(BigInt(1), { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('token'),
      val: Address.fromString(token).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('trial_end_timestamp'),
      val: nativeToScVal(BigInt(0), { type: 'u64' }),
    }),
  ]);

  const contractData = new xdr.ContractDataEntry({
    ext: xdr.ExtensionPoint.v0(),
    contract: contractScAddress,
    key: keyScVal,
    durability:
      typeof xdr.ContractDataDurability.persistent === 'function'
        ? xdr.ContractDataDurability.persistent()
        : xdr.ContractDataDurability.persistent,
    val: valScVal,
  });

  return {
    val: xdr.LedgerEntryData.contractData(contractData).toXDR('base64'),
    liveUntilLedgerSeq: 950000,
  };
};

// In-memory Supabase mock that stores merchants, plans, subscriptions, snapshots, and audit_logs
const createInMemoryRecoverySupabase = (apiKeyRow = null) => {
  const tables = {
    merchants: [],
    plans: [],
    subscriptions: [],
    contract_state_snapshots: [],
    audit_logs: [],
    api_keys: apiKeyRow ? [apiKeyRow] : [],
  };

  const from = (tableName) => {
    const store = tables[tableName] || (tables[tableName] = []);

    const makeResultChain = (resultRowOrRows) => ({
      select: () => ({
        single: async () => ({ data: Array.isArray(resultRowOrRows) ? resultRowOrRows[0] : resultRowOrRows, error: null }),
        maybeSingle: async () => ({ data: Array.isArray(resultRowOrRows) ? resultRowOrRows[0] ?? null : resultRowOrRows, error: null }),
      }),
      then: (resolve) => resolve({ data: resultRowOrRows, error: null }),
    });

    return {
      select: () => {
        const filters = [];
        const query = {
          eq: (col, val) => {
            filters.push((r) => r[col] === val);
            return query;
          },
          is: (col, val) => {
            filters.push((r) => (r[col] ?? null) === val);
            return query;
          },
          order: () => query,
          limit: () => query,
          maybeSingle: async () => {
            const matched = store.filter((r) => filters.every((fn) => fn(r)));
            return { data: matched[0] ?? null, error: null };
          },
          single: async () => {
            const matched = store.filter((r) => filters.every((fn) => fn(r)));
            return { data: matched[0] ?? null, error: matched[0] ? null : { code: 'PGRST116' } };
          },
          then: (resolve) => {
            const matched = store.filter((r) => filters.every((fn) => fn(r)));
            return resolve({ data: matched, error: null });
          },
        };
        return query;
      },
      insert: (rows) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) {
          store.push({ ...r });
        }
        return makeResultChain(arr[0]);
      },
      upsert: (rowOrRows, opts = {}) => {
        const arr = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        const conflictCols = (opts.onConflict || 'id').split(',').map((s) => s.trim());
        const upserted = [];
        for (const item of arr) {
          const existingIdx = store.findIndex((existing) =>
            conflictCols.every((c) => existing[c] !== undefined && existing[c] === item[c]),
          );
          if (existingIdx >= 0) {
            store[existingIdx] = { ...store[existingIdx], ...item };
            upserted.push(store[existingIdx]);
          } else {
            const copy = { ...item };
            store.push(copy);
            upserted.push(copy);
          }
        }
        return makeResultChain(upserted[0]);
      },
      update: (fields) => ({
        eq: (col, val) => {
          for (let i = 0; i < store.length; i += 1) {
            if (store[i][col] === val) {
              store[i] = { ...store[i], ...fields };
            }
          }
          return makeResultChain(store.find((r) => r[col] === val) || null);
        },
      }),
    };
  };

  return { tables, from };
};

describe('Contract State Snapshot Backup & Disaster Recovery Sync (#185)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exports persistent vaults (XDR & structured), plan catalogs, and admin configs with a valid SHA-256 checksum', async () => {
    const xdrVaultEntry = buildXdrVaultLedgerEntry({
      user: SUBSCRIBER_1,
      merchant: MERCHANT_WALLET,
      token: TOKEN_ADDRESS,
      amount: 29_0000000,
      intervalSeconds: 2592000,
      lastPullTimestamp: 1702592000,
    });

    const mockServer = {
      getLedgerEntries: vi.fn().mockResolvedValue({
        latestLedger: 842190,
        entries: [
          xdrVaultEntry,
          {
            kind: 'vault',
            user: SUBSCRIBER_2,
            merchant: MERCHANT_WALLET,
            token: TOKEN_ADDRESS,
            amount_per_interval: '150000000',
            interval_seconds: 2592000,
            last_pull_timestamp: 1702000000,
            grace_period_seconds: 259200,
            payment_status: 1,
            initial_timestamp: 1700000000,
            pull_sequence: '0',
            is_paused: false,
            trial_end_timestamp: 0,
            plan_id: 'plan_starter',
          },
          {
            kind: 'plan',
            plan_id: 'plan_pro',
            merchant: MERCHANT_WALLET,
            token: TOKEN_ADDRESS,
            amount_per_interval: '290000000',
            interval_seconds: 2592000,
            name: 'Orbit Pro Tier',
            is_active: true,
          },
          {
            kind: 'plan',
            plan_id: 'plan_starter',
            merchant: MERCHANT_WALLET,
            token: TOKEN_ADDRESS,
            amount_per_interval: '150000000',
            interval_seconds: 2592000,
            name: 'Orbit Starter Tier',
            is_active: true,
          },
          {
            kind: 'admin_config',
            key: 'NextEscrowId',
            durability: 'instance',
            value: 12,
          },
        ],
      }),
    };

    const snapshot = await exportContractStateSnapshot({
      server: mockServer,
      contractId: CONTRACT_ID,
      vaultKeys: [
        { user: SUBSCRIBER_1, merchant: MERCHANT_WALLET },
        { user: SUBSCRIBER_2, merchant: MERCHANT_WALLET },
      ],
      planIds: ['plan_pro', 'plan_starter'],
      now: () => new Date('2026-10-18T00:00:00.000Z'),
    });

    expect(snapshot.schema_version).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.contract_id).toBe(CONTRACT_ID);
    expect(snapshot.ledger_sequence).toBe(842190);
    expect(snapshot.state.vaults).toHaveLength(2);
    expect(snapshot.state.plans).toHaveLength(2);
    expect(snapshot.state.admin_configs).toHaveLength(1);
    expect(snapshot.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);

    const verification = verifySnapshotIntegrity(snapshot);
    expect(verification.valid).toBe(true);
    expect(verification.actualChecksum).toBe(snapshot.checksum_sha256);
  });

  it('produces identical SHA-256 checksums regardless of object key insertion order and rejects tampered snapshots', () => {
    const stateA = {
      schema_version: '1.0.0',
      contract_id: CONTRACT_ID,
      ledger_sequence: 500,
      captured_at: '2026-10-18T00:00:00.000Z',
      state: {
        vaults: [{ user: SUBSCRIBER_1, merchant: MERCHANT_WALLET, amount_per_interval: '290000000', interval_seconds: 2592000 }],
        plans: [{ plan_id: 'pro', merchant: MERCHANT_WALLET, amount_per_interval: '290000000', interval_seconds: 2592000 }],
        admin_configs: [{ key: 'NextStreamId', value: 4 }],
      },
    };

    const stateB = {
      captured_at: '2026-10-18T00:00:00.000Z',
      ledger_sequence: 500,
      contract_id: CONTRACT_ID,
      schema_version: '1.0.0',
      state: {
        admin_configs: [{ value: 4, key: 'NextStreamId' }],
        plans: [{ interval_seconds: 2592000, amount_per_interval: '290000000', merchant: MERCHANT_WALLET, plan_id: 'pro' }],
        vaults: [{ interval_seconds: 2592000, amount_per_interval: '290000000', merchant: MERCHANT_WALLET, user: SUBSCRIBER_1 }],
      },
    };

    expect(canonicalizeJson(stateA)).toBe(canonicalizeJson(stateB));
    const checksum = computeSnapshotChecksum(stateA);
    expect(computeSnapshotChecksum(stateB)).toBe(checksum);

    const signedSnapshot = { ...stateA, snapshot_id: 'snap_500', checksum_sha256: checksum };
    expect(verifySnapshotIntegrity(signedSnapshot).valid).toBe(true);

    // Tamper with vault amount
    const tampered = JSON.parse(JSON.stringify(signedSnapshot));
    tampered.state.vaults[0].amount_per_interval = '9990000000';

    const tamperedCheck = verifySnapshotIntegrity(tampered);
    expect(tamperedCheck.valid).toBe(false);
    expect(tamperedCheck.reason).toMatch(/SHA-256 checksum mismatch/i);
    expect(() => assertValidSnapshot(tampered)).toThrow(SnapshotIntegrityError);
  });

  it('encrypts snapshots with AES-256-GCM and uploads to cold storage with integrity metadata', async () => {
    const baseSnapshot = {
      schema_version: '1.0.0',
      snapshot_id: 'snap_900_test',
      contract_id: CONTRACT_ID,
      ledger_sequence: 900,
      captured_at: '2026-10-18T02:00:00.000Z',
      state: {
        vaults: [],
        plans: [],
        admin_configs: [{ key: 'EmergencyPaused', durability: 'instance', value: false }],
      },
    };
    baseSnapshot.checksum_sha256 = computeSnapshotChecksum(baseSnapshot);

    const secretKey = 'orbit-cold-storage-master-encryption-secret';
    const encrypted = encryptSnapshot(baseSnapshot, secretKey);
    expect(encrypted.encrypted).toBe(true);
    expect(encrypted.ciphertext).toBeDefined();

    const decrypted = decryptSnapshot(encrypted, secretKey);
    expect(decrypted).toEqual(baseSnapshot);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-snap-'));

    const uploadRes = await uploadSnapshotToColdStorage(baseSnapshot, {
      encryptionKey: secretKey,
      coldStorageUrl: 'https://s3.orbit-backups.example.com/bucket',
      coldStorageAuthToken: 's3_token_123',
      snapshotDir: tmpDir,
      fetchImpl: mockFetch,
    });

    expect(uploadRes.encrypted).toBe(true);
    expect(uploadRes.checksum_sha256).toBe(baseSnapshot.checksum_sha256);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe(`https://s3.orbit-backups.example.com/bucket/snapshots/${CONTRACT_ID}/snap_900_test.json`);
    expect(calledInit.method).toBe('PUT');
    expect(calledInit.headers['x-amz-meta-sha256']).toBe(baseSnapshot.checksum_sha256);

    const savedFile = path.join(tmpDir, 'snap_900_test.json');
    expect(fs.existsSync(savedFile)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reconstructs merchants, plans, and subscriptions tables from a verified snapshot and via CLI recovery tool', async () => {
    const supabase = createInMemoryRecoverySupabase();
    const snapshot = {
      schema_version: '1.0.0',
      snapshot_id: 'snap_10500_dr',
      contract_id: CONTRACT_ID,
      ledger_sequence: 10500,
      captured_at: '2026-10-18T04:00:00.000Z',
      state: {
        plans: [
          {
            plan_id: 'plan_pro',
            merchant: MERCHANT_WALLET,
            token: TOKEN_ADDRESS,
            amount_per_interval: '290000000',
            interval_seconds: 2592000,
            name: 'Pro Plan',
            is_active: true,
            currency: 'USDC',
          },
        ],
        vaults: [
          {
            user: SUBSCRIBER_1,
            merchant: MERCHANT_WALLET,
            token: TOKEN_ADDRESS,
            amount_per_interval: '290000000',
            interval_seconds: 2592000,
            last_pull_timestamp: 1700000000,
            grace_period_seconds: 259200,
            payment_status: 0,
            initial_timestamp: 1700000000,
            pull_sequence: '1',
            is_paused: false,
            trial_end_timestamp: 0,
            plan_id: 'plan_pro',
          },
          {
            // Custom vault not in catalog -> synthesizes a fallback plan automatically
            user: SUBSCRIBER_2,
            merchant: MERCHANT_WALLET,
            token: TOKEN_ADDRESS,
            amount_per_interval: '990000000',
            interval_seconds: 604800,
            last_pull_timestamp: 0,
            grace_period_seconds: 259200,
            payment_status: 1, // grace_period -> past_due
            initial_timestamp: 1700000000,
            pull_sequence: '18446744073709551615',
            is_paused: false,
            trial_end_timestamp: 0,
          },
        ],
        admin_configs: [{ key: 'NextProposalId', durability: 'instance', value: 3 }],
      },
    };
    snapshot.checksum_sha256 = computeSnapshotChecksum(snapshot);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cli-dr-'));
    const snapFile = path.join(tmpDir, 'latest-snapshot.json');
    fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2), 'utf8');

    const cliResult = await runCliRecovery({
      argv: ['--file', snapFile],
      supabase,
      logger: { log: vi.fn() },
    });

    expect(cliResult.merchants_restored).toBe(1);
    expect(cliResult.plans_restored).toBe(2);
    expect(cliResult.subscriptions_restored).toBe(2);

    expect(supabase.tables.merchants).toHaveLength(1);
    expect(supabase.tables.merchants[0].wallet_address).toBe(MERCHANT_WALLET);
    expect(supabase.tables.plans).toHaveLength(2);
    expect(supabase.tables.subscriptions).toHaveLength(2);

    const activeSub = supabase.tables.subscriptions.find((s) => s.customer_wallet_address === SUBSCRIBER_1);
    const pastDueSub = supabase.tables.subscriptions.find((s) => s.customer_wallet_address === SUBSCRIBER_2);
    expect(activeSub.status).toBe('active');
    expect(pastDueSub.status).toBe('past_due');
    expect(pastDueSub.dunning_status).toBe('pending');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes /snapshots/export and /snapshots/restore API routes and rejects tampered payloads with 422', async () => {
    const apiKey = makeApiKey({ merchantId: MERCHANT_ID, walletAddress: MERCHANT_WALLET });
    const supabase = createInMemoryRecoverySupabase(apiKey.row);
    app.locals.supabase = supabase;
    app.locals.sorobanServer = {
      getLedgerEntries: vi.fn().mockResolvedValue({
        latestLedger: 123456,
        entries: [
          {
            kind: 'plan',
            plan_id: 'plan_enterprise',
            merchant: MERCHANT_WALLET,
            token: TOKEN_ADDRESS,
            amount_per_interval: '500000000',
            interval_seconds: 2592000,
            name: 'Enterprise Tier',
            is_active: true,
          },
        ],
      }),
    };

    const exportRes = await request(app)
      .post('/snapshots/export')
      .set('Authorization', apiKey.header)
      .send({
        contract_id: CONTRACT_ID,
        plan_ids: ['plan_enterprise'],
      });

    expect(exportRes.status).toBe(201);
    expect(exportRes.body.snapshot.ledger_sequence).toBe(123456);
    expect(exportRes.body.snapshot.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Restore valid snapshot via HTTP endpoint
    const restoreRes = await request(app)
      .post('/snapshots/restore')
      .set('Authorization', apiKey.header)
      .send({ snapshot: exportRes.body.snapshot });

    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.restored).toBe(true);
    expect(restoreRes.body.summary.plans_restored).toBe(1);

    // Attempt to restore tampered snapshot -> 422 Unprocessable Entity
    const tamperedSnapshot = {
      ...exportRes.body.snapshot,
      ledger_sequence: 999999,
    };
    const badRes = await request(app)
      .post('/snapshots/restore')
      .set('Authorization', apiKey.header)
      .send({ snapshot: tamperedSnapshot });

    expect(badRes.status).toBe(422);
    expect(badRes.body.code).toBe('SNAPSHOT_INTEGRITY_ERROR');
  });
});
