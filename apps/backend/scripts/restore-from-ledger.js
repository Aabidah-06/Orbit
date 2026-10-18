#!/usr/bin/env node
// Automated Disaster Recovery CLI (#185):
//
//   npm run db:restore-from-ledger -- [--file path/to/snapshot.json] [--dir path/to/snapshots]
//
// Parses the latest verified contract state snapshot, checks its SHA-256 integrity
// digest (decrypting AES-256-GCM bundles when SNAPSHOT_ENCRYPTION_KEY is configured),
// and reconstructs `merchants`, `plans`, and `subscriptions` tables in PostgreSQL.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const {
    assertValidSnapshot,
    decryptSnapshot,
    restoreDatabaseFromSnapshot,
} = require('../contract-state-snapshot');

const parseCliArgs = (argv = process.argv.slice(2)) => {
    const args = {
        filePath: process.env.SNAPSHOT_FILE || null,
        snapshotDir: process.env.SNAPSHOT_DIR || path.resolve(__dirname, '../snapshots'),
        encryptionKey: process.env.SNAPSHOT_ENCRYPTION_KEY || null,
        dryRun: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--file' && argv[i + 1]) {
            args.filePath = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--dir' && argv[i + 1]) {
            args.snapshotDir = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--key' && argv[i + 1]) {
            args.encryptionKey = argv[i + 1];
            i += 1;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        }
    }

    return args;
};

const findLatestSnapshotFile = (dirPath) => {
    if (!dirPath || !fs.existsSync(dirPath)) return null;
    const files = fs
        .readdirSync(dirPath)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            const fullPath = path.join(dirPath, f);
            const stat = fs.statSync(fullPath);
            return { fullPath, mtimeMs: stat.mtimeMs, name: f };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

    return files[0]?.fullPath || null;
};

const loadSnapshotForRecovery = async ({
    filePath,
    snapshotDir,
    encryptionKey,
    supabase,
} = {}) => {
    let rawPayload = null;
    let source = null;

    const targetFile = filePath || findLatestSnapshotFile(snapshotDir);
    if (targetFile && fs.existsSync(targetFile)) {
        rawPayload = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
        source = targetFile;
    } else if (supabase) {
        const { data, error } = await supabase
            .from('contract_state_snapshots')
            .select('snapshot_id, snapshot_payload')
            .order('ledger_sequence', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        if (data?.snapshot_payload) {
            rawPayload = data.snapshot_payload;
            source = `supabase:contract_state_snapshots:${data.snapshot_id}`;
        }
    }

    if (!rawPayload) {
        throw new Error(
            'No contract state snapshot found. Provide --file <path>, set SNAPSHOT_DIR, or ensure contract_state_snapshots contains a snapshot.',
        );
    }

    const decoded = rawPayload.encrypted ? decryptSnapshot(rawPayload, encryptionKey) : rawPayload;
    assertValidSnapshot(decoded);
    return { snapshot: decoded, source };
};

const runCliRecovery = async ({
    argv = process.argv.slice(2),
    supabase = null,
    logger = console,
} = {}) => {
    const args = parseCliArgs(argv);
    const client =
        supabase ||
        (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
            ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
            : null);

    const { snapshot, source } = await loadSnapshotForRecovery({
        filePath: args.filePath,
        snapshotDir: args.snapshotDir,
        encryptionKey: args.encryptionKey,
        supabase: client,
    });

    if (args.dryRun) {
        const dryRunSummary = {
            dry_run: true,
            source,
            snapshot_id: snapshot.snapshot_id,
            ledger_sequence: snapshot.ledger_sequence,
            checksum_sha256: snapshot.checksum_sha256,
            vaults: snapshot.state.vaults.length,
            plans: snapshot.state.plans.length,
            admin_configs: snapshot.state.admin_configs.length,
        };
        logger.log(JSON.stringify(dryRunSummary));
        return dryRunSummary;
    }

    if (!client) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to restore database tables');
    }

    const summary = await restoreDatabaseFromSnapshot({
        supabase: client,
        snapshot,
        encryptionKey: args.encryptionKey,
    });

    const result = {
        source,
        ...summary,
    };
    logger.log(JSON.stringify(result));
    return result;
};

if (require.main === module) {
    runCliRecovery().catch((err) => {
        console.error(JSON.stringify({ level: 'error', event: 'restore_from_ledger.failed', message: err.message }));
        process.exitCode = 1;
    });
}

module.exports = {
    parseCliArgs,
    findLatestSnapshotFile,
    loadSnapshotForRecovery,
    runCliRecovery,
};
