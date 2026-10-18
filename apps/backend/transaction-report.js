'use strict';

const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const COLUMNS = ['transaction_id','subscription_id','plan_id','customer_wallet','amount_usdc_units','status','transaction_hash','settled_at'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return null;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

function parseExportFilters(query) {
    const allowed = new Set(['start_date', 'end_date', 'plan_id', 'status']);
    if (Object.keys(query || {}).some((key) => !allowed.has(key))) throw new Error('Unsupported report filter');
    const start = query?.start_date === undefined ? null : parseDate(query.start_date);
    const end = query?.end_date === undefined ? null : parseDate(query.end_date);
    if (query?.start_date !== undefined && !start) throw new Error('start_date must be YYYY-MM-DD');
    if (query?.end_date !== undefined && !end) throw new Error('end_date must be YYYY-MM-DD');
    if (start && end && start > end) throw new Error('start_date must be on or before end_date');
    if (query?.plan_id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.plan_id)) {
        throw new Error('plan_id must be a UUID');
    }
    if (query?.status !== undefined && query.status !== 'settled') throw new Error('status must be settled');
    return { start, end, planId: query?.plan_id || null, status: query?.status || null };
}

function buildExportQuery(merchantId, filters) {
    // Never interpolate values from HTTP parameters into SQL. No LIMIT / OFFSET:
    // pg-cursor fetches small fixed-size batches, even for millions of rows.
    const values = [merchantId];
    const conditions = ['merchant_id = $1'];
    function bind(expr, value) { values.push(value); conditions.push(`${expr} $${values.length}`); }
    if (filters.start) bind('settled_at >=', filters.start.toISOString());
    if (filters.end) {
        const exclusiveEnd = new Date(filters.end.getTime() + 86_400_000).toISOString();
        bind('settled_at <', exclusiveEnd);
    }
    if (filters.planId) bind('plan_id =', filters.planId);
    if (filters.status) bind('status =', filters.status);
    return {
        text: `SELECT id AS transaction_id, subscription_id, plan_id, customer_wallet_address AS customer_wallet,
                     amount_usdc_units, status, tx_hash AS transaction_hash, settled_at
                 FROM payment_transactions WHERE ${conditions.join(' AND ')}
                 ORDER BY settled_at DESC, id DESC`,
        values,
    };
}

function csvCell(value) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    // Quote all potentially dangerous text values: spreadsheets may otherwise
    // interpret wallet/ID fields as formulas. Numeric amount columns remain numeric.
    if (/^[\s]*[=+@\-]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function toCsvRow(row) { return COLUMNS.map((key) => csvCell(row[key])).join(',') + '\r\n'; }

// Read the amount from the confirmed `funds_pulled` contract event, not from
// an off-chain quote or the mutable plan. The contract transfers the vault's
// amount_per_interval, which can differ from current plan pricing.
function confirmedSettlementAmount(confirmation, { customerWallet, merchantWallet, contractId }) {
    const events = confirmation?.events?.contractEventsXdr;
    if (!Array.isArray(events) || !events.some((group) => group.length)) return null;
    const { scValToNative, StrKey } = require('@stellar/stellar-sdk');
    for (const event of events.flat()) {
        try {
            const issuer = event.contractId();
            if (!issuer || StrKey.encodeContract(issuer) !== contractId) continue;
            const topics = event.body().v0().topics().map(scValToNative);
            if (topics[0] !== 'funds_pulled' || topics[1] !== customerWallet || topics[2] !== merchantWallet) continue;
            const data = scValToNative(event.body().v0().data());
            if (!Array.isArray(data) || data.length !== 2) continue;
            const amount = BigInt(data[0]);
            if (amount < 0n) continue;
            return amount.toString();
        } catch {
            // Unrelated contract events may have different XDR body layouts.
        }
    }
    return null;
}

function cursorRead(cursor, count) {
    return new Promise((resolve, reject) => cursor.read(count, (err, rows) => err ? reject(err) : resolve(rows)));
}
function cursorClose(cursor) {
    return new Promise((resolve) => cursor.close(() => resolve()));
}

async function streamTransactionCsv({ client, cursorFactory, merchantId, filters, output, batchSize = 256 }) {
    const { text, values } = buildExportQuery(merchantId, filters);
    const cursor = client.query(cursorFactory(text, values));
    let cancelled = false;
    const onClose = () => { cancelled = true; };
    output.on('close', onClose);
    async function* batches() {
        yield COLUMNS.join(',') + '\r\n';
        while (!cancelled) {
            const rows = await cursorRead(cursor, batchSize);
            if (!rows.length) return;
            for (const row of rows) yield toCsvRow(row);
        }
    }
    try {
        // Readable.from() honours downstream backpressure, unlike accumulating
        // an array or awaiting an entire Supabase JSON response.
        await pipeline(Readable.from(batches()), new Transform({
            transform(chunk, encoding, callback) { callback(null, chunk); }
        }), output);
    } finally {
        output.off('close', onClose);
        await cursorClose(cursor).catch(() => {});
    }
}

function registerTransactionExportRoute(app, authenticateMerchant, getPool, cursorFactory) {
    app.get('/reports/transactions/export', authenticateMerchant, async (req, res) => {
        let filters;
        try { filters = parseExportFilters(req.query); }
        catch (error) { return res.status(400).json({ error: error.message }); }
        const pool = getPool();
        if (!pool) return res.status(503).json({ error: 'DATABASE_URL is required for streaming reports' });
        let client;
        try { client = await pool.connect(); }
        catch (error) { return res.status(503).json({ error: 'Database connection unavailable' }); }
        res.status(200);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="orbit-transactions.csv"');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
            await streamTransactionCsv({ client, cursorFactory, merchantId: req.merchant.id, filters, output: res });
        } catch (error) {
            console.error('CSV report stream failed:', error);
            if (!res.headersSent) res.status(500).json({ error: 'Failed to generate report' });
            else res.destroy(error);
        } finally {
            client.release();
        }
    });
}

module.exports = { COLUMNS, csvCell, toCsvRow, parseExportFilters, buildExportQuery, confirmedSettlementAmount, streamTransactionCsv, registerTransactionExportRoute };
