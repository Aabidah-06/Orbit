import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Keypair, StrKey, Account, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import app from '../index.js';
import { makeApiKey } from './helpers.js';
import {
  SUPPORTED_PAIRS,
  USDC_DECIMALS,
  SLIPPAGE_TOLERANCE_BPS,
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
} from '../oracle.js';

const validMerchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
const validPlanId = 'e0b8e99b-5136-4d1d-9351-91a5db4fb056';
const validSubscriptionId = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';
const validStellarAddress = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// CoinGecko reports fiat per USDC; the oracle stores the inverse
const feedBody = { 'usd-coin': { usd: 0.98, eur: 0.92 } };
const feedResponse = (body = feedBody) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const okFeedFetch = () => vi.fn().mockImplementation(async () => feedResponse());

const rateRow = (base, rate, fetchedAt = '2026-10-01T00:00:00.000Z') => ({
  base_currency: base,
  quote_currency: 'USDC',
  rate,
  source: RATE_SOURCE,
  fetched_at: fetchedAt,
});

// Chainable per-table Supabase mock. Awaiting a query resolves that table's
// current rows so rows pushed by insert() are visible to later reads, while
// .single()/.maybeSingle() prefer an explicit per-table override.
const makeSupabase = ({ rows = {}, singles = {}, errors = {} } = {}) => {
  const queries = {};

  const makeQuery = (table) => {
    const resultFor = () =>
      errors[table] ? { data: null, error: errors[table] } : { data: rows[table] ?? [], error: null };
    const singleFor = () => {
      if (errors[table]) return { data: null, error: errors[table] };
      if (singles[table] !== undefined) return { data: singles[table], error: null };
      const list = rows[table] ?? [];
      return { data: Array.isArray(list) ? (list[0] ?? null) : list, error: null };
    };

    const q = {
      select: vi.fn(() => q),
      insert: vi.fn((newRows) => {
        const list = Array.isArray(newRows) ? newRows : [newRows];
        (rows[table] ??= []).push(...list);
        return q;
      }),
      update: vi.fn(() => q),
      delete: vi.fn(() => q),
      eq: vi.fn(() => q),
      gte: vi.fn(() => q),
      lte: vi.fn(() => q),
      order: vi.fn(() => q),
      limit: vi.fn(() => q),
      single: vi.fn(() => Promise.resolve(singleFor())),
      maybeSingle: vi.fn(() => Promise.resolve(singleFor())),
      then: (onFulfilled, onRejected) => Promise.resolve(resultFor()).then(onFulfilled, onRejected),
    };
    return q;
  };

  const from = vi.fn((table) => (queries[table] ??= makeQuery(table)));
  const rpc = vi.fn(async () => ({ data: true, error: null }));

  return { from, rpc, rows, singles, queries };
};

describe('exchange rate calculations', () => {
  it('converts a fiat amount into raw USDC units', () => {
    expect(calculateUsdcUnits({ amount: 20, rate: 1.05 })).toBe(21 * 10 ** USDC_DECIMALS);
    expect(calculateUsdcUnits({ amount: 18, rate: 1.08 })).toBe(Math.round(19.44 * 10 ** USDC_DECIMALS));
  });

  it('rounds results that fall between token sub-units', () => {
    expect(calculateUsdcUnits({ amount: 0.5, rate: 1 })).toBe(0.5 * 10 ** USDC_DECIMALS);
    expect(calculateUsdcUnits({ amount: 1.5, rate: 0.5 })).toBe(0.75 * 10 ** USDC_DECIMALS);
    expect(calculateUsdcUnits({ amount: 2.4, rate: 1, decimals: 0 })).toBe(2);
    expect(calculateUsdcUnits({ amount: 2.5, rate: 1, decimals: 0 })).toBe(3);
  });

  it('honors an explicit decimals override', () => {
    expect(calculateUsdcUnits({ amount: 1, rate: 1, decimals: 2 })).toBe(100);
  });

  it('rejects non-positive or non-numeric inputs', () => {
    expect(() => calculateUsdcUnits({ amount: 0, rate: 1 })).toThrow(/amount/);
    expect(() => calculateUsdcUnits({ amount: 'x', rate: 1 })).toThrow(/amount/);
    expect(() => calculateUsdcUnits({ amount: 1, rate: 0 })).toThrow(/rate/);
    expect(() => calculateUsdcUnits({ amount: 1, rate: null })).toThrow(/rate/);
  });

  it('rejects results outside the safe integer range', () => {
    expect(() => calculateUsdcUnits({ amount: 1e12, rate: 1 })).toThrow(/out of range/);
  });
});

describe('slippage guard', () => {
  it('allows movement up to the 2% tolerance in either direction', () => {
    expect(assertSlippage(1.019, 1.0)).toMatchObject({ move_bps: 190, max_bps: 200 });
    expect(assertSlippage(0.981, 1.0)).toMatchObject({ move_bps: 190, max_bps: 200 });
    expect(assertSlippage(1.02, 1.0).move_bps).toBe(200);
    expect(assertSlippage(0.98, 1.0).move_bps).toBe(200);
  });

  it('rejects movement beyond the tolerance with SlippageError', () => {
    expect(() => assertSlippage(1.021, 1.0)).toThrow(SlippageError);
    expect(() => assertSlippage(0.979, 1.0)).toThrow(SlippageError);
    expect(() => assertSlippage(1.021, 1.0)).toThrow(/exceeding the 200 bps slippage tolerance/);
  });

  it('reports both rates and the move in the error details', () => {
    try {
      assertSlippage(1.05, 1.0);
      throw new Error('expected assertSlippage to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SlippageError);
      expect(err.details).toMatchObject({
        quoted_rate: 1,
        current_rate: 1.05,
        move_bps: 500,
        max_bps: 200,
      });
    }
  });

  it('skips the comparison when the subscription has no quote yet', () => {
    expect(assertSlippage(1.5, null)).toMatchObject({ move_bps: 0 });
    expect(assertSlippage(1.5, undefined).move_bps).toBe(0);
    expect(assertSlippage(1.5, 'not-a-number').move_bps).toBe(0);
  });

  it('rejects an unusable current rate', () => {
    expect(() => assertSlippage(0, 1)).toThrow(RateUnavailableError);
    expect(() => assertSlippage(null, 1)).toThrow(/Current exchange rate is invalid/);
    expect(() => assertSlippage(NaN, 1)).toThrow(RateUnavailableError);
  });
});

describe('currency classification', () => {
  it('treats only supported fiats as convertible', () => {
    expect(isFiatCurrency('USD')).toBe(true);
    expect(isFiatCurrency('eur')).toBe(true);
    expect(isFiatCurrency('USDC')).toBe(false);
    expect(isFiatCurrency('GBP')).toBe(false);
    expect(isFiatCurrency(undefined)).toBe(false);
  });
});

describe('price feed fetch', () => {
  it('requests the feed and stores inverted USDC rates', async () => {
    const fetchMock = okFeedFetch();
    const { rates, source, fetchedAt } = await fetchFeedRates(fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('coingecko.com'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(rates.USD).toBeCloseTo(1 / 0.98, 10);
    expect(rates.EUR).toBeCloseTo(1 / 0.92, 10);
    expect(source).toBe(RATE_SOURCE);
    expect(Number.isNaN(Date.parse(fetchedAt))).toBe(false);
  });

  it('throws RateUnavailableError when the feed responds with an error status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await expect(fetchFeedRates(fetchMock)).rejects.toThrow(RateUnavailableError);
    await expect(fetchFeedRates(fetchMock)).rejects.toThrow(/429/);
  });

  it('throws when the feed response cannot be parsed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    });
    await expect(fetchFeedRates(fetchMock)).rejects.toThrow(/malformed response/);
  });

  it('throws when the feed omits the USDC coin entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(feedResponse({}));
    await expect(fetchFeedRates(fetchMock)).rejects.toThrow(/missing usd-coin/);
  });

  it('throws when a supported currency quote is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(feedResponse({ 'usd-coin': { usd: 0.98 } }));
    await expect(fetchFeedRates(fetchMock)).rejects.toThrow(/valid EUR quote/);
  });

  it('throws when no fetch implementation is available', async () => {
    await expect(fetchFeedRates(null)).rejects.toThrow(/No fetch implementation/);
  });
});

describe('rate cache', () => {
  it('syncRates persists one timestamped row per supported pair', async () => {
    const supabase = makeSupabase();
    const rows = await syncRates({ supabase, fetchImpl: okFeedFetch() });

    expect(rows).toHaveLength(2);
    expect(supabase.queries.exchange_rates.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        base_currency: 'USD',
        quote_currency: 'USDC',
        rate: expect.any(Number),
        source: RATE_SOURCE,
      }),
      expect.objectContaining({ base_currency: 'EUR', quote_currency: 'USDC' }),
    ]);
    const [[inserted]] = supabase.queries.exchange_rates.insert.mock.calls;
    for (const row of inserted) {
      expect(Number.isNaN(Date.parse(row.fetched_at))).toBe(false);
    }
  });

  it('syncRates surfaces write failures', async () => {
    const supabase = makeSupabase({ errors: { exchange_rates: { message: 'write failed' } } });
    await expect(syncRates({ supabase, fetchImpl: okFeedFetch() })).rejects.toMatchObject({
      message: 'write failed',
    });
  });

  it('readCachedRates keeps the newest valid row per currency', async () => {
    const supabase = makeSupabase({
      rows: {
        exchange_rates: [
          rateRow('USD', 1.01, '2026-01-01T00:00:00.000Z'),
          rateRow('USD', 1.03, '2026-01-03T00:00:00.000Z'),
          rateRow('USD', 1.02, '2026-01-02T00:00:00.000Z'),
          rateRow('USD', -1, '2026-01-04T00:00:00.000Z'), // invalid rate is ignored
          { ...rateRow('GBP', 1.2), fetched_at: '2026-01-05T00:00:00.000Z' }, // unsupported base
          rateRow('EUR', 1.09, '2026-01-02T00:00:00.000Z'),
        ],
      },
    });

    const cached = await readCachedRates(supabase);
    expect(cached.USD).toMatchObject({ rate: 1.03, source: RATE_SOURCE });
    expect(cached.EUR).toMatchObject({ rate: 1.09 });
    expect(Object.keys(cached).sort()).toEqual(['EUR', 'USD']);
  });

  it('readCachedRates wraps a single row object', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: rateRow('USD', 1.07) } });
    const cached = await readCachedRates(supabase);
    expect(cached.USD.rate).toBe(1.07);
  });

  it('readCachedRates rejects on a query failure', async () => {
    const supabase = makeSupabase({ errors: { exchange_rates: { message: 'read failed' } } });
    await expect(readCachedRates(supabase)).rejects.toMatchObject({ message: 'read failed' });
  });
});

describe('getRate', () => {
  it('serves the cached rate without touching the feed', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [rateRow('USD', 1.05)] } });
    const fetchMock = okFeedFetch();

    const info = await getRate({ supabase, fetchImpl: fetchMock, currency: 'USD' });

    expect(info).toMatchObject({ currency: 'USD', rate: 1.05, source: RATE_SOURCE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a live sync when the cache is cold', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [] } });
    const fetchMock = okFeedFetch();

    const info = await getRate({ supabase, fetchImpl: fetchMock, currency: 'USD' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(info.rate).toBeCloseTo(1 / 0.98, 10);
    expect(supabase.rows.exchange_rates).toHaveLength(2);
  });

  it('returns null without a network call when the caller allows none', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [] } });
    const fetchMock = okFeedFetch();

    const info = await getRate({
      supabase,
      fetchImpl: fetchMock,
      currency: 'USD',
      allowNetwork: false,
    });

    expect(info).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(supabase.queries.exchange_rates.insert).not.toHaveBeenCalled();
  });

  it('returns null when a live sync fails on a cold cache', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [] } });
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));

    const info = await getRate({ supabase, fetchImpl: fetchMock, currency: 'USD' });

    expect(info).toBeNull();
  });

  it('rejects unsupported currencies', async () => {
    const supabase = makeSupabase();
    await expect(getRate({ supabase, currency: 'GBP' })).rejects.toThrow(RateUnavailableError);
    await expect(getRate({ supabase, currency: 'GBP' })).rejects.toThrow(/Unsupported currency/);
  });
});

describe('scheduled oracle worker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('syncs immediately, then on every interval until stopped', async () => {
    vi.useFakeTimers();
    const supabase = makeSupabase({ rows: { exchange_rates: [] } });
    const fetchMock = okFeedFetch();

    const worker = startOracleWorker({ supabase, fetchImpl: fetchMock, intervalMs: 60000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    worker.stop();
    await vi.advanceTimersByTimeAsync(180000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports sync failures through onError instead of throwing', async () => {
    vi.useFakeTimers();
    const supabase = makeSupabase({ rows: { exchange_rates: [] } });
    const onError = vi.fn();

    const worker = startOracleWorker({
      supabase,
      fetchImpl: vi.fn().mockRejectedValue(new Error('feed down')),
      intervalMs: 60000,
      onError,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(RateUnavailableError);
    worker.stop();
  });
});

describe('quoteUsdcAmount', () => {
  it('returns the stored amount untouched for USDC plans', async () => {
    const supabase = makeSupabase();

    const quote = await quoteUsdcAmount({
      supabase,
      plan: { currency: 'USDC', usdc_amount: 290000000 },
    });

    expect(quote).toMatchObject({ currency: 'USDC', usdc_amount: 290000000, rate: null });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('converts a fiat plan while the rate sits within tolerance of the quote', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [rateRow('USD', 1.05)] } });

    const quote = await quoteUsdcAmount({
      supabase,
      plan: { currency: 'USD', price_amount: 20 },
      subscription: { quoted_rate: 1.04 },
    });

    expect(quote).toMatchObject({
      currency: 'USD',
      usdc_amount: 21 * 10 ** USDC_DECIMALS,
      rate: 1.05,
      quoted_rate: 1.04,
    });
  });

  it('rejects a rate that moved beyond tolerance from the quote', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [rateRow('USD', 1.05)] } });

    await expect(
      quoteUsdcAmount({
        supabase,
        plan: { currency: 'USD', price_amount: 20 },
        subscription: { quoted_rate: 1.0 },
      }),
    ).rejects.toThrow(SlippageError);

    try {
      await quoteUsdcAmount({
        supabase,
        plan: { currency: 'USD', price_amount: 20 },
        subscription: { quoted_rate: 1.0 },
      });
    } catch (err) {
      expect(err.details).toMatchObject({ move_bps: 500, max_bps: SLIPPAGE_TOLERANCE_BPS });
    }
  });

  it('skips the guard when the caller disables it', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [rateRow('USD', 1.05)] } });

    const quote = await quoteUsdcAmount({
      supabase,
      plan: { currency: 'USD', price_amount: 20 },
      subscription: { quoted_rate: 1.0 },
      enforceSlippage: false,
    });

    expect(quote.usdc_amount).toBe(21 * 10 ** USDC_DECIMALS);
  });

  it('rejects when no rate can be resolved', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [] } });
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(
      quoteUsdcAmount({ supabase, fetchImpl: fetchMock, plan: { currency: 'EUR', price_amount: 18 } }),
    ).rejects.toThrow(RateUnavailableError);
    await expect(
      quoteUsdcAmount({ supabase, fetchImpl: fetchMock, plan: { currency: 'EUR', price_amount: 18 } }),
    ).rejects.toThrow(/EUR\/USDC is unavailable/);
  });

  it('rejects when no plan is provided', async () => {
    const supabase = makeSupabase();
    await expect(quoteUsdcAmount({ supabase })).rejects.toThrow(/Plan is required/);
  });
});

describe('getSupportedRates', () => {
  it('enumerates the pairs from the cache without a feed call', async () => {
    const supabase = makeSupabase({
      rows: {
        exchange_rates: [rateRow('USD', 1.05), rateRow('EUR', 1.09, '2026-10-01T01:00:00.000Z')],
      },
    });
    const fetchMock = okFeedFetch();

    const result = await getSupportedRates({ supabase, fetchImpl: fetchMock });

    expect(result.supported_pairs).toEqual(SUPPORTED_PAIRS);
    expect(result.slippage_tolerance_bps).toBe(SLIPPAGE_TOLERANCE_BPS);
    expect(result.updated_at).toBe('2026-10-01T01:00:00.000Z');
    expect(result.pairs).toHaveLength(2);
    expect(result.pairs[0]).toMatchObject({ pair: 'USD/USDC', base: 'USD', quote: 'USDC', rate: 1.05 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes a cold cache once before answering', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [] } });
    const fetchMock = okFeedFetch();

    const result = await getSupportedRates({ supabase, fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(supabase.queries.exchange_rates.insert).toHaveBeenCalledTimes(1);
    expect(result.pairs.every((pair) => pair.available)).toBe(true);
    expect(result.pairs[0].rate).toBeCloseTo(1 / 0.98, 10);
  });

  it('degrades to unavailable pairs when the feed is down and the cache is cold', async () => {
    const supabase = makeSupabase({ rows: { exchange_rates: [] } });
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));

    const result = await getSupportedRates({ supabase, fetchImpl: fetchMock });

    expect(result.supported_pairs).toEqual(SUPPORTED_PAIRS);
    expect(result.pairs.every((pair) => pair.rate === null && pair.available === false)).toBe(true);
    expect(supabase.queries.exchange_rates.insert).not.toHaveBeenCalled();
  });
});

describe('route: GET /rates', () => {
  let supabase;
  let apiKey;

  beforeEach(() => {
    apiKey = makeApiKey({ merchantId: validMerchantId, walletAddress: validStellarAddress });
    supabase = makeSupabase({
      singles: { api_keys: apiKey.row },
      rows: { exchange_rates: [rateRow('USD', 1.05), rateRow('EUR', 1.09, '2026-10-01T02:00:00.000Z')] },
    });
    app.locals.supabase = supabase;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
  });

  afterEach(() => {
    delete app.locals.supabase;
    delete app.locals.fetchImpl;
  });

  it('returns the supported pairs with their cached rates', async () => {
    const res = await request(app).get('/rates');

    expect(res.status).toBe(200);
    expect(res.body.supported_pairs).toEqual(['USD/USDC', 'EUR/USDC']);
    expect(res.body.slippage_tolerance_bps).toBe(SLIPPAGE_TOLERANCE_BPS);
    expect(res.body.updated_at).toBe('2026-10-01T02:00:00.000Z');
    expect(res.body.pairs[0]).toMatchObject({
      pair: 'USD/USDC',
      rate: 1.05,
      source: RATE_SOURCE,
      available: true,
    });
    expect(supabase.queries.exchange_rates.insert).not.toHaveBeenCalled();
  });

  it('refreshes a cold cache from the feed before answering', async () => {
    supabase.rows.exchange_rates = [];
    const fetchMock = okFeedFetch();
    app.locals.fetchImpl = fetchMock;

    const res = await request(app).get('/rates');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(supabase.queries.exchange_rates.insert).toHaveBeenCalledTimes(1);
    expect(res.body.pairs[0]).toMatchObject({ base: 'USD', available: true });
    expect(res.body.pairs[0].rate).toBeCloseTo(1 / 0.98, 10);
  });

  it('degrades to unavailable pairs when the feed is down on a cold cache', async () => {
    supabase.rows.exchange_rates = [];
    app.locals.fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    const res = await request(app).get('/rates');

    expect(res.status).toBe(200);
    expect(res.body.supported_pairs).toEqual(['USD/USDC', 'EUR/USDC']);
    expect(res.body.pairs.every((pair) => pair.rate === null && pair.available === false)).toBe(true);
    expect(res.body.updated_at).toBeNull();
  });

  it('returns 500 when the rate table cannot be read', async () => {
    const failing = makeSupabase({ errors: { exchange_rates: { message: 'read failed' } } });
    app.locals.supabase = failing;

    const res = await request(app).get('/rates');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('read failed');
  });
});

describe('route: POST /plans (fiat pricing)', () => {
  let supabase;
  let apiKey;

  beforeEach(() => {
    apiKey = makeApiKey({ merchantId: validMerchantId, walletAddress: validStellarAddress });
    supabase = makeSupabase({
      singles: {
        api_keys: apiKey.row,
        plans: {
          id: validPlanId,
          merchant_id: validMerchantId,
          name: 'Pro Plan',
          currency: 'USD',
          price_amount: 20,
          usdc_amount: 21 * 10 ** USDC_DECIMALS,
          interval_seconds: 2592000,
        },
      },
      rows: { exchange_rates: [rateRow('USD', 1.05)] },
    });
    app.locals.supabase = supabase;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
  });

  afterEach(() => {
    delete app.locals.supabase;
    delete app.locals.fetchImpl;
  });

  it('creates a fiat plan with a cache-derived USDC estimate', async () => {
    const res = await request(app)
      .post('/plans')
      .set('Authorization', apiKey.header)
      .send({ name: 'Pro Plan', currency: 'USD', price_amount: 20, interval_seconds: 2592000 });

    expect(res.status).toBe(201);
    expect(res.body.plan.usdc_amount).toBe(21 * 10 ** USDC_DECIMALS);
    expect(supabase.queries.plans.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        merchant_id: validMerchantId,
        currency: 'USD',
        price_amount: 20,
        usdc_amount: 21 * 10 ** USDC_DECIMALS,
        interval_seconds: 2592000,
      }),
    ]);
  });

  it('stores 0 and skips the network when the rate cache is cold', async () => {
    supabase.rows.exchange_rates = [];
    const fetchMock = okFeedFetch();
    app.locals.fetchImpl = fetchMock;

    const res = await request(app)
      .post('/plans')
      .set('Authorization', apiKey.header)
      .send({ name: 'Pro Plan', currency: 'USD', price_amount: 20, interval_seconds: 2592000 });

    expect(res.status).toBe(201);
    expect(supabase.queries.plans.insert).toHaveBeenCalledWith([
      expect.objectContaining({ currency: 'USD', usdc_amount: 0 }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a fiat plan without price_amount', async () => {
    const res = await request(app)
      .post('/plans')
      .set('Authorization', apiKey.header)
      .send({ name: 'Pro Plan', currency: 'USD', interval_seconds: 2592000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('price_amount');
    expect(supabase.from).not.toHaveBeenCalledWith('plans');
  });

  it('rejects a non-positive price_amount', async () => {
    const res = await request(app)
      .post('/plans')
      .set('Authorization', apiKey.header)
      .send({ name: 'Pro Plan', currency: 'EUR', price_amount: -1, interval_seconds: 2592000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('price_amount');
  });

  it('rejects an unsupported currency', async () => {
    const res = await request(app)
      .post('/plans')
      .set('Authorization', apiKey.header)
      .send({ name: 'Pro Plan', currency: 'GBP', price_amount: 5, interval_seconds: 2592000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('currency');
  });

  it('still requires usdc_amount for USDC plans', async () => {
    const res = await request(app)
      .post('/plans')
      .set('Authorization', apiKey.header)
      .send({ name: 'Pro Plan', interval_seconds: 2592000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('usdc_amount');
  });
});

describe('route: POST /subscriptions (quote capture)', () => {
  let supabase;
  let apiKey;

  const fiatPlanRow = { id: validPlanId, merchant_id: validMerchantId, currency: 'USD', price_amount: 20, usdc_amount: 0 };

  const setup = (overrides = {}) => {
    apiKey = makeApiKey({ merchantId: validMerchantId, walletAddress: validStellarAddress });
    supabase = makeSupabase({
      singles: {
        api_keys: apiKey.row,
        subscriptions: { id: validSubscriptionId, plan_id: validPlanId, quoted_rate: 1.05 },
      },
      rows: { plans: [fiatPlanRow], exchange_rates: [rateRow('USD', 1.05)] },
      ...overrides,
    });
    app.locals.supabase = supabase;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
  };

  const subscribe = () =>
    request(app)
      .post('/subscriptions')
      .send({ plan_id: validPlanId, customer_wallet_address: validStellarAddress });

  const insertedSubscription = () => supabase.queries.subscriptions.insert.mock.calls[0][0][0];

  beforeEach(() => setup());

  afterEach(() => {
    delete app.locals.supabase;
    delete app.locals.fetchImpl;
  });

  it('captures the quoted rate from the cache at subscribe time', async () => {
    const res = await subscribe();

    expect(res.status).toBe(201);
    expect(insertedSubscription()).toMatchObject({
      plan_id: validPlanId,
      quoted_rate: 1.05,
    });
  });

  it('subscribes without a quote when the rate cache is cold', async () => {
    supabase.rows.exchange_rates = [];
    const fetchMock = okFeedFetch();
    app.locals.fetchImpl = fetchMock;

    const res = await subscribe();

    expect(res.status).toBe(201);
    expect(insertedSubscription()).not.toHaveProperty('quoted_rate');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never quotes USDC plans', async () => {
    supabase.rows.plans = [{ ...fiatPlanRow, currency: 'USDC', usdc_amount: 290000000 }];

    const res = await subscribe();

    expect(res.status).toBe(201);
    expect(insertedSubscription()).not.toHaveProperty('quoted_rate');
    expect(supabase.from).not.toHaveBeenCalledWith('exchange_rates');
  });
});

describe('route: POST /trigger-pull (oracle pricing)', () => {
  const merchantKeypair = Keypair.random();
  let supabase;
  let apiKey;
  let mockServer;

  const fiatSubscription = (overrides = {}) => ({
    id: validSubscriptionId,
    customer_wallet_address: validStellarAddress,
    quoted_rate: 1.04,
    plans: {
      merchant_id: validMerchantId,
      usdc_amount: 0,
      interval_seconds: 2592000,
      currency: 'USD',
      price_amount: 20,
    },
    ...overrides,
  });

  beforeEach(() => {
    process.env.ORBIT_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
    apiKey = makeApiKey({ merchantId: validMerchantId, walletAddress: validStellarAddress });
    apiKey.row.merchants.wallet_address = merchantKeypair.publicKey();

    supabase = makeSupabase({
      singles: { api_keys: apiKey.row, subscriptions: fiatSubscription() },
      rows: { exchange_rates: [rateRow('USD', 1.05)] },
    });
    mockServer = {
      getAccount: vi.fn().mockResolvedValue(new Account(merchantKeypair.publicKey(), '1')),
      prepareTransaction: vi.fn().mockImplementation(async (tx) => tx),
    };

    app.locals.supabase = supabase;
    app.locals.sorobanServer = mockServer;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
  });

  afterEach(() => {
    delete app.locals.supabase;
    delete app.locals.fetchImpl;
    delete app.locals.sorobanServer;
    delete process.env.ORBIT_CONTRACT_ID;
  });

  const trigger = () =>
    request(app)
      .post('/trigger-pull')
      .set('Authorization', apiKey.header)
      .send({ subscription_id: validSubscriptionId });

  const lockAcquires = () =>
    supabase.rpc.mock.calls.filter(([name]) => name === 'acquire_billing_lock');

  it('prices a fiat pull at the live rate and returns the USDC amount', async () => {
    const res = await trigger();

    expect(res.status).toBe(200);
    expect(res.body.usdc_amount).toBe(21 * 10 ** USDC_DECIMALS);
    expect(res.body.currency).toBe('USD');
    expect(res.body.rate).toBe(1.05);
    expect(res.body.transaction_xdr).toBeTruthy();
    expect(mockServer.getAccount).toHaveBeenCalledTimes(1);
  });

  it('stores a baseline quote when the subscription has none', async () => {
    supabase.singles.subscriptions = fiatSubscription();
    delete supabase.singles.subscriptions.quoted_rate;

    const res = await trigger();

    expect(res.status).toBe(200);
    expect(supabase.queries.subscriptions.update).toHaveBeenCalledWith({ quoted_rate: 1.05 });
  });

  it('rejects with 409 when the rate moved beyond the slippage tolerance', async () => {
    supabase.singles.subscriptions = fiatSubscription({ quoted_rate: 1.0 });

    const res = await trigger();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('slippage tolerance');
    expect(res.body).toMatchObject({
      quoted_rate: 1,
      current_rate: 1.05,
      move_bps: 500,
      max_bps: SLIPPAGE_TOLERANCE_BPS,
    });
    expect(mockServer.getAccount).not.toHaveBeenCalled();
    expect(lockAcquires()).toHaveLength(0);
  });

  it('rejects with 503 when no rate can be resolved', async () => {
    supabase.rows.exchange_rates = [];
    app.locals.fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    const res = await trigger();

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('unavailable');
    expect(mockServer.getAccount).not.toHaveBeenCalled();
    expect(lockAcquires()).toHaveLength(0);
  });

  it('returns the stored amount without consulting the oracle for USDC plans', async () => {
    supabase.singles.subscriptions = fiatSubscription({
      quoted_rate: undefined,
      plans: {
        merchant_id: validMerchantId,
        usdc_amount: 290000000,
        interval_seconds: 2592000,
        currency: 'USDC',
      },
    });
    const fetchMock = okFeedFetch();
    app.locals.fetchImpl = fetchMock;

    const res = await trigger();

    expect(res.status).toBe(200);
    expect(res.body.usdc_amount).toBe(290000000);
    expect(res.body.currency).toBe('USDC');
    expect(res.body.rate).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('route: POST /submit-pull (settled amount webhook)', () => {
  const merchantKeypair = Keypair.random();
  let supabase;
  let apiKey;
  let mockServer;
  let fetchSpy;
  let signed_xdr;

  beforeEach(async () => {
    process.env.ORBIT_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
    app.locals.txPollIntervalMs = 1;
    app.locals.txPollTimeoutMs = 100;

    apiKey = makeApiKey({ merchantId: validMerchantId, walletAddress: validStellarAddress });
    apiKey.row.merchants.wallet_address = merchantKeypair.publicKey();

    supabase = makeSupabase({
      singles: {
        api_keys: apiKey.row,
        subscriptions: {
          id: validSubscriptionId,
          customer_wallet_address: validStellarAddress,
          quoted_rate: 1.04,
          plans: {
            merchant_id: validMerchantId,
            usdc_amount: 0,
            interval_seconds: 2592000,
            currency: 'USD',
            price_amount: 20,
          },
        },
      },
      rows: {
        exchange_rates: [rateRow('USD', 1.05)],
        webhooks: [
          {
            id: '6f1d0c6e-0000-4000-8000-000000000001',
            merchant_id: validMerchantId,
            url: 'https://merchant.example/hooks',
            events: ['payment.settled'],
            active: true,
            signing_secret: 'test-secret',
          },
        ],
      },
    });
    mockServer = {
      getAccount: vi.fn().mockResolvedValue(new Account(merchantKeypair.publicKey(), '1')),
      prepareTransaction: vi.fn().mockImplementation(async (tx) => tx),
      sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' }),
      getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    };
    fetchSpy = vi.fn(async (url) => {
      if (String(url).includes('coingecko')) return feedResponse();
      return { ok: true, status: 200, text: async () => '{"ok":true}', json: async () => ({}) };
    });

    app.locals.supabase = supabase;
    app.locals.sorobanServer = mockServer;
    app.locals.fetchImpl = fetchSpy;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();

    const prepared = await request(app)
      .post('/trigger-pull')
      .set('Authorization', apiKey.header)
      .send({ subscription_id: validSubscriptionId });
    expect(prepared.status).toBe(200);
    const tx = TransactionBuilder.fromXDR(prepared.body.transaction_xdr, Networks.TESTNET);
    tx.sign(merchantKeypair);
    signed_xdr = tx.toXDR();
  });

  afterEach(() => {
    delete app.locals.supabase;
    delete app.locals.fetchImpl;
    delete app.locals.sorobanServer;
    delete app.locals.txPollIntervalMs;
    delete app.locals.txPollTimeoutMs;
    delete process.env.ORBIT_CONTRACT_ID;
  });

  it('reports the settled amount converted from the fiat price', async () => {
    const res = await request(app)
      .post('/submit-pull')
      .set('Authorization', apiKey.header)
      .send({ subscription_id: validSubscriptionId, signed_xdr });

    expect(res.status).toBe(200);

    const delivery = fetchSpy.mock.calls.find(([url]) => url === 'https://merchant.example/hooks');
    expect(delivery).toBeTruthy();
    const payload = JSON.parse(delivery[1].body);
    expect(payload.event).toBe('payment.settled');
    expect(payload.amount).toBe(21 * 10 ** USDC_DECIMALS);
    expect(payload.txHash).toBe('deadbeef');
  });

  it('falls back to the stored plan amount when the cache cannot price the fiat amount', async () => {
    supabase.rows.exchange_rates = [];

    const res = await request(app)
      .post('/submit-pull')
      .set('Authorization', apiKey.header)
      .send({ subscription_id: validSubscriptionId, signed_xdr });

    expect(res.status).toBe(200);

    const delivery = fetchSpy.mock.calls.find(([url]) => url === 'https://merchant.example/hooks');
    expect(delivery).toBeTruthy();
    const payload = JSON.parse(delivery[1].body);
    expect(payload.amount).toBe(0); // fiat plan with usdc_amount 0 and no cached rate
  });
});
