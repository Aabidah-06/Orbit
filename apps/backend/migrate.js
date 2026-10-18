'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Versioned database migrations and schema guard (#157).
//
// Migrations live in migrations/ as YYYYMMDDHHMMSS_description.sql or .js and
// are applied in version order. Each applied version is recorded in
// schema_migrations with its execution time and the SHA-256 of the file, so an
// edited migration is detected as drift. Every migration runs inside its own
// BEGIN ... COMMIT and is rolled back as a whole if any statement fails.
//
// SQL files hold both directions, split by marker comments:
//
//   -- migrate:up
//   CREATE TABLE ...;
//   -- migrate:down
//   DROP TABLE ...;
//
// A `-- migrate:no-transaction` line opts a file out of the transaction, for
// statements PostgreSQL refuses to run in one (CREATE INDEX CONCURRENTLY).
// JS files export async up(db) and down(db), where db.query(text, params).
//
// The older NNN-description.sql files in migrations/ predate the runner and are
// already folded into schema.sql; the runner ignores them.

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_FILE_RE = /^(\d{14})_([a-z0-9][a-z0-9_-]*)\.(sql|js)$/i;
// Arbitrary constant: serializes concurrent runners (e.g. two deploys) on one database
const ADVISORY_LOCK_ID = 157_000_157;

class MigrationError extends Error {
    constructor(message, { version, cause } = {}) {
        super(message);
        this.name = 'MigrationError';
        this.version = version;
        if (cause) this.cause = cause;
    }
}

class SchemaDriftError extends Error {
    constructor(status) {
        const problems = [];
        if (status.pending.length) problems.push(`${status.pending.length} pending (${status.pending.map((m) => m.version).join(', ')})`);
        if (status.mismatched.length) problems.push(`checksum mismatch in ${status.mismatched.map((m) => m.version).join(', ')}`);
        if (status.missing.length) problems.push(`applied but missing locally: ${status.missing.map((m) => m.version).join(', ')}`);
        super(`Database schema is out of date with this build: ${problems.join('; ')}. Run \`npm run migrate:up\`.`);
        this.name = 'SchemaDriftError';
        this.status = status;
    }
}

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

function parseSqlMigration(source, file) {
    const lines = source.split(/\r?\n/);
    const sections = { up: [], down: [] };
    let current = null;
    let transactional = true;
    for (const line of lines) {
        const marker = line.trim().toLowerCase();
        if (marker === '-- migrate:up') { current = 'up'; continue; }
        if (marker === '-- migrate:down') { current = 'down'; continue; }
        if (marker === '-- migrate:no-transaction') { transactional = false; continue; }
        if (current) sections[current].push(line);
    }
    const up = sections.up.join('\n').trim();
    if (!up) throw new MigrationError(`${file} has no "-- migrate:up" section`);
    const down = sections.down.join('\n').trim();
    return {
        transactional,
        up: (db) => execSql(db, up),
        down: down ? (db) => execSql(db, down) : null,
    };
}

function loadJsMigration(fullPath, file) {
    delete require.cache[require.resolve(fullPath)];
    const mod = require(fullPath);
    if (typeof mod.up !== 'function') throw new MigrationError(`${file} must export an up(db) function`);
    return {
        transactional: mod.transaction !== false,
        up: (db) => mod.up(db),
        down: typeof mod.down === 'function' ? (db) => mod.down(db) : null,
    };
}

/** Lists migration files in version order with their checksums. */
function loadMigrations(dir = MIGRATIONS_DIR) {
    if (!fs.existsSync(dir)) return [];
    const seen = new Map();
    const migrations = [];
    for (const file of fs.readdirSync(dir).sort()) {
        const match = MIGRATION_FILE_RE.exec(file);
        if (!match) continue;
        const [, version, name, ext] = match;
        if (seen.has(version)) throw new MigrationError(`Duplicate migration version ${version}: ${seen.get(version)} and ${file}`, { version });
        seen.set(version, file);
        const fullPath = path.join(dir, file);
        const source = fs.readFileSync(fullPath, 'utf8');
        migrations.push({
            version,
            name,
            file,
            checksum: sha256(source),
            ...(ext.toLowerCase() === 'sql' ? parseSqlMigration(source, file) : loadJsMigration(fullPath, file)),
        });
    }
    return migrations;
}

// node-postgres runs multi-statement text through query(); PGlite needs exec()
function execSql(db, sql) {
    return typeof db.exec === 'function' ? db.exec(sql) : db.query(sql);
}

async function ensureMigrationsTable(db) {
    await execSql(db, `
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(14) PRIMARY KEY,
            name TEXT NOT NULL,
            checksum CHAR(64) NOT NULL,
            execution_ms INTEGER NOT NULL,
            applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
    `);
}

async function appliedMigrations(db) {
    const { rows } = await db.query('SELECT version, name, checksum, execution_ms, applied_at FROM schema_migrations ORDER BY version');
    return rows.map((row) => ({ ...row, checksum: String(row.checksum).trim() }));
}

/** Compares migration files against schema_migrations. */
async function migrationStatus(db, { dir = MIGRATIONS_DIR, migrations = loadMigrations(dir) } = {}) {
    await ensureMigrationsTable(db);
    const applied = await appliedMigrations(db);
    const byVersion = new Map(applied.map((row) => [row.version, row]));
    const local = new Set(migrations.map((m) => m.version));
    return {
        applied,
        pending: migrations.filter((m) => !byVersion.has(m.version)),
        mismatched: migrations
            .filter((m) => byVersion.has(m.version) && byVersion.get(m.version).checksum !== m.checksum)
            .map((m) => ({ version: m.version, file: m.file, expected: byVersion.get(m.version).checksum, actual: m.checksum })),
        missing: applied.filter((row) => !local.has(row.version)),
    };
}

async function withLock(db, fn) {
    await db.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    try {
        return await fn();
    } finally {
        await db.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
    }
}

async function runStep(db, migration, direction) {
    const run = direction === 'up' ? migration.up : migration.down;
    const started = process.hrtime.bigint();
    const record = async () => {
        if (direction === 'up') {
            const executionMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
            await db.query(
                'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
                [migration.version, migration.name, migration.checksum, executionMs],
            );
        } else {
            await db.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
        }
    };

    if (!migration.transactional) {
        try {
            await run(db);
        } catch (err) {
            throw new MigrationError(`Migration ${migration.file} (${direction}) failed outside a transaction; manual cleanup may be needed: ${err.message}`, { version: migration.version, cause: err });
        }
        await record();
        return;
    }

    await db.query('BEGIN');
    try {
        await run(db);
        await record();
        await db.query('COMMIT');
    } catch (err) {
        await db.query('ROLLBACK');
        throw new MigrationError(`Migration ${migration.file} (${direction}) failed and was rolled back: ${err.message}`, { version: migration.version, cause: err });
    }
}

/**
 * Applies pending migrations in order (all, or the next `steps`). Refuses to
 * run while an applied migration's file has changed, since the database would
 * no longer match what the files describe.
 */
async function migrateUp(db, { dir = MIGRATIONS_DIR, steps = Infinity, log = () => {} } = {}) {
    const migrations = loadMigrations(dir);
    return withLock(db, async () => {
        const status = await migrationStatus(db, { migrations });
        if (status.mismatched.length) throw new SchemaDriftError({ ...status, pending: [], missing: [] });
        const batch = status.pending.slice(0, steps);
        for (const migration of batch) {
            log(`Applying ${migration.file}`);
            await runStep(db, migration, 'up');
        }
        return batch.map((m) => m.version);
    });
}

/** Rolls back the most recently applied migrations (one by default). */
async function migrateDown(db, { dir = MIGRATIONS_DIR, steps = 1, log = () => {} } = {}) {
    const migrations = loadMigrations(dir);
    const byVersion = new Map(migrations.map((m) => [m.version, m]));
    return withLock(db, async () => {
        await ensureMigrationsTable(db);
        const applied = (await appliedMigrations(db)).reverse().slice(0, steps);
        const reverted = [];
        for (const row of applied) {
            const migration = byVersion.get(row.version);
            if (!migration) throw new MigrationError(`Cannot roll back ${row.version}: its migration file is missing`, { version: row.version });
            if (migration.checksum !== row.checksum) {
                throw new MigrationError(`Cannot roll back ${migration.file}: file changed since it was applied`, { version: row.version });
            }
            if (!migration.down) throw new MigrationError(`Cannot roll back ${migration.file}: it has no down migration`, { version: row.version });
            log(`Reverting ${migration.file}`);
            await runStep(db, migration, 'down');
            reverted.push(row.version);
        }
        return reverted;
    });
}

/**
 * Startup guard: throws SchemaDriftError unless every migration is applied
 * with a matching checksum and the database has none this build doesn't know.
 */
async function assertSchemaCurrent(db, { dir = MIGRATIONS_DIR } = {}) {
    const status = await migrationStatus(db, { dir });
    if (status.pending.length || status.mismatched.length || status.missing.length) throw new SchemaDriftError(status);
    return status;
}

/**
 * Pre-flight check run before the API starts serving: connects with
 * `databaseUrl` and throws SchemaDriftError on pending, edited or unknown
 * migrations. Skipped (with a warning) when no direct database URL is set.
 */
async function checkSchemaOnStartup({ databaseUrl = process.env.DATABASE_URL, dir = MIGRATIONS_DIR, logger = console } = {}) {
    if (!databaseUrl) {
        logger.warn('Schema guard skipped: DATABASE_URL is not set');
        return null;
    }
    const { Client } = require('pg');
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    try {
        return await assertSchemaCurrent(db, { dir });
    } finally {
        await db.end();
    }
}

module.exports = {
    MIGRATIONS_DIR,
    MIGRATION_FILE_RE,
    MigrationError,
    SchemaDriftError,
    assertSchemaCurrent,
    checkSchemaOnStartup,
    loadMigrations,
    migrateDown,
    migrateUp,
    migrationStatus,
};
