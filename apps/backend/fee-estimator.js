'use strict';

// Stellar fees are integer stroops, not floating point XLM. The bid is bounded
// and must never silently go below the network's minimum per operation.
const MIN_FEE = 100;
const MAX_FEE = 5_000_000;

function feeNumber(value, fallback = MIN_FEE) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function calculateFeeBid(stats, { priority = 'standard', pendingLedgers = 0, maxFee = MAX_FEE } = {}) {
    if (!['standard', 'high'].includes(priority)) throw new Error('Invalid fee priority');
    if (!Number.isInteger(pendingLedgers) || pendingLedgers < 0) throw new Error('Invalid pending ledger count');
    const maximum = feeNumber(maxFee);
    if (maximum < MIN_FEE) throw new Error('Fee cap below network minimum');
    // Horizon fee_stats uses these percentile fields; p95 is preferred for
    // priority transactions, p75 for ordinary ones.
    const charged = stats?.fee_charged ?? stats?.feeCharged ?? {};
    const p50 = feeNumber(charged.p50 ?? stats?.p50);
    const p75 = feeNumber(charged.p75 ?? stats?.p75, p50);
    const p95 = feeNumber(charged.p95 ?? stats?.p95, p75);
    const base = Math.max(MIN_FEE, priority === 'high' ? p95 : p75);
    // A ledger is ~5 seconds. After two unconfirmed ledgers increase the fee
    // on each *new, safely sequenced* attempt; never mutate a signed envelope.
    const exponent = Math.min(8, Math.max(0, pendingLedgers - 1));
    const multiplier = 2 ** exponent;
    return Math.min(maximum, Math.max(MIN_FEE, Math.ceil(base * multiplier)));
}

function createFeeEstimator({ fetchImpl = globalThis.fetch, horizonUrl = 'https://horizon-testnet.stellar.org', cacheMs = 15000, now = Date.now } = {}) {
    let cached = null;
    let expires = 0;
    let inflight = null;
    async function stats() {
        if (cached && now() < expires) return cached;
        if (!inflight) {
            inflight = (async () => {
                const res = await fetchImpl(`${horizonUrl.replace(/\/$/, '')}/fee_stats`, { signal: AbortSignal.timeout(5000) });
                if (!res.ok) throw new Error(`Stellar fee stats HTTP ${res.status}`);
                const data = await res.json();
                if (!data?.fee_charged) throw new Error('Missing fee_charged in Stellar fee stats');
                cached = data;
                expires = now() + cacheMs;
                return data;
            })().finally(() => { inflight = null; });
        }
        return inflight;
    }
    async function estimate(options = {}) {
        try { return calculateFeeBid(await stats(), options); }
        catch (err) {
            if (cached) return calculateFeeBid(cached, options);
            // Network unavailability must not prevent a legitimate transaction.
            return calculateFeeBid(null, options);
        }
    }
    return { stats, estimate };
}

module.exports = { MIN_FEE, MAX_FEE, feeNumber, calculateFeeBid, createFeeEstimator };
