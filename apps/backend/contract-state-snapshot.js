// Automated smart contract state snapshot backup and disaster recovery sync (#185)
//
// Exports persistent Soroban contract state (`VaultKey`, `PlanKey`, and contract
// instance/admin configuration entries) via `getLedgerEntries` into versioned,
// deterministically serialized JSON snapshots protected by SHA-256 checksums.
// Supports optional AES-256-GCM encryption, cold-storage uploads (S3 / HTTP PUT
// or local archive), and fast off-chain PostgreSQL reconstruction of `merchants`,
// `plans`, and `subscriptions` tables without rescanning the Stellar ledger.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { Address, xdr, scValToNative, nativeToScVal } = require('@stellar/stellar-sdk');
const { writeAuditLog } = require('./audit');

const SNAPSHOT_SCHEMA_VERSION = '1.0.0';
const DEFAULT_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily
const DEFAULT_LEDGER_ENTRY_BATCH_SIZE = 100;
const PAYMENT_STATUS_ACTIVE = 0;
const PAYMENT_STATUS_GRACE_PERIOD = 1;
const PAYMENT_STATUS_DEFAULTED = 2;

class SnapshotIntegrityError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SnapshotIntegrityError';
        this.code = 'SNAPSHOT_INTEGRITY_ERROR';
        Object.assign(this, details);
    }
}

// Deterministic UUIDv5-style generator from a namespace + string so restored
// rows receive stable UUID primary keys across repeated disaster recovery runs.
const deterministicUuid = (namespace, value) => {
    const hash = crypto.createHash('sha256').update(`${namespace}:${value}`).digest('hex');
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        `4${hash.slice(13, 16)}`,
        `8${hash.slice(17, 20)}`,
        hash.slice(20, 32),
    ].join('-');
};

const isUuid = (val) =>
    typeof val === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);

// Recursively normalizes values (including BigInt) and sorts object keys so
// SHA-256 digests are invariant to key insertion order.
const canonicalizeValue = (value) => {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (Array.isArray(value)) {
        return value.map(canonicalizeValue);
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] !== undefined) {
                sorted[key] = canonicalizeValue(value[key]);
            }
        }
        return sorted;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return value;
};

const canonicalizeJson = (value) => JSON.stringify(canonicalizeValue(value));

// Extracts the canonical state payload hashed by `computeSnapshotChecksum`.
const extractHashableSnapshotPayload = (snapshot) => ({
    schema_version: snapshot.schema_version || SNAPSHOT_SCHEMA_VERSION,
    contract_id: snapshot.contract_id,
    ledger_sequence: Number(snapshot.ledger_sequence ?? 0),
    captured_at: snapshot.captured_at,
    state: {
        vaults: Array.isArray(snapshot.state?.vaults) ? snapshot.state.vaults : [],
        plans: Array.isArray(snapshot.state?.plans) ? snapshot.state.plans : [],
        admin_configs: Array.isArray(snapshot.state?.admin_configs) ? snapshot.state.admin_configs : [],
    },
});

const computeSnapshotChecksum = (snapshot) => {
    const payload = extractHashableSnapshotPayload(snapshot);
    return crypto.createHash('sha256').update(canonicalizeJson(payload), 'utf8').digest('hex');
};

const verifySnapshotIntegrity = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') {
        return {
            valid: false,
            expectedChecksum: null,
            actualChecksum: null,
            reason: 'Snapshot must be a non-null JSON object',
        };
    }
    if (!snapshot.contract_id || typeof snapshot.contract_id !== 'string') {
        return {
            valid: false,
            expectedChecksum: snapshot.checksum_sha256 || null,
            actualChecksum: null,
            reason: 'Snapshot is missing contract_id',
        };
    }
    if (!snapshot.state || typeof snapshot.state !== 'object') {
        return {
            valid: false,
            expectedChecksum: snapshot.checksum_sha256 || null,
            actualChecksum: null,
            reason: 'Snapshot is missing state payload',
        };
    }
    const providedChecksum = snapshot.checksum_sha256;
    if (typeof providedChecksum !== 'string' || !/^[0-9a-f]{64}$/i.test(providedChecksum)) {
        return {
            valid: false,
            expectedChecksum: providedChecksum || null,
            actualChecksum: null,
            reason: 'Snapshot has a missing or malformed SHA-256 checksum',
        };
    }

    const actualChecksum = computeSnapshotChecksum(snapshot);
    const expectedBuf = Buffer.from(providedChecksum.toLowerCase(), 'hex');
    const actualBuf = Buffer.from(actualChecksum.toLowerCase(), 'hex');
    const matches = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

    return {
        valid: matches,
        expectedChecksum: providedChecksum.toLowerCase(),
        actualChecksum,
        reason: matches ? null : 'SHA-256 checksum mismatch: snapshot state has been modified or corrupted',
    };
};

const assertValidSnapshot = (snapshot) => {
    const result = verifySnapshotIntegrity(snapshot);
    if (!result.valid) {
        throw new SnapshotIntegrityError(result.reason || 'Invalid snapshot checksum', result);
    }
    return result;
};

// Optional AES-256-GCM authenticated encryption for cold-storage archival
const normalizeAesKey = (secretKey) => {
    if (Buffer.isBuffer(secretKey) && secretKey.length === 32) return secretKey;
    if (typeof secretKey === 'string' && /^[0-9a-f]{64}$/i.test(secretKey)) {
        return Buffer.from(secretKey, 'hex');
    }
    return crypto.createHash('sha256').update(String(secretKey), 'utf8').digest();
};

const encryptSnapshot = (snapshot, secretKey) => {
    assertValidSnapshot(snapshot);
    const key = normalizeAesKey(secretKey);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
        encrypted: true,
        algorithm: 'aes-256-gcm',
        snapshot_id: snapshot.snapshot_id,
        contract_id: snapshot.contract_id,
        ledger_sequence: snapshot.ledger_sequence,
        captured_at: snapshot.captured_at,
        checksum_sha256: snapshot.checksum_sha256,
        iv: iv.toString('base64'),
        auth_tag: authTag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
};

const decryptSnapshot = (bundle, secretKey) => {
    if (!bundle || !bundle.encrypted) return bundle;
    if (!secretKey) {
        throw new SnapshotIntegrityError('Encryption key is required to decrypt cold-storage snapshot');
    }
    const key = normalizeAesKey(secretKey);
    const iv = Buffer.from(bundle.iv, 'base64');
    const authTag = Buffer.from(bundle.auth_tag, 'base64');
    const ciphertext = Buffer.from(bundle.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const snapshot = JSON.parse(decrypted.toString('utf8'));
    assertValidSnapshot(snapshot);
    return snapshot;
};

// ==========================================
// SOROBAN LEDGER KEY & ENTRY CODECS
// ==========================================

const persistentDurability = () =>
    typeof xdr.ContractDataDurability.persistent === 'function'
        ? xdr.ContractDataDurability.persistent()
        : xdr.ContractDataDurability.persistent;

const buildContractInstanceLedgerKey = (contractId) =>
    xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: Address.fromString(contractId).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: persistentDurability(),
        }),
    );

// Soroban `#[contracttype] pub struct VaultKey { pub user: Address, pub merchant: Address }`
// serializes as an ScMap with keys sorted lexicographically: `merchant`, `user`.
const buildVaultLedgerKey = (contractId, user, merchant) => {
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
    return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: Address.fromString(contractId).toScAddress(),
            key: keyScVal,
            durability: persistentDurability(),
        }),
    );
};

// Soroban `#[contracttype] pub struct PlanKey { pub plan_id: String }`
const buildPlanLedgerKey = (contractId, planId) => {
    const keyScVal = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('plan_id'),
            val: nativeToScVal(String(planId), { type: 'string' }),
        }),
    ]);
    return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: Address.fromString(contractId).toScAddress(),
            key: keyScVal,
            durability: persistentDurability(),
        }),
    );
};

const normalizeVaultRecord = (user, merchant, raw, liveUntilLedgerSeq = null) => ({
    user: String(user),
    merchant: String(merchant),
    token: String(raw.token),
    amount_per_interval: String(raw.amount_per_interval ?? raw.amountPerInterval ?? '0'),
    interval_seconds: Number(raw.interval_seconds ?? raw.intervalSeconds ?? 0),
    last_pull_timestamp: Number(raw.last_pull_timestamp ?? raw.lastPullTimestamp ?? 0),
    grace_period_seconds: Number(raw.grace_period_seconds ?? raw.gracePeriodSeconds ?? 259200),
    payment_status: Number(raw.payment_status ?? raw.paymentStatus ?? PAYMENT_STATUS_ACTIVE),
    initial_timestamp: Number(raw.initial_timestamp ?? raw.initialTimestamp ?? 0),
    pull_sequence: String(raw.pull_sequence ?? raw.pullSequence ?? '18446744073709551615'),
    is_paused: Boolean(raw.is_paused ?? raw.isPaused ?? false),
    trial_end_timestamp: Number(raw.trial_end_timestamp ?? raw.trialEndTimestamp ?? 0),
    ...(raw.plan_id ? { plan_id: String(raw.plan_id) } : {}),
    ...(liveUntilLedgerSeq !== null && liveUntilLedgerSeq !== undefined
        ? { live_until_ledger_seq: Number(liveUntilLedgerSeq) }
        : {}),
});

const normalizePlanRecord = (planId, raw, liveUntilLedgerSeq = null) => ({
    plan_id: String(planId),
    merchant: String(raw.merchant),
    token: String(raw.token),
    amount_per_interval: String(raw.amount_per_interval ?? raw.amountPerInterval ?? '0'),
    interval_seconds: Number(raw.interval_seconds ?? raw.intervalSeconds ?? 0),
    name: String(raw.name || `Plan ${planId}`),
    is_active: raw.is_active !== undefined ? Boolean(raw.is_active) : Boolean(raw.isActive ?? true),
    currency: String(raw.currency || 'USDC'),
    ...(raw.price_amount !== undefined && raw.price_amount !== null
        ? { price_amount: Number(raw.price_amount) }
        : {}),
    ...(liveUntilLedgerSeq !== null && liveUntilLedgerSeq !== undefined
        ? { live_until_ledger_seq: Number(liveUntilLedgerSeq) }
        : {}),
});

const normalizeAdminConfigRecord = (keyName, value, durability = 'instance', liveUntilLedgerSeq = null) => ({
    key: String(keyName),
    durability: String(durability),
    value: canonicalizeValue(value),
    ...(liveUntilLedgerSeq !== null && liveUntilLedgerSeq !== undefined
        ? { live_until_ledger_seq: Number(liveUntilLedgerSeq) }
        : {}),
});

const callOrProp = (obj, prop) =>
    typeof obj?.[prop] === 'function' ? obj[prop]() : obj?.[prop];

// Parses a single entry returned by Soroban RPC `getLedgerEntries`.
// Supports both decoded ScVal / XDR `LedgerEntryData` objects and pre-parsed
// structured mock entries for testing and custom RPC adapters.
const parseSorobanLedgerEntry = (entry) => {
    if (!entry) return null;
    const liveUntil = entry.liveUntilLedgerSeq ?? entry.live_until_ledger_seq ?? null;

    // 1. Pre-parsed structured entry support
    if (entry.kind === 'vault' || (entry.user && entry.merchant && entry.amount_per_interval !== undefined)) {
        return {
            type: 'vault',
            data: normalizeVaultRecord(entry.user, entry.merchant, entry, liveUntil),
        };
    }
    if (entry.kind === 'plan' || (entry.plan_id && entry.merchant && entry.amount_per_interval !== undefined)) {
        return {
            type: 'plan',
            data: normalizePlanRecord(entry.plan_id, entry, liveUntil),
        };
    }
    if (entry.kind === 'admin_config' || (entry.key && entry.value !== undefined && !entry.val)) {
        return {
            type: 'admin_config',
            data: normalizeAdminConfigRecord(entry.key, entry.value, entry.durability || 'instance', liveUntil),
        };
    }

    // 2. XDR LedgerEntryData or { key, val } ScVal entry from Soroban RPC
    let contractData = null;
    if (entry.val) {
        if (typeof entry.val === 'string') {
            const ledgerEntryData = xdr.LedgerEntryData.fromXDR(entry.val, 'base64');
            contractData = callOrProp(ledgerEntryData, 'contractData') || callOrProp(ledgerEntryData, 'value');
        } else {
            contractData = callOrProp(entry.val, 'contractData') || callOrProp(entry.val, 'value') || entry.val;
        }
    } else if (typeof entry.xdr === 'string') {
        const ledgerEntryData = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
        contractData = callOrProp(ledgerEntryData, 'contractData') || callOrProp(ledgerEntryData, 'value');
    }

    if (!contractData) return null;

    const keyScVal = callOrProp(contractData, 'key');
    const valScVal = callOrProp(contractData, 'val');
    if (!keyScVal || !valScVal) return null;

    const keySwitch = callOrProp(keyScVal, 'switch');
    const switchName = typeof keySwitch === 'string' ? keySwitch : keySwitch?.name;

    // Instance storage holds contract-level admin / counter configs in its storage map
    if (switchName === 'scvLedgerKeyContractInstance' || switchName === 'SCV_LEDGER_KEY_CONTRACT_INSTANCE') {
        const instance = callOrProp(valScVal, 'instance') || callOrProp(valScVal, 'value');
        const storageMap = callOrProp(instance, 'storage') || [];
        const configs = storageMap.map((mapEntry) => {
            const k = scValToNative(callOrProp(mapEntry, 'key'));
            const v = scValToNative(callOrProp(mapEntry, 'val'));
            const keyLabel = Array.isArray(k) ? k.join(':') : typeof k === 'object' ? JSON.stringify(canonicalizeValue(k)) : String(k);
            return normalizeAdminConfigRecord(keyLabel, v, 'instance', liveUntil);
        });
        return { type: 'instance_configs', data: configs };
    }

    const nativeKey = scValToNative(keyScVal);
    const nativeVal = scValToNative(valScVal);

    if (nativeKey && typeof nativeKey === 'object' && !Array.isArray(nativeKey)) {
        if (nativeKey.user && nativeKey.merchant && nativeVal && typeof nativeVal === 'object') {
            return {
                type: 'vault',
                data: normalizeVaultRecord(nativeKey.user, nativeKey.merchant, nativeVal, liveUntil),
            };
        }
        if (nativeKey.plan_id && nativeVal && typeof nativeVal === 'object') {
            return {
                type: 'plan',
                data: normalizePlanRecord(nativeKey.plan_id, nativeVal, liveUntil),
            };
        }
    }

    const fallbackKey =
        typeof nativeKey === 'object' ? JSON.stringify(canonicalizeValue(nativeKey)) : String(nativeKey);
    return {
        type: 'admin_config',
        data: normalizeAdminConfigRecord(fallbackKey, nativeVal, 'persistent', liveUntil),
    };
};

// ==========================================
// SNAPSHOT EXPORTER & COLD STORAGE UPLOADER
// ==========================================

const exportContractStateSnapshot = async ({
    server,
    contractId,
    supabase = null,
    vaultKeys = [],
    planIds = [],
    customLedgerKeys = [],
    batchSize = DEFAULT_LEDGER_ENTRY_BATCH_SIZE,
    now = () => new Date(),
} = {}) => {
    if (!contractId) {
        throw new Error('contractId is required to export contract state snapshot');
    }
    if (!server || typeof server.getLedgerEntries !== 'function') {
        throw new Error('Soroban RPC server with getLedgerEntries() is required');
    }

    // Discover known (user, merchant) pairs and plan IDs from Supabase if available
    const discoveredVaultMap = new Map();
    const discoveredPlanSet = new Set(planIds.map(String));

    for (const vk of vaultKeys) {
        if (vk?.user && vk?.merchant) {
            discoveredVaultMap.set(`${vk.user}|${vk.merchant}`, { user: vk.user, merchant: vk.merchant });
        }
    }

    if (supabase) {
        try {
            const { data: dbPlans } = await supabase.from('plans').select('id');
            for (const p of dbPlans || []) {
                if (p?.id) discoveredPlanSet.add(String(p.id));
            }
            const { data: dbSubs } = await supabase
                .from('subscriptions')
                .select('customer_wallet_address, plans!inner(merchants!inner(wallet_address))');
            for (const s of dbSubs || []) {
                const user = s.customer_wallet_address;
                const merchant = s.plans?.merchants?.wallet_address;
                if (user && merchant) {
                    discoveredVaultMap.set(`${user}|${merchant}`, { user, merchant });
                }
            }
        } catch {
            // Continue with explicit keys if DB is unavailable (e.g. during outage)
        }
    }

    const ledgerKeys = [];
    // Always query the contract instance entry first
    try {
        ledgerKeys.push(buildContractInstanceLedgerKey(contractId));
    } catch {
        ledgerKeys.push({ kind: 'instance', contractId });
    }

    for (const { user, merchant } of discoveredVaultMap.values()) {
        try {
            ledgerKeys.push(buildVaultLedgerKey(contractId, user, merchant));
        } catch {
            ledgerKeys.push({ kind: 'vault_key', user, merchant });
        }
    }

    for (const planId of discoveredPlanSet.values()) {
        try {
            ledgerKeys.push(buildPlanLedgerKey(contractId, planId));
        } catch {
            ledgerKeys.push({ kind: 'plan_key', plan_id: planId });
        }
    }

    for (const customKey of customLedgerKeys) {
        ledgerKeys.push(customKey);
    }

    const vaults = [];
    const plans = [];
    const adminConfigs = [];
    let latestLedger = 0;

    for (let offset = 0; offset < ledgerKeys.length; offset += batchSize) {
        const chunk = ledgerKeys.slice(offset, offset + batchSize);
        const response = await server.getLedgerEntries(...chunk);
        if (response?.latestLedger && Number(response.latestLedger) > latestLedger) {
            latestLedger = Number(response.latestLedger);
        }

        for (const rawEntry of response?.entries || []) {
            const parsed = parseSorobanLedgerEntry(rawEntry);
            if (!parsed) continue;
            if (parsed.type === 'vault') {
                vaults.push(parsed.data);
            } else if (parsed.type === 'plan') {
                plans.push(parsed.data);
            } else if (parsed.type === 'instance_configs') {
                adminConfigs.push(...parsed.data);
            } else if (parsed.type === 'admin_config') {
                adminConfigs.push(parsed.data);
            }
        }
    }

    if (!latestLedger && typeof server.getLatestLedger === 'function') {
        try {
            const latest = await server.getLatestLedger();
            latestLedger = Number(latest?.sequence || 0);
        } catch {
            latestLedger = 0;
        }
    }

    // Sort deterministically so snapshots of identical ledger states produce identical hashes
    vaults.sort((a, b) => `${a.user}|${a.merchant}`.localeCompare(`${b.user}|${b.merchant}`));
    plans.sort((a, b) => a.plan_id.localeCompare(b.plan_id));
    adminConfigs.sort((a, b) => a.key.localeCompare(b.key));

    const capturedAt = (now() instanceof Date ? now() : new Date(now())).toISOString();
    const snapshotDraft = {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        snapshot_id: `snap_${latestLedger}_${Date.now()}`,
        contract_id: contractId,
        ledger_sequence: latestLedger,
        captured_at: capturedAt,
        state: {
            vaults,
            plans,
            admin_configs: adminConfigs,
        },
    };

    const checksumSha256 = computeSnapshotChecksum(snapshotDraft);
    return {
        ...snapshotDraft,
        checksum_sha256: checksumSha256,
    };
};

// Uploads a verified snapshot (optionally encrypted) to S3 / cold storage or local archive directory
const uploadSnapshotToColdStorage = async (
    snapshot,
    {
        encryptionKey = process.env.SNAPSHOT_ENCRYPTION_KEY,
        coldStorageUrl = process.env.SNAPSHOT_COLD_STORAGE_URL,
        coldStorageAuthToken = process.env.SNAPSHOT_COLD_STORAGE_TOKEN,
        snapshotDir = process.env.SNAPSHOT_DIR,
        coldStorageUploader = null,
        fetchImpl = globalThis.fetch,
    } = {},
) => {
    assertValidSnapshot(snapshot);

    const payloadToStore = encryptionKey ? encryptSnapshot(snapshot, encryptionKey) : snapshot;
    const serialized = JSON.stringify(payloadToStore, null, 2);
    const objectKey = `snapshots/${snapshot.contract_id}/${snapshot.snapshot_id}.json`;
    let storageLocation = null;

    if (typeof coldStorageUploader === 'function') {
        const res = await coldStorageUploader({
            key: objectKey,
            body: serialized,
            snapshot,
            encrypted: Boolean(encryptionKey),
            checksumSha256: snapshot.checksum_sha256,
        });
        storageLocation = res?.location || `s3://orbit-cold-storage/${objectKey}`;
    } else if (coldStorageUrl && typeof fetchImpl === 'function') {
        const targetUrl = `${coldStorageUrl.replace(/\/$/, '')}/${objectKey}`;
        const headers = {
            'Content-Type': 'application/json',
            'X-Orbit-Snapshot-Sha256': snapshot.checksum_sha256,
            'x-amz-meta-sha256': snapshot.checksum_sha256,
            'x-amz-meta-ledger': String(snapshot.ledger_sequence),
        };
        if (coldStorageAuthToken) {
            headers.Authorization = `Bearer ${coldStorageAuthToken}`;
        }
        const response = await fetchImpl(targetUrl, {
            method: 'PUT',
            headers,
            body: serialized,
        });
        if (!response.ok) {
            throw new Error(`Cold storage upload failed with HTTP ${response.status}`);
        }
        storageLocation = targetUrl;
    }

    if (snapshotDir) {
        fs.mkdirSync(snapshotDir, { recursive: true });
        const filePath = path.join(snapshotDir, `${snapshot.snapshot_id}.json`);
        fs.writeFileSync(filePath, serialized, 'utf8');
        if (!storageLocation) {
            storageLocation = filePath;
        }
    }

    return {
        snapshot_id: snapshot.snapshot_id,
        checksum_sha256: snapshot.checksum_sha256,
        encrypted: Boolean(encryptionKey),
        storage_location: storageLocation || `memory://${objectKey}`,
    };
};

// ==========================================
// DISASTER RECOVERY DATABASE RECONSTRUCTION
// ==========================================

const deriveSubscriptionStatus = (vault) => {
    if (Number(vault.payment_status) === PAYMENT_STATUS_DEFAULTED) {
        return 'cancelled';
    }
    if (Number(vault.payment_status) === PAYMENT_STATUS_GRACE_PERIOD) {
        return 'past_due';
    }
    return 'active';
};

const deriveNextBillingDate = (vault, fallbackNowSeconds) => {
    const interval = Math.max(1, Number(vault.interval_seconds || 2592000));
    const trialEnd = Number(vault.trial_end_timestamp || 0);
    const lastPull = Number(vault.last_pull_timestamp || 0);
    const initial = Number(vault.initial_timestamp || fallbackNowSeconds);

    if (lastPull > 0) {
        return new Date((lastPull + interval) * 1000).toISOString();
    }
    if (trialEnd > initial) {
        return new Date(trialEnd * 1000).toISOString();
    }
    return new Date((initial + interval) * 1000).toISOString();
};

const restoreDatabaseFromSnapshot = async ({
    supabase,
    snapshot,
    encryptionKey = process.env.SNAPSHOT_ENCRYPTION_KEY,
    now = () => new Date(),
} = {}) => {
    if (!supabase) {
        throw new Error('Supabase client is required to restore database tables');
    }

    const decodedSnapshot = snapshot?.encrypted ? decryptSnapshot(snapshot, encryptionKey) : snapshot;
    assertValidSnapshot(decodedSnapshot);

    const vaults = decodedSnapshot.state?.vaults || [];
    const plans = decodedSnapshot.state?.plans || [];
    const nowDate = now() instanceof Date ? now() : new Date(now());
    const nowIso = nowDate.toISOString();
    const nowSeconds = Math.floor(nowDate.getTime() / 1000);

    // 1. Reconstruct Merchants from unique wallet addresses in plans and vaults
    const merchantWallets = new Set();
    for (const plan of plans) {
        if (plan.merchant) merchantWallets.add(String(plan.merchant));
    }
    for (const vault of vaults) {
        if (vault.merchant) merchantWallets.add(String(vault.merchant));
    }

    const merchantIdByWallet = new Map();
    const restoredMerchants = [];

    for (const walletAddress of Array.from(merchantWallets).sort()) {
        const merchantId = deterministicUuid('orbit-merchant', walletAddress);
        const merchantRecord = {
            id: merchantId,
            wallet_address: walletAddress,
            name: `Recovered Merchant (${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)})`,
        };
        const { data: upsertedMerchant, error: merchantError } = await supabase
            .from('merchants')
            .upsert(merchantRecord, { onConflict: 'wallet_address' })
            .select()
            .single();
        if (merchantError) throw merchantError;

        const effectiveMerchant = upsertedMerchant || merchantRecord;
        merchantIdByWallet.set(walletAddress, effectiveMerchant.id);
        restoredMerchants.push(effectiveMerchant);
    }

    // 2. Reconstruct Plans from catalog + synthesize fallback plans for custom vaults
    const planIdByLookupKey = new Map();
    const restoredPlans = [];

    for (const plan of plans) {
        const merchantId = merchantIdByWallet.get(String(plan.merchant));
        const planUuid = isUuid(plan.plan_id)
            ? plan.plan_id
            : deterministicUuid('orbit-plan', `${plan.merchant}:${plan.plan_id}`);

        const planRecord = {
            id: planUuid,
            merchant_id: merchantId,
            name: String(plan.name || `Recovered Plan ${plan.plan_id}`),
            usdc_amount: Number(plan.amount_per_interval),
            interval_seconds: Number(plan.interval_seconds),
            currency: String(plan.currency || 'USDC'),
            ...(plan.price_amount !== undefined ? { price_amount: Number(plan.price_amount) } : {}),
        };

        const { data: upsertedPlan, error: planError } = await supabase
            .from('plans')
            .upsert(planRecord, { onConflict: 'id' })
            .select()
            .single();
        if (planError) throw planError;

        const effectivePlan = upsertedPlan || planRecord;
        planIdByLookupKey.set(`id:${plan.plan_id}`, effectivePlan.id);
        planIdByLookupKey.set(
            `terms:${plan.merchant}:${plan.amount_per_interval}:${plan.interval_seconds}`,
            effectivePlan.id,
        );
        restoredPlans.push(effectivePlan);
    }

    // 3. Reconstruct Subscriptions from persistent vaults
    const restoredSubscriptions = [];

    for (const vault of vaults) {
        const merchantId = merchantIdByWallet.get(String(vault.merchant));
        let planId =
            (vault.plan_id && planIdByLookupKey.get(`id:${vault.plan_id}`)) ||
            planIdByLookupKey.get(`terms:${vault.merchant}:${vault.amount_per_interval}:${vault.interval_seconds}`);

        if (!planId) {
            const syntheticKey = `${vault.merchant}:${vault.amount_per_interval}:${vault.interval_seconds}`;
            const syntheticPlanId = deterministicUuid('orbit-synthetic-plan', syntheticKey);
            const syntheticPlanRecord = {
                id: syntheticPlanId,
                merchant_id: merchantId,
                name: `Recovered Vault Plan (${Number(vault.amount_per_interval) / 1e7} USDC / ${vault.interval_seconds}s)`,
                usdc_amount: Number(vault.amount_per_interval),
                interval_seconds: Number(vault.interval_seconds),
                currency: 'USDC',
            };
            const { data: createdPlan, error: synthError } = await supabase
                .from('plans')
                .upsert(syntheticPlanRecord, { onConflict: 'id' })
                .select()
                .single();
            if (synthError) throw synthError;
            planId = (createdPlan || syntheticPlanRecord).id;
            planIdByLookupKey.set(`terms:${syntheticKey}`, planId);
            restoredPlans.push(createdPlan || syntheticPlanRecord);
        }

        const subscriptionId = deterministicUuid(
            'orbit-subscription',
            `${planId}:${vault.user}`,
        );
        const subscriptionRecord = {
            id: subscriptionId,
            plan_id: planId,
            customer_wallet_address: String(vault.user),
            status: deriveSubscriptionStatus(vault),
            next_billing_date: deriveNextBillingDate(vault, nowSeconds),
            retry_count: Number(vault.payment_status) === PAYMENT_STATUS_GRACE_PERIOD ? 1 : 0,
            dunning_status: Number(vault.payment_status) === PAYMENT_STATUS_GRACE_PERIOD ? 'pending' : null,
            metadata: {
                restored_from_snapshot: decodedSnapshot.snapshot_id,
                ledger_sequence: decodedSnapshot.ledger_sequence,
                pull_sequence: String(vault.pull_sequence),
                is_paused: Boolean(vault.is_paused),
                trial_end_timestamp: Number(vault.trial_end_timestamp || 0),
                token: String(vault.token),
            },
        };

        const { data: upsertedSub, error: subError } = await supabase
            .from('subscriptions')
            .upsert(subscriptionRecord, { onConflict: 'plan_id,customer_wallet_address' })
            .select()
            .single();
        if (subError) throw subError;

        restoredSubscriptions.push(upsertedSub || subscriptionRecord);
    }

    // Record restore timestamp in contract_state_snapshots if table is present
    try {
        await supabase
            .from('contract_state_snapshots')
            .upsert(
                {
                    snapshot_id: decodedSnapshot.snapshot_id,
                    contract_id: decodedSnapshot.contract_id,
                    ledger_sequence: decodedSnapshot.ledger_sequence,
                    schema_version: decodedSnapshot.schema_version || SNAPSHOT_SCHEMA_VERSION,
                    checksum_sha256: decodedSnapshot.checksum_sha256,
                    vault_count: vaults.length,
                    plan_count: plans.length,
                    config_count: (decodedSnapshot.state?.admin_configs || []).length,
                    snapshot_payload: decodedSnapshot,
                    captured_at: decodedSnapshot.captured_at,
                    restored_at: nowIso,
                },
                { onConflict: 'snapshot_id' },
            );
    } catch {
        // Non-fatal if metadata table is not migrated yet
    }

    await writeAuditLog(supabase, {
        action: 'system.disaster_recovery_restore',
        resourceType: 'contract_state_snapshot',
        resourceId: decodedSnapshot.snapshot_id,
        changesAfter: {
            ledger_sequence: decodedSnapshot.ledger_sequence,
            checksum_sha256: decodedSnapshot.checksum_sha256,
            merchants_restored: restoredMerchants.length,
            plans_restored: restoredPlans.length,
            subscriptions_restored: restoredSubscriptions.length,
        },
    });

    return {
        snapshot_id: decodedSnapshot.snapshot_id,
        contract_id: decodedSnapshot.contract_id,
        ledger_sequence: decodedSnapshot.ledger_sequence,
        checksum_sha256: decodedSnapshot.checksum_sha256,
        merchants_restored: restoredMerchants.length,
        plans_restored: restoredPlans.length,
        subscriptions_restored: restoredSubscriptions.length,
        restored_at: nowIso,
    };
};

// ==========================================
// BACKGROUND SNAPSHOT WORKER & EXPRESS ROUTES
// ==========================================

const createSnapshotExportWorker = ({
    server,
    supabase,
    contractId = process.env.ORBIT_CONTRACT_ID || process.env.SOROBAN_CONTRACT_ID,
    vaultKeys = [],
    planIds = [],
    coldStorageOptions = {},
    logger = console,
    now = () => new Date(),
} = {}) => {
    const runOnce = async (overrideOptions = {}) => {
        const snapshot = await exportContractStateSnapshot({
            server,
            contractId: overrideOptions.contractId || contractId,
            supabase,
            vaultKeys: overrideOptions.vaultKeys || vaultKeys,
            planIds: overrideOptions.planIds || planIds,
            now,
        });

        const uploadResult = await uploadSnapshotToColdStorage(snapshot, {
            ...coldStorageOptions,
            ...(overrideOptions.coldStorageOptions || {}),
        });

        if (supabase) {
            try {
                await supabase.from('contract_state_snapshots').upsert(
                    {
                        snapshot_id: snapshot.snapshot_id,
                        contract_id: snapshot.contract_id,
                        ledger_sequence: snapshot.ledger_sequence,
                        schema_version: snapshot.schema_version,
                        checksum_sha256: snapshot.checksum_sha256,
                        vault_count: snapshot.state.vaults.length,
                        plan_count: snapshot.state.plans.length,
                        config_count: snapshot.state.admin_configs.length,
                        storage_location: uploadResult.storage_location,
                        encrypted: uploadResult.encrypted,
                        snapshot_payload: snapshot,
                        captured_at: snapshot.captured_at,
                    },
                    { onConflict: 'snapshot_id' },
                );
            } catch (err) {
                logger.warn?.('Failed to persist snapshot metadata row:', err.message);
            }
        }

        return {
            snapshot,
            upload: uploadResult,
        };
    };

    const start = (intervalMs = DEFAULT_SNAPSHOT_INTERVAL_MS) => {
        const timer = setInterval(() => {
            runOnce().catch((err) => logger.error?.('Contract state snapshot worker failed:', err));
        }, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
        return { stop: () => clearInterval(timer) };
    };

    return { runOnce, start };
};

const exportSnapshotRequestSchema = z.object({
    contract_id: z.string().min(1).optional(),
    vault_keys: z
        .array(
            z.object({
                user: z.string().min(1),
                merchant: z.string().min(1),
            }),
        )
        .optional()
        .default([]),
    plan_ids: z.array(z.string().min(1)).optional().default([]),
});

const registerSnapshotRoutes = (app, getSupabase, authenticateMerchant, getSorobanServer) => {
    app.post('/snapshots/export', authenticateMerchant, async (req, res) => {
        const parsed = exportSnapshotRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid request body' });
        }

        const contractId =
            parsed.data.contract_id ||
            process.env.ORBIT_CONTRACT_ID ||
            process.env.SOROBAN_CONTRACT_ID ||
            'CORBIT_DEFAULT_CONTRACT_ID';

        try {
            const server = getSorobanServer(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org');
            const worker = createSnapshotExportWorker({
                server,
                supabase: getSupabase(),
                contractId,
                vaultKeys: parsed.data.vault_keys,
                planIds: parsed.data.plan_ids,
                coldStorageOptions: {
                    fetchImpl: app.locals.fetchImpl,
                    coldStorageUploader: app.locals.coldStorageUploader,
                },
            });

            const result = await worker.runOnce();
            return res.status(201).json(result);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    app.post('/snapshots/restore', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) {
            return res.status(500).json({ error: 'Supabase client not initialized' });
        }

        const snapshot = req.body?.snapshot;
        if (!snapshot) {
            return res.status(400).json({ error: 'snapshot object is required in request body' });
        }

        try {
            const summary = await restoreDatabaseFromSnapshot({
                supabase,
                snapshot,
                encryptionKey: req.body?.encryption_key || process.env.SNAPSHOT_ENCRYPTION_KEY,
            });
            return res.status(200).json({ restored: true, summary });
        } catch (err) {
            if (err instanceof SnapshotIntegrityError || err?.code === 'SNAPSHOT_INTEGRITY_ERROR') {
                return res.status(422).json({
                    error: err.message,
                    code: 'SNAPSHOT_INTEGRITY_ERROR',
                    expected_checksum: err.expectedChecksum,
                    actual_checksum: err.actualChecksum,
                });
            }
            return res.status(500).json({ error: err.message });
        }
    });

    app.get('/snapshots', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) {
            return res.status(500).json({ error: 'Supabase client not initialized' });
        }
        const { data, error } = await supabase
            .from('contract_state_snapshots')
            .select(
                'id, snapshot_id, contract_id, ledger_sequence, schema_version, checksum_sha256, vault_count, plan_count, config_count, storage_location, encrypted, captured_at, restored_at',
            )
            .order('captured_at', { ascending: false })
            .limit(50);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ snapshots: data ?? [] });
    });
};

module.exports = {
    SNAPSHOT_SCHEMA_VERSION,
    SnapshotIntegrityError,
    deterministicUuid,
    canonicalizeJson,
    computeSnapshotChecksum,
    verifySnapshotIntegrity,
    assertValidSnapshot,
    encryptSnapshot,
    decryptSnapshot,
    buildContractInstanceLedgerKey,
    buildVaultLedgerKey,
    buildPlanLedgerKey,
    parseSorobanLedgerEntry,
    exportContractStateSnapshot,
    uploadSnapshotToColdStorage,
    restoreDatabaseFromSnapshot,
    createSnapshotExportWorker,
    registerSnapshotRoutes,
};
