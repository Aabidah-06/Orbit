/**
 * Reputation scoring for rate limits.
 *
 * Every client gets a multiplier on its base limit, built from three signals:
 *
 *   IP address    New IPs (first seen less than `ipTrustAfterMs` ago) get `newIpFactor`,
 *                 established ones 1x, and IPs that authenticated as a merchant in the
 *                 last `verifiedTtlMs` get `verifiedIpFactor`. Rotating through fresh
 *                 IPs therefore buys a scraper very little.
 *   Violations    Every 429 from the IP limiter is recorded against the IP. The counter
 *                 decays after `violationTtlMs` without violations; while it is live the
 *                 limit shrinks to 1 / (1 + violations * violationWeight), floored at
 *                 `minFactor`. A client that keeps hammering after a 429 is throttled
 *                 harder the longer it does so.
 *   API key tier  On authenticated routes, `live` keys get `tierFactors.live` and `test`
 *                 keys `tierFactors.test`.
 *   Wallet age    The merchant's Stellar wallet age (account creation time from Horizon)
 *                 scales the per-key limit: younger than `youngWalletMs` gets
 *                 `youngWalletFactor`, older than `matureWalletMs` gets
 *                 `matureWalletFactor`. Unknown age (no Horizon configured, lookup
 *                 failed) is neutral.
 *
 * State lives in the same store as the rate limit logs, so with Redis every node sees
 * the same reputation.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
    ipTrustAfterMs: 10 * 60 * 1000,
    ipFirstSeenTtlMs: 7 * DAY_MS,
    newIpFactor: 0.5,
    verifiedIpFactor: 4,
    verifiedTtlMs: DAY_MS,
    violationTtlMs: 15 * 60 * 1000,
    violationWeight: 0.25,
    minFactor: 0.05,
    tierFactors: { test: 1, live: 3 },
    youngWalletMs: 7 * DAY_MS,
    matureWalletMs: 90 * DAY_MS,
    youngWalletFactor: 0.5,
    matureWalletFactor: 1.5,
    walletLookupTimeoutMs: 1500,
    walletCacheTtlMs: 7 * DAY_MS,
    walletUnknownCacheTtlMs: 10 * 60 * 1000,
};

/**
 * Looks up when a Stellar account was created: the timestamp of its first operation,
 * which is always the create_account that funded it. Resolves to a millisecond
 * timestamp, 'missing' for an account that does not exist, or null when unknown.
 */
const createHorizonWalletLookup = ({ horizonUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULTS.walletLookupTimeoutMs }) =>
    async (address) => {
        const url = `${horizonUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(address)}/operations?order=asc&limit=1`;
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 404) return 'missing';
        if (!response.ok) throw new Error(`Horizon responded ${response.status}`);
        const body = await response.json();
        const createdAt = Date.parse(body?._embedded?.records?.[0]?.created_at);
        return Number.isFinite(createdAt) ? createdAt : null;
    };

const createReputationScorer = ({
    store,
    now = Date.now,
    // (address) => Promise<number | 'missing' | null>; omitted means wallet age is not scored
    walletLookup = null,
    logger = console,
    ...overrides
}) => {
    // Undefined overrides (unset env vars) keep the default
    const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
    const config = { ...DEFAULTS, ...defined, tierFactors: { ...DEFAULTS.tierFactors, ...defined.tierFactors } };
    const keys = {
        firstSeen: (ip) => `rep:ip:first:${ip}`,
        verified: (ip) => `rep:ip:verified:${ip}`,
        violations: (ip) => `rep:ip:violations:${ip}`,
        wallet: (address) => `rep:wallet:${address}`,
    };
    const inflight = new Map();

    const clamp = (factor) => Math.max(config.minFactor, factor);

    // { tier, factor, violations } for an IP; records the IP as seen on first contact
    const scoreIp = async (ip) => {
        const at = now();
        await store.set(keys.firstSeen(ip), at, config.ipFirstSeenTtlMs, { onlyIfAbsent: true });
        const [firstSeenRaw, verified, violationsRaw] = await store.getMany([
            keys.firstSeen(ip), keys.verified(ip), keys.violations(ip),
        ]);
        const firstSeen = Number(firstSeenRaw ?? at);
        const violations = Number(violationsRaw ?? 0);

        let tier;
        let factor;
        if (verified) {
            tier = 'verified';
            factor = config.verifiedIpFactor;
        } else if (at - firstSeen < config.ipTrustAfterMs) {
            tier = 'new';
            factor = config.newIpFactor;
        } else {
            tier = 'established';
            factor = 1;
        }
        if (violations > 0) factor /= 1 + violations * config.violationWeight;
        return { tier, factor: clamp(factor), violations };
    };

    // Account creation timestamp, 'missing', or null. Cached in the store, deduplicated per process.
    const walletCreatedAt = async (address) => {
        if (!walletLookup || !address) return null;
        const [cached] = await store.getMany([keys.wallet(address)]);
        if (cached !== null && cached !== undefined) {
            if (cached === 'unknown') return null;
            return cached === 'missing' ? 'missing' : Number(cached);
        }

        if (!inflight.has(address)) {
            const lookup = (async () => {
                let result = null;
                try {
                    result = await walletLookup(address);
                } catch (err) {
                    logger.error?.(`Wallet age lookup failed for ${address}: ${err.message}`);
                }
                const known = result !== null && result !== undefined;
                await store.set(
                    keys.wallet(address),
                    known ? result : 'unknown',
                    known ? config.walletCacheTtlMs : config.walletUnknownCacheTtlMs,
                );
                return known ? result : null;
            })().finally(() => inflight.delete(address));
            inflight.set(address, lookup);
        }
        return inflight.get(address);
    };

    const walletFactor = (createdAt) => {
        if (createdAt === null) return 1;
        if (createdAt === 'missing') return config.youngWalletFactor;
        const age = now() - createdAt;
        if (age < config.youngWalletMs) return config.youngWalletFactor;
        if (age >= config.matureWalletMs) return config.matureWalletFactor;
        return 1;
    };

    // Limit for the global per-IP limiter
    const ipLimit = (baseLimit) => async (req) => {
        const { factor } = await scoreIp(req.ip);
        return Math.max(1, Math.floor(baseLimit * factor));
    };

    // Limit for authenticated merchant routes: API key tier x wallet age
    const apiKeyLimit = (baseLimit) => async (req) => {
        const tierFactor = config.tierFactors[req.apiKey?.environment] ?? 1;
        const createdAt = await walletCreatedAt(req.merchant?.wallet_address);
        return Math.max(1, Math.floor(baseLimit * tierFactor * walletFactor(createdAt)));
    };

    const recordViolation = (ip) => store.incr(keys.violations(ip), config.violationTtlMs);

    // Middleware for after authentication: the IP has proven it belongs to a merchant
    const markAuthenticated = async (req, res, next) => {
        if (req.ip && req.merchant) {
            try {
                await store.set(keys.verified(req.ip), req.merchant.id ?? '1', config.verifiedTtlMs);
            } catch (err) {
                logger.error?.(`Failed to record verified IP: ${err.message}`);
            }
        }
        next();
    };

    return { config, scoreIp, walletCreatedAt, walletFactor, ipLimit, apiKeyLimit, recordViolation, markAuthenticated };
};

module.exports = { createReputationScorer, createHorizonWalletLookup, REPUTATION_DEFAULTS: DEFAULTS };
