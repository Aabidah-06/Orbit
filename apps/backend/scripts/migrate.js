#!/usr/bin/env node
// Database migration CLI (#157).
//
//   npm run migrate:up                 apply every pending migration
//   npm run migrate:up -- --steps 1    apply only the next one
//   npm run migrate:down               roll back the last applied migration
//   npm run migrate:down -- --steps 2  roll back the last two
//   npm run migrate:status             list applied, pending and drifted migrations
//
// Connects with DATABASE_URL.
require('dotenv').config();
const { Client } = require('pg');
const { migrateDown, migrateUp, migrationStatus } = require('../migrate');

function parseSteps(args) {
    const index = args.indexOf('--steps');
    if (index === -1) return undefined;
    const steps = Number(args[index + 1]);
    if (!Number.isInteger(steps) || steps < 1) throw new Error('--steps must be a positive integer');
    return steps;
}

async function printStatus(db) {
    const status = await migrationStatus(db);
    for (const row of status.applied) {
        const drift = status.mismatched.find((m) => m.version === row.version) ? '  CHECKSUM MISMATCH' : '';
        const missing = status.missing.find((m) => m.version === row.version) ? '  FILE MISSING' : '';
        console.log(`applied  ${row.version}_${row.name}  (${row.execution_ms} ms, ${new Date(row.applied_at).toISOString()})${drift}${missing}`);
    }
    for (const m of status.pending) console.log(`pending  ${m.file}`);
    if (!status.applied.length && !status.pending.length) console.log('No migrations found.');
    return status.mismatched.length || status.missing.length ? 1 : 0;
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!['up', 'down', 'status'].includes(command)) {
        console.error('Usage: node scripts/migrate.js <up|down|status> [--steps N]');
        return 2;
    }
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set');
        return 2;
    }

    // One dedicated connection: the advisory lock and each BEGIN/COMMIT must share it
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
        const log = (line) => console.log(line);
        if (command === 'status') return await printStatus(db);
        const steps = parseSteps(args);
        if (command === 'up') {
            const applied = await migrateUp(db, { steps, log });
            console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
        } else {
            const reverted = await migrateDown(db, { steps, log });
            console.log(reverted.length ? `Rolled back ${reverted.length} migration(s).` : 'Nothing to roll back.');
        }
        return 0;
    } finally {
        await db.end();
    }
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    });
