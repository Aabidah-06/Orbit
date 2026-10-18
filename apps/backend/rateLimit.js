const crypto = require('crypto');

/**
 * Sliding-window-log rate limiter with pluggable storage.
 *
 * Each key keeps the timestamps of its requests inside the last `windowMs`; a request
 * is allowed while fewer than `limit` remain in the window. Unlike a fixed window this
 * never lets 2x `limit` through across a window boundary.
 *
 * Storage:
 *   MemoryStore  per-process log (single instance, tests, Redis fallback)
 *   RedisStore   shared log in a Redis sorted set, so every API instance behind a load
 *                balancer enforces one combined limit. Check-and-record is a single Lua
 *                script, so concurrent requests on different nodes cannot overshoot.
 *   FallbackStore  uses Redis and degrades to a local MemoryStore while Redis is
 *                unreachable, instead of failing open or rejecting every request.
 *
 * `limit` may be a number or `(req) => number | Promise<number>`, which is how the
 * reputation scorer (reputation.js) gives each client its own allowance.
 *
 * Sets the IETF draft headers on every response:
 *   RateLimit-Limit     requests allowed per window
 *   RateLimit-Remaining requests left in the current window
 *   RateLimit-Reset     seconds until the oldest counted request leaves the window
 *                       (i.e. until Remaining next increases)
 *   RateLimit-Policy    "<limit>;w=<window seconds>"
 * plus Retry-After on a 429.
 */

// ---------------------------------------------------------------------------
// Memory store
// ---------------------------------------------------------------------------

class MemoryStore {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.logs = new Map();
        // Small TTL key/value space used by the reputation scorer
        this.values = new Map();
    }

    static prune(timestamps, windowStart) {
        let expired = 0;
        while (expired < timestamps.length && timestamps[expired] <= windowStart) expired++;
        if (expired) timestamps.splice(0, expired);
    }

    // Records a request at `at` if fewer than `limit` are in the window.
    // Returns { allowed, count, oldest } where oldest is the earliest counted timestamp.
    async hit(key, { at, windowMs, limit }) {
        let timestamps = this.logs.get(key);
        if (!timestamps) {
            timestamps = [];
            this.logs.set(key, timestamps);
        }
        MemoryStore.prune(timestamps, at - windowMs);

        const allowed = timestamps.length < limit;
        if (allowed) timestamps.push(at);
        return { allowed, count: timestamps.length, oldest: timestamps.length ? timestamps[0] : null };
    }

    readValue(key) {
        const entry = this.values.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= this.now()) {
            this.values.delete(key);
            return null;
        }
        return entry.value;
    }

    async getMany(keys) {
        return keys.map((key) => this.readValue(key));
    }

    async set(key, value, ttlMs, { onlyIfAbsent = false } = {}) {
        if (onlyIfAbsent && this.readValue(key) !== null) return false;
        this.values.set(key, { value: String(value), expiresAt: this.now() + ttlMs });
        return true;
    }

    // Increments a counter and (re)starts its TTL, so it decays after a quiet period
    async incr(key, ttlMs) {
        const next = Number(this.readValue(key) ?? 0) + 1;
        this.values.set(key, { value: String(next), expiresAt: this.now() + ttlMs });
        return next;
    }

    // Drops idle logs and expired values so long-gone clients do not accumulate
    sweep(windowMs) {
        const at = this.now();
        if (windowMs !== undefined) {
            for (const [key, timestamps] of this.logs) {
                MemoryStore.prune(timestamps, at - windowMs);
                if (!timestamps.length) this.logs.delete(key);
            }
        }
        for (const [key, entry] of this.values) {
            if (entry.expiresAt <= at) this.values.delete(key);
        }
    }

    reset() {
        this.logs.clear();
        this.values.clear();
    }
}

// ---------------------------------------------------------------------------
// Redis store
// ---------------------------------------------------------------------------

// KEYS[1] sorted set of request timestamps; ARGV: now, windowMs, limit, member.
// Returns { allowed (0/1), count, oldest timestamp }.
const SLIDING_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  count = count + 1
  allowed = 1
end
if count > 0 then
  redis.call('PEXPIRE', KEYS[1], window)
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return { allowed, count, oldest[2] or '' }
`;

// KEYS[1] counter; ARGV[1] ttl in ms. Increments and restarts the TTL.
const INCR_TTL_LUA = `
local value = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return value
`;

class RedisStore {
    /**
     * @param client an ioredis client (or anything exposing defineCommand, mget, set, scan, del)
     * @param prefix namespace for every key this store writes
     */
    constructor(client, { prefix = 'orbit:rl:' } = {}) {
        this.client = client;
        this.prefix = prefix;
        if (typeof client.orbitSlidingWindow !== 'function') {
            client.defineCommand('orbitSlidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
        }
        if (typeof client.orbitIncrTtl !== 'function') {
            client.defineCommand('orbitIncrTtl', { numberOfKeys: 1, lua: INCR_TTL_LUA });
        }
    }

    async hit(key, { at, windowMs, limit }) {
        // Unique member so two requests in the same millisecond are both counted
        const member = `${at}:${crypto.randomBytes(6).toString('hex')}`;
        const [allowed, count, oldest] = await this.client.orbitSlidingWindow(
            this.prefix + key, at, windowMs, limit, member,
        );
        return {
            allowed: Number(allowed) === 1,
            count: Number(count),
            oldest: oldest === '' || oldest === null || oldest === undefined ? null : Number(oldest),
        };
    }

    async getMany(keys) {
        if (!keys.length) return [];
        return this.client.mget(...keys.map((key) => this.prefix + key));
    }

    async set(key, value, ttlMs, { onlyIfAbsent = false } = {}) {
        const args = [this.prefix + key, String(value), 'PX', Math.max(1, Math.ceil(ttlMs))];
        if (onlyIfAbsent) args.push('NX');
        return (await this.client.set(...args)) === 'OK';
    }

    async incr(key, ttlMs) {
        return Number(await this.client.orbitIncrTtl(this.prefix + key, Math.max(1, Math.ceil(ttlMs))));
    }

    // Redis expires keys itself
    sweep() {}

    // Deletes every key under this store's prefix (tests and operational resets)
    async reset() {
        let cursor = '0';
        do {
            const [next, keys] = await this.client.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 500);
            cursor = next;
            if (keys.length) await this.client.del(...keys);
        } while (cursor !== '0');
    }
}

// ---------------------------------------------------------------------------
// Fallback store
// ---------------------------------------------------------------------------

/**
 * Sends every operation to `primary` (Redis). When an operation fails the store
 * answers from `fallback` (a local MemoryStore) and skips the primary for
 * `retryAfterMs`, so a Redis outage costs one failed round trip per interval rather
 * than one per request. Limits stay enforced per node during the outage.
 */
class FallbackStore {
    constructor(primary, fallback, { retryAfterMs = 5000, now = Date.now, logger = console } = {}) {
        this.primary = primary;
        this.fallback = fallback;
        this.retryAfterMs = retryAfterMs;
        this.now = now;
        this.logger = logger;
        this.degradedUntil = 0;
    }

    get degraded() {
        return this.now() < this.degradedUntil;
    }

    async call(method, args) {
        if (!this.degraded) {
            try {
                const result = await this.primary[method](...args);
                if (this.degradedUntil) {
                    this.degradedUntil = 0;
                    this.logger.warn?.('Rate limit store recovered; using Redis again');
                }
                return result;
            } catch (err) {
                this.degradedUntil = this.now() + this.retryAfterMs;
                this.logger.error?.(`Rate limit store unavailable, falling back to in-memory limits: ${err.message}`);
            }
        }
        return this.fallback[method](...args);
    }

    hit(...args) { return this.call('hit', args); }
    getMany(...args) { return this.call('getMany', args); }
    set(...args) { return this.call('set', args); }
    incr(...args) { return this.call('incr', args); }

    sweep(...args) { this.fallback.sweep(...args); }

    async reset() {
        this.degradedUntil = 0;
        this.fallback.reset();
        await this.primary.reset();
    }
}

// ---------------------------------------------------------------------------
// Store construction from the environment
// ---------------------------------------------------------------------------

/**
 * Returns a FallbackStore over Redis when REDIS_URL is set, otherwise a MemoryStore.
 * One store (and one Redis connection) is shared by every limiter in the process.
 */
const createStoreFromEnv = ({ env = process.env, logger = console } = {}) => {
    if (!env.REDIS_URL) return new MemoryStore();

    const Redis = require('ioredis');
    const client = new Redis(env.REDIS_URL, {
        // Fail fast while disconnected so the fallback kicks in instead of queueing requests
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: Number(env.REDIS_COMMAND_TIMEOUT_MS) || 250,
        lazyConnect: false,
    });
    client.on('error', (err) => logger.error?.(`Redis error: ${err.message}`));
    client.unref?.();

    const store = new FallbackStore(
        new RedisStore(client, { prefix: env.RATE_LIMIT_REDIS_PREFIX || 'orbit:rl:' }),
        new MemoryStore(),
        { retryAfterMs: Number(env.RATE_LIMIT_REDIS_RETRY_MS) || 5000, logger },
    );
    store.client = client;
    return store;
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const createRateLimiter = ({
    windowMs,
    limit,
    keyGenerator,
    message = "Too many requests, please retry later",
    now = Date.now,
    store = new MemoryStore({ now }),
    // Namespaces this limiter's keys inside a shared store
    name = 'default',
    // Called (and awaited, errors ignored) when a request is rejected
    onLimitReached,
}) => {
    const resolveLimit = typeof limit === 'function' ? limit : () => limit;

    const middleware = async (req, res, next) => {
        const key = keyGenerator(req);
        if (key === undefined || key === null) return next();

        try {
            const effectiveLimit = Math.max(1, Math.floor(await resolveLimit(req)));
            const at = now();
            const { allowed, count, oldest } = await store.hit(`${name}:${key}`, { at, windowMs, limit: effectiveLimit });

            const resetSeconds = oldest !== null ? Math.max(0, Math.ceil((oldest + windowMs - at) / 1000)) : 0;
            res.set({
                'RateLimit-Limit': String(effectiveLimit),
                'RateLimit-Remaining': String(Math.max(0, effectiveLimit - count)),
                'RateLimit-Reset': String(resetSeconds),
                'RateLimit-Policy': `${effectiveLimit};w=${Math.ceil(windowMs / 1000)}`,
            });

            if (!allowed) {
                if (onLimitReached) {
                    try { await onLimitReached(req, key); } catch (err) { console.error("Rate limit hook failed:", err); }
                }
                res.set('Retry-After', String(Math.max(1, resetSeconds)));
                return res.status(429).json({ error: message });
            }
        } catch (err) {
            // Only reachable if the store itself (memory or fallback) throws; do not take the API down
            console.error("Rate limiter error, allowing request:", err);
        }
        next();
    };

    const sweepTimer = setInterval(() => store.sweep(windowMs), windowMs);
    sweepTimer.unref?.();

    middleware.store = store;
    middleware.reset = () => store.reset();
    middleware.sweep = () => store.sweep(windowMs);
    middleware.stop = () => clearInterval(sweepTimer);
    return middleware;
};

module.exports = {
    createRateLimiter,
    createStoreFromEnv,
    MemoryStore,
    RedisStore,
    FallbackStore,
    SLIDING_WINDOW_LUA,
};
