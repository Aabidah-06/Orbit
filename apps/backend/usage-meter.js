'use strict';

const Redis = require('ioredis');

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const EVENT_TTL_SECONDS = 48 * 60 * 60;
const INGEST_LUA = `
if redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX') == false then return 0 end
redis.call('HINCRBY', KEYS[2], 'quantity', ARGV[2])
redis.call('HINCRBY', KEYS[2], 'events', 1)
redis.call('HSETNX', KEYS[2], 'merchant_id', ARGV[3])
redis.call('HSETNX', KEYS[2], 'subscription_id', ARGV[4])
redis.call('HSETNX', KEYS[2], 'metric', ARGV[5])
redis.call('HSETNX', KEYS[2], 'window_start', ARGV[6])
redis.call('ZADD', KEYS[3], ARGV[6], KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[3], ARGV[1])
return 1`;

const windowStart = (at) => Math.floor(new Date(at).getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
const safePart = (value) => encodeURIComponent(String(value));

class RedisUsageBuffer {
    constructor(client, { prefix = 'orbit:usage:' } = {}) {
        this.client = client;
        this.prefix = prefix;
        if (typeof client.orbitUsageIngest !== 'function') {
            client.defineCommand('orbitUsageIngest', { numberOfKeys: 3, lua: INGEST_LUA });
        }
    }
    async ingest({ merchantId, subscriptionId, metric, quantity, idempotencyKey, occurredAt }) {
        const bucket = windowStart(occurredAt);
        const aggregateKey = `${this.prefix}window:${bucket}:${safePart(merchantId)}:${safePart(subscriptionId)}:${safePart(metric)}`;
        const accepted = await this.client.orbitUsageIngest(
            `${this.prefix}event:${safePart(merchantId)}:${safePart(idempotencyKey)}`,
            aggregateKey,
            `${this.prefix}windows`,
            EVENT_TTL_SECONDS, quantity, merchantId, subscriptionId, metric, bucket,
        );
        return { accepted: Number(accepted) === 1, windowStart: new Date(bucket).toISOString() };
    }
    async closedWindows(before) {
        const keys = await this.client.zrangebyscore(`${this.prefix}windows`, '-inf', windowStart(before) - 1);
        const rows = [];
        for (const key of keys) {
            const value = await this.client.hgetall(key);
            if (value?.merchant_id) rows.push({ key, ...value, quantity: value.quantity, events: Number(value.events), window_start: new Date(Number(value.window_start)).toISOString() });
        }
        return rows;
    }
    async acknowledge(key) {
        await this.client.multi().del(key).zrem(`${this.prefix}windows`, key).exec();
    }
}

class MemoryUsageBuffer {
    constructor() { this.events = new Set(); this.windows = new Map(); }
    async ingest(input) {
        const eventKey = `${input.merchantId}:${input.idempotencyKey}`;
        const bucket = windowStart(input.occurredAt);
        if (this.events.has(eventKey)) return { accepted: false, windowStart: new Date(bucket).toISOString() };
        this.events.add(eventKey);
        const key = `memory:${bucket}:${input.merchantId}:${input.subscriptionId}:${input.metric}`;
        const row = this.windows.get(key) || { key, merchant_id: input.merchantId, subscription_id: input.subscriptionId, metric: input.metric, window_start: new Date(bucket).toISOString(), quantity: 0, events: 0 };
        row.quantity += input.quantity; row.events += 1; this.windows.set(key, row);
        return { accepted: true, windowStart: row.window_start };
    }
    async closedWindows(before) { const cutoff = windowStart(before); return [...this.windows.values()].filter((row) => Date.parse(row.window_start) < cutoff); }
    async acknowledge(key) { this.windows.delete(key); }
}

async function rollupUsage({ buffer, supabase, now = new Date() }) {
    const windows = await buffer.closedWindows(now);
    let committed = 0;
    for (const row of windows) {
        const { data, error } = await supabase.rpc('commit_usage_window', {
            p_window_key: row.key, p_merchant_id: row.merchant_id, p_subscription_id: row.subscription_id,
            p_metric: row.metric, p_window_start: row.window_start, p_quantity: row.quantity, p_event_count: row.events,
        });
        if (error) throw error;
        await buffer.acknowledge(row.key);
        if (data !== false) committed += 1;
    }
    return { scanned: windows.length, committed };
}

function reconcileUsage(quantity, limit) {
    const consumed = BigInt(quantity);
    const allowance = limit == null ? null : BigInt(limit);
    const remaining = allowance == null ? null : (allowance > consumed ? allowance - consumed : 0n);
    const overage = allowance == null || allowance >= consumed ? 0n : consumed - allowance;
    return { quantity: consumed.toString(), limit: allowance?.toString() ?? null, remaining: remaining?.toString() ?? null, overage: overage.toString(), status: allowance != null && consumed > allowance ? 'over_limit' : 'within_limit' };
}

function createUsageBufferFromEnv(env = process.env) {
    if (!env.REDIS_URL) return null;
    return new RedisUsageBuffer(new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 }), { prefix: env.USAGE_REDIS_PREFIX });
}

function registerUsageRoutes(app, { getSupabase, authenticateMerchant, getBuffer }) {
    const ownershipCache = new Map();
    app.post('/usage-records', authenticateMerchant, async (req, res) => {
        const { subscription_id, metric, quantity, idempotency_key, occurred_at } = req.body || {};
        if (typeof subscription_id !== 'string' || typeof metric !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(metric)
            || !Number.isSafeInteger(quantity) || quantity <= 0 || typeof idempotency_key !== 'string' || idempotency_key.length < 8 || idempotency_key.length > 128
            || (occurred_at && !Number.isFinite(Date.parse(occurred_at)))) return res.status(400).json({ error: 'subscription_id, metric, positive integer quantity and idempotency_key are required' });
        const supabase = getSupabase();
        const buffer = getBuffer();
        if (!supabase || !buffer) return res.status(503).json({ error: 'Usage ingestion requires database and Redis configuration' });
        const ownershipKey = req.merchant.id + ':' + subscription_id;
        let owned = ownershipCache.get(ownershipKey);
        if (!owned || owned.expiresAt <= Date.now()) {
            const { data: subscription, error } = await supabase.from('subscriptions').select('id, plans!inner(merchant_id)').eq('id', subscription_id).eq('plans.merchant_id', req.merchant.id).maybeSingle();
            if (error) throw error;
            if (!subscription) return res.status(404).json({ error: 'Subscription not found' });
            if (ownershipCache.size > 10000) ownershipCache.clear();
            owned = { expiresAt: Date.now() + 300000 };
            ownershipCache.set(ownershipKey, owned);
        }
        const result = await buffer.ingest({ merchantId: req.merchant.id, subscriptionId: subscription_id, metric, quantity, idempotencyKey: idempotency_key, occurredAt: occurred_at || new Date().toISOString() });
        return res.status(result.accepted ? 202 : 200).json({ accepted: result.accepted, duplicate: !result.accepted, window_start: result.windowStart });
    });
    app.get('/usage-reconciliation/:subscriptionId', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(503).json({ error: 'Database not configured' });
        const { data: subscription, error } = await supabase.from('subscriptions').select('id,next_billing_date,plans!inner(merchant_id,usage_metric,usage_limit,interval_seconds)').eq('id', req.params.subscriptionId).eq('plans.merchant_id', req.merchant.id).maybeSingle();
        if (error) throw error;
        if (!subscription) return res.status(404).json({ error: 'Subscription not found' });
        const end = new Date(subscription.next_billing_date);
        const start = new Date(end.getTime() - Number(subscription.plans.interval_seconds) * 1000);
        const { data: rollups, error: rollupError } = await supabase.from('usage_rollups').select('quantity').eq('merchant_id', req.merchant.id).eq('subscription_id', subscription.id).eq('metric', subscription.plans.usage_metric).gte('hour_start', start.toISOString()).lt('hour_start', end.toISOString());
        if (rollupError) throw rollupError;
        const quantity = (rollups || []).reduce((sum, row) => sum + BigInt(row.quantity), 0n);
        res.json({ subscription_id: subscription.id, metric: subscription.plans.usage_metric, period_start: start.toISOString(), period_end: end.toISOString(), ...reconcileUsage(quantity, subscription.plans.usage_limit) });
    });
    app.post('/usage-rollups/run', authenticateMerchant, async (req, res) => {
        const buffer = getBuffer(), supabase = getSupabase();
        if (!buffer || !supabase) return res.status(503).json({ error: 'Usage rollup is not configured' });
        res.json(await rollupUsage({ buffer, supabase }));
    });
}

module.exports = { FIVE_MINUTES_MS, reconcileUsage, windowStart, RedisUsageBuffer, MemoryUsageBuffer, rollupUsage, createUsageBufferFromEnv, registerUsageRoutes };
