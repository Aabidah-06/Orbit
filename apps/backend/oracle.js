// ---------------------------------------------------------------------------
// Fiat <-> USDC exchange rate oracle (#96)
//
// - fetches a certified price feed (CoinGecko) for every supported fiat pair
// - caches timestamped historical rows in the Supabase `exchange_rates` table
//   so a rate quote can always be audited and replayed
// - converts fiat-denominated plan prices into raw USDC units (7 decimals)
//   at the moment of pull
// - enforces a slippage guard: a pull is rejected when the live rate has moved
//   more than SLIPPAGE_TOLERANCE_BPS (2%) away from the subscription's quote
// - exposes a background worker that refreshes the cache on a schedule
// ---------------------------------------------------------------------------

const QUOTE_CURRENCY = 'USDC';
const SUPPORTED_CURRENCIES = ['USD', 'EUR'];
const SUPPORTED_PAIRS = SUPPORTED_CURRENCIES.map((currency) => `${currency}/${QUOTE_CURRENCY}`);
const USDC_DECIMALS = Number(process.env.STELLAR_USDC_DECIMALS) || 7;
// Reject a pull when the rate moved more than 2% from the quoted rate
const SLIPPAGE_TOLERANCE_BPS = Number(process.env.ORACLE_SLIPPAGE_TOLERANCE_BPS) || 200;
const DEFAULT_SYNC_INTERVAL_MS = Number(process.env.ORACLE_SYNC_INTERVAL_MS) || 5 * 60 * 1000;
const RATE_FETCH_TIMEOUT_MS = Number(process.env.ORACLE_FETCH_TIMEOUT_MS) || 6000;
const RATE_SOURCE = 'coingecko';
const COINGECKO_PRICE_URL =
    'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd,eur';

class SlippageError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SlippageError';
        this.details = details;
    }
}

class RateUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RateUnavailableError';
    }
}

const isFiatCurrency = (currency) =>
    SUPPORTED_CURRENCIES.includes(String(currency || '').toUpperCase());

// ---------------------------------------------------------------------------
// Feed access
// ---------------------------------------------------------------------------

// CoinGecko reports how much fiat one USDC costs; the oracle stores the
// inverse (how many USDC are needed for one unit of fiat) so conversion is a
// single multiplication: usdc_units = fiat_amount * rate * 10^decimals.
async function fetchFeedRates(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') {
        throw new RateUnavailableError('No fetch implementation available for the price feed');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RATE_FETCH_TIMEOUT_MS);

    let res;
    try {
        res = await fetchImpl(COINGECKO_PRICE_URL, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller.signal,
        });
    } catch (err) {
        throw new RateUnavailableError(`Price feed request failed: ${err.message || err}`);
    } finally {
        clearTimeout(timeout);
    }

    if (!res || !res.ok) {
        throw new RateUnavailableError(`Price feed request failed with status ${res?.status ?? 'unknown'}`);
    }

    let body;
    try {
        body = await res.json();
    } catch {
        throw new RateUnavailableError('Price feed returned a malformed response');
    }

    const coin = body?.['usd-coin'];
    if (!coin) throw new RateUnavailableError('Price feed response is missing usd-coin quotes');

    const rates = {};
    for (const currency of SUPPORTED_CURRENCIES) {
        const fiatPerUsdc = Number(coin[currency.toLowerCase()]);
        if (!Number.isFinite(fiatPerUsdc) || fiatPerUsdc <= 0) {
            throw new RateUnavailableError(`Price feed is missing a valid ${currency} quote`);
        }
        rates[currency] = 1 / fiatPerUsdc;
    }

    return { rates, source: RATE_SOURCE, fetchedAt: new Date().toISOString() };
}

// Fetches the feed and persists one timestamped historical row per pair.
async function syncRates({ supabase, fetchImpl } = {}) {
    if (!supabase) throw new Error('Supabase client not initialized');

    const { rates, source, fetchedAt } = await fetchFeedRates(fetchImpl);
    const rows = SUPPORTED_CURRENCIES.map((currency) => ({
        base_currency: currency,
        quote_currency: QUOTE_CURRENCY,
        rate: rates[currency],
        source,
        fetched_at: fetchedAt,
    }));

    const { error } = await supabase.from('exchange_rates').insert(rows);
    if (error) throw error;

    return rows;
}

// Latest cached row per supported currency: { USD: { rate, source, fetched_at }, ... }
async function readCachedRates(supabase) {
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase
        .from('exchange_rates')
        .select('*')
        .eq('quote_currency', QUOTE_CURRENCY);
    if (error) throw error;

    const latest = {};
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    for (const row of rows) {
        const currency = String(row?.base_currency || '').toUpperCase();
        if (!SUPPORTED_CURRENCIES.includes(currency)) continue;
        const rate = Number(row.rate);
        if (!Number.isFinite(rate) || rate <= 0) continue;
        const fetchedAt = row.fetched_at || null;
        const previous = latest[currency];
        if (!previous || new Date(fetchedAt || 0) >= new Date(previous.fetched_at || 0)) {
            latest[currency] = { rate, source: row.source || null, fetched_at: fetchedAt };
        }
    }
    return latest;
}

// Cache-first rate lookup; optionally falls back to a live feed sync when the
// currency has never been cached (or the caller asks to refresh).
async function getRate({ supabase, fetchImpl, currency, allowNetwork = true } = {}) {
    const target = String(currency || '').toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(target)) {
        throw new RateUnavailableError(`Unsupported currency: ${currency}`);
    }

    const cached = await readCachedRates(supabase);
    if (cached[target]) return { currency: target, ...cached[target] };

    if (!allowNetwork) return null;

    try {
        const rows = await syncRates({ supabase, fetchImpl });
        const row = rows.find((r) => r.base_currency === target);
        if (row) {
            return {
                currency: target,
                rate: Number(row.rate),
                source: row.source,
                fetched_at: row.fetched_at,
            };
        }
    } catch {
        return null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------------

// Fiat amount -> raw USDC token units (e.g. 20 EUR * 1.05 USDC/EUR = 210000000)
function calculateUsdcUnits({ amount, rate, decimals = USDC_DECIMALS } = {}) {
    const fiatAmount = Number(amount);
    const usdcRate = Number(rate);
    if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) {
        throw new Error('amount must be a positive number');
    }
    if (!Number.isFinite(usdcRate) || usdcRate <= 0) {
        throw new Error('rate must be a positive number');
    }

    const units = Math.round(fiatAmount * usdcRate * 10 ** decimals);
    if (!Number.isSafeInteger(units) || units <= 0) {
        throw new Error('Calculated USDC amount is out of range');
    }
    return units;
}

// Slippage guard: throws when the live rate deviates from the quote by more
// than maxBps (default 2%). A missing/unusable quote compares nothing.
function assertSlippage(currentRate, quotedRate, maxBps = SLIPPAGE_TOLERANCE_BPS) {
    const current = Number(currentRate);
    if (!Number.isFinite(current) || current <= 0) {
        throw new RateUnavailableError('Current exchange rate is invalid');
    }

    const quoted = Number(quotedRate);
    if (!Number.isFinite(quoted) || quoted <= 0) return { move_bps: 0, max_bps: maxBps };

    const moveBps = (Math.abs(current - quoted) / quoted) * 10000;
    // A hair of slack so an exact-boundary move (200 bps) is not rejected by
    // floating-point noise in the division.
    if (moveBps > maxBps + 1e-6) {
        throw new SlippageError(
            `Exchange rate moved ${moveBps.toFixed(0)} bps from the quoted rate, exceeding the ${maxBps} bps slippage tolerance`,
            {
                quoted_rate: quoted,
                current_rate: current,
                move_bps: Math.round(moveBps),
                max_bps: maxBps,
            }
        );
    }
    return { move_bps: Math.round(moveBps), max_bps: maxBps };
}

// Resolves the raw USDC amount owed for a plan right now.
// - USDC plans: returns the stored amount without touching the database.
// - USD/EUR plans: loads the live rate, applies the subscription's slippage
//   guard (when a quote exists) and converts price_amount into USDC units.
// Throws RateUnavailableError when no rate can be resolved and SlippageError
// when the guard rejects the movement.
async function quoteUsdcAmount({
    supabase,
    plan,
    subscription = {},
    fetchImpl,
    allowNetwork = true,
    enforceSlippage = true,
} = {}) {
    if (!plan) throw new RateUnavailableError('Plan is required to quote an amount');

    if (!isFiatCurrency(plan.currency)) {
        return {
            currency: QUOTE_CURRENCY,
            usdc_amount: Number(plan.usdc_amount),
            rate: null,
            quoted_rate: null,
            fetched_at: null,
        };
    }

    const currency = String(plan.currency).toUpperCase();
    const rateInfo = await getRate({ supabase, fetchImpl, currency, allowNetwork });
    if (!rateInfo) {
        throw new RateUnavailableError(`Exchange rate for ${currency}/${QUOTE_CURRENCY} is unavailable`);
    }

    if (enforceSlippage) assertSlippage(rateInfo.rate, subscription.quoted_rate);

    const usdc_amount = calculateUsdcUnits({ amount: plan.price_amount, rate: rateInfo.rate });

    return {
        currency,
        usdc_amount,
        rate: rateInfo.rate,
        quoted_rate: subscription.quoted_rate ?? null,
        fetched_at: rateInfo.fetched_at,
    };
}

// ---------------------------------------------------------------------------
// GET /rates payload: the supported pairs with their newest cached rates.
// Cold caches are refreshed once from the live feed; feed outages degrade to
// `rate: null` so the endpoint can still enumerate the supported pairs.
// ---------------------------------------------------------------------------
async function getSupportedRates({ supabase, fetchImpl } = {}) {
    let cached = await readCachedRates(supabase);
    const missing = SUPPORTED_CURRENCIES.filter((currency) => !cached[currency]);
    if (missing.length) {
        try {
            await syncRates({ supabase, fetchImpl });
            cached = await readCachedRates(supabase);
        } catch {
            // Keep whatever is cached; the scheduled worker will retry later.
        }
    }

    const pairs = SUPPORTED_CURRENCIES.map((currency) => {
        const entry = cached[currency];
        return {
            pair: `${currency}/${QUOTE_CURRENCY}`,
            base: currency,
            quote: QUOTE_CURRENCY,
            rate: entry ? entry.rate : null,
            source: entry ? entry.source : null,
            fetched_at: entry ? entry.fetched_at : null,
            available: Boolean(entry),
        };
    });

    const fetchedTimes = pairs.map((pair) => pair.fetched_at).filter(Boolean).sort();

    return {
        pairs,
        supported_pairs: [...SUPPORTED_PAIRS],
        slippage_tolerance_bps: SLIPPAGE_TOLERANCE_BPS,
        updated_at: fetchedTimes.length ? fetchedTimes[fetchedTimes.length - 1] : null,
    };
}

// ---------------------------------------------------------------------------
// Scheduled background worker
// ---------------------------------------------------------------------------

// Refreshes the exchange_rates cache on a fixed interval. The first sync runs
// immediately so the cache is warm as soon as the API boots.
function startOracleWorker({ supabase, fetchImpl, intervalMs = DEFAULT_SYNC_INTERVAL_MS, onError } = {}) {
    const sync = () =>
        syncRates({ supabase, fetchImpl }).catch((err) => {
            if (typeof onError === 'function') return onError(err);
            console.error('Oracle rate sync failed:', err?.message || err);
            return null;
        });

    sync();
    const timer = setInterval(sync, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
        stop: () => clearInterval(timer),
        sync,
    };
}

module.exports = {
    QUOTE_CURRENCY,
    SUPPORTED_CURRENCIES,
    SUPPORTED_PAIRS,
    USDC_DECIMALS,
    SLIPPAGE_TOLERANCE_BPS,
    DEFAULT_SYNC_INTERVAL_MS,
    RATE_SOURCE,
    SlippageError,
    RateUnavailableError,
    isFiatCurrency,
    fetchFeedRates,
    syncRates,
    readCachedRates,
    getRate,
    calculateUsdcUnits,
    assertSlippage,
    quoteUsdcAmount,
    getSupportedRates,
    startOracleWorker,
};
