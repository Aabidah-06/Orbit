import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import app from '../index.js';
import { createRateLimiter, MemoryStore, RedisStore, FallbackStore } from '../rateLimit.js';
import { createReputationScorer, createHorizonWalletLookup } from '../reputation.js';
import { createFakeRedis } from './fakeRedis.js';
import { makeApiKey } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const quietLogger = { error: () => {}, warn: () => {} };

// An express app standing in for one backend node; X-Forwarded-For picks the client IP
const makeNode = (limiter, extra = []) => {
  const node = express();
  node.set('trust proxy', true);
  node.use(limiter, ...extra);
  node.get('/plans/:id', (req, res) => res.json({ ok: true }));
  return node;
};

describe('Redis sliding-window store', () => {
  let clock;
  let redis;
  let makeLimiter;

  beforeEach(() => {
    clock = 1_000_000;
    redis = createFakeRedis({ now: () => clock });
    makeLimiter = (limit = 3) => {
      const limiter = createRateLimiter({
        name: 'ip',
        store: new RedisStore(redis),
        windowMs: 10_000,
        limit,
        keyGenerator: (req) => req.ip,
        now: () => clock,
      });
      limiter.stop();
      return limiter;
    };
  });

  const hit = (node, ip = '203.0.113.1') => request(node).get('/plans/1').set('X-Forwarded-For', ip);

  it('enforces one combined limit across cluster nodes', async () => {
    const nodeA = makeNode(makeLimiter());
    const nodeB = makeNode(makeLimiter());

    expect((await hit(nodeA)).headers['ratelimit-remaining']).toBe('2');
    expect((await hit(nodeB)).headers['ratelimit-remaining']).toBe('1');
    expect((await hit(nodeA)).headers['ratelimit-remaining']).toBe('0');

    const blocked = await hit(nodeB);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['ratelimit-limit']).toBe('3');
    expect(blocked.headers['retry-after']).toBe('10');
    expect(redis.calls.filter((name) => name === 'orbitSlidingWindow')).toHaveLength(4);
  });

  it('slides the window one request at a time', async () => {
    const node = makeNode(makeLimiter());
    await hit(node);
    clock += 4_000;
    await hit(node); await hit(node);
    const blocked = await hit(node);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['ratelimit-reset']).toBe('6');

    // Only the first request has left the window
    clock += 6_001;
    expect((await hit(node)).status).toBe(200);
    expect((await hit(node)).status).toBe(429);
  });

  it('does not let a burst through across a window boundary', async () => {
    const node = makeNode(makeLimiter());
    clock += 9_000;
    await hit(node); await hit(node); await hit(node);
    clock += 2_000;
    expect((await hit(node)).status).toBe(429);
  });

  it('keeps clients and limiters independent and does not count rejections', async () => {
    const node = makeNode(makeLimiter(1));
    expect((await hit(node, '203.0.113.1')).status).toBe(200);
    expect((await hit(node, '203.0.113.1')).status).toBe(429);
    expect((await hit(node, '203.0.113.2')).status).toBe(200);

    clock += 10_001;
    expect((await hit(node, '203.0.113.1')).headers['ratelimit-remaining']).toBe('0');
    expect((await hit(node, '203.0.113.1')).status).toBe(429);
  });

  it('resets only its own prefix', async () => {
    const limiter = makeLimiter(1);
    const node = makeNode(limiter);
    await redis.set('other:key', 'x');
    await hit(node);
    await limiter.reset();
    expect((await hit(node)).status).toBe(200);
    expect(await redis.mget('other:key')).toEqual(['x']);
  });
});

describe('Redis fallback', () => {
  let clock;
  let redis;
  let store;
  let node;

  beforeEach(() => {
    clock = 1_000_000;
    redis = createFakeRedis({ now: () => clock });
    store = new FallbackStore(new RedisStore(redis), new MemoryStore({ now: () => clock }), {
      retryAfterMs: 5_000, now: () => clock, logger: quietLogger,
    });
    const limiter = createRateLimiter({
      store, windowMs: 10_000, limit: 2, keyGenerator: (req) => req.ip, now: () => clock,
    });
    limiter.stop();
    node = makeNode(limiter);
  });

  const hit = () => request(node).get('/plans/1').set('X-Forwarded-For', '203.0.113.1');

  it('keeps enforcing limits in memory while Redis is down', async () => {
    redis.failing = true;
    const first = await hit();
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    await hit();
    expect((await hit()).status).toBe(429);
    expect(store.degraded).toBe(true);
  });

  it('skips Redis during the back-off and returns to it afterwards', async () => {
    redis.failing = true;
    await hit();
    const attempts = redis.calls.length;
    await hit();
    expect(redis.calls.length).toBe(attempts);

    redis.failing = false;
    clock += 5_001;
    const res = await hit();
    expect(res.status).toBe(200);
    expect(store.degraded).toBe(false);
    // Back on Redis, which has not seen the requests counted locally during the outage
    expect(res.headers['ratelimit-remaining']).toBe('1');
  });

  it('allows the request if even the fallback fails', async () => {
    const broken = { hit: () => { throw new Error('boom'); }, sweep() {}, reset() {} };
    const limiter = createRateLimiter({ store: broken, windowMs: 1000, limit: 1, keyGenerator: () => 'k' });
    limiter.stop();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(makeNode(limiter)).get('/plans/1')).status).toBe(200);
    spy.mockRestore();
  });
});

describe('Reputation scoring', () => {
  let clock;
  let store;
  let reputation;

  const build = (options = {}) => {
    store = new MemoryStore({ now: () => clock });
    reputation = createReputationScorer({ store, now: () => clock, logger: quietLogger, ...options });
  };

  beforeEach(() => {
    clock = 50 * DAY_MS;
    build();
  });

  it('gives new IPs a reduced limit until they are established', async () => {
    const limitFor = reputation.ipLimit(100);
    expect(await limitFor({ ip: '198.51.100.1' })).toBe(50);
    clock += 10 * 60 * 1000;
    expect(await limitFor({ ip: '198.51.100.1' })).toBe(100);
    // A different, fresh IP is still new
    expect(await limitFor({ ip: '198.51.100.2' })).toBe(50);
  });

  it('raises the IP limit after it authenticates as a merchant', async () => {
    const req = { ip: '198.51.100.1', merchant: { id: 'm1' } };
    const next = vi.fn();
    await reputation.markAuthenticated(req, {}, next);
    expect(next).toHaveBeenCalled();
    expect(await reputation.ipLimit(100)(req)).toBe(400);
    expect((await reputation.scoreIp(req.ip)).tier).toBe('verified');
  });

  it('shrinks the limit with each violation and lets it decay', async () => {
    const limitFor = reputation.ipLimit(100);
    await reputation.scoreIp('198.51.100.1');
    clock += 10 * 60 * 1000;
    expect(await limitFor({ ip: '198.51.100.1' })).toBe(100);

    for (let i = 0; i < 4; i++) await reputation.recordViolation('198.51.100.1');
    expect(await limitFor({ ip: '198.51.100.1' })).toBe(50);
    for (let i = 0; i < 400; i++) await reputation.recordViolation('198.51.100.1');
    expect(await limitFor({ ip: '198.51.100.1' })).toBe(5); // floored at minFactor

    clock += 15 * 60 * 1000 + 1;
    expect(await limitFor({ ip: '198.51.100.1' })).toBe(100);
  });

  it('scales the API key limit by tier and wallet age', async () => {
    const ages = { OLD: clock - 365 * DAY_MS, MID: clock - 30 * DAY_MS, NEW: clock - DAY_MS, GONE: 'missing' };
    build({ walletLookup: async (address) => ages[address] ?? null });
    const limitFor = reputation.apiKeyLimit(100);
    const req = (environment, wallet) => ({ apiKey: { environment }, merchant: { wallet_address: wallet } });

    expect(await limitFor(req('test', 'MID'))).toBe(100);
    expect(await limitFor(req('live', 'MID'))).toBe(300);
    expect(await limitFor(req('live', 'OLD'))).toBe(450);
    expect(await limitFor(req('live', 'NEW'))).toBe(150);
    expect(await limitFor(req('test', 'GONE'))).toBe(50);
    expect(await limitFor(req('test', 'UNKNOWN'))).toBe(100);
  });

  it('caches wallet lookups and treats failures as neutral', async () => {
    const walletLookup = vi.fn().mockRejectedValue(new Error('Horizon responded 503'));
    build({ walletLookup });
    const req = { apiKey: { environment: 'test' }, merchant: { wallet_address: 'GABC' } };

    expect(await reputation.apiKeyLimit(100)(req)).toBe(100);
    expect(await reputation.apiKeyLimit(100)(req)).toBe(100);
    expect(walletLookup).toHaveBeenCalledTimes(1);

    walletLookup.mockResolvedValue(clock - DAY_MS);
    clock += 10 * 60 * 1000 + 1;
    expect(await reputation.apiKeyLimit(100)(req)).toBe(50);
    expect(walletLookup).toHaveBeenCalledTimes(2);
  });

  it('reads the account creation time from Horizon', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ _embedded: { records: [{ created_at: '2025-01-02T03:04:05Z' }] } }) })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    const lookup = createHorizonWalletLookup({ horizonUrl: 'https://horizon.example/', fetchImpl });

    expect(await lookup('GABC')).toBe(Date.parse('2025-01-02T03:04:05Z'));
    expect(fetchImpl.mock.calls[0][0]).toBe('https://horizon.example/accounts/GABC/operations?order=asc&limit=1');
    expect(await lookup('GNONE')).toBe('missing');
  });

  it('throttles an aggressive scraper harder the longer it keeps going', async () => {
    const limiter = createRateLimiter({
      name: 'ip', store, windowMs: 60_000, now: () => clock,
      limit: reputation.ipLimit(20),
      keyGenerator: (req) => req.ip,
      onLimitReached: (req) => reputation.recordViolation(req.ip),
    });
    limiter.stop();
    const node = makeNode(limiter);
    const hit = (ip) => request(node).get('/plans/1').set('X-Forwarded-For', ip);

    // New IP: half of 20
    const statuses = [];
    for (let i = 0; i < 14; i++) statuses.push((await hit('192.0.2.66')).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);

    // Once its first requests leave the window it would normally get 20, but the 429s count against it
    clock += 11 * 60 * 1000;
    const res = await hit('192.0.2.66');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('10');

    // A well-behaved neighbour is unaffected
    expect((await hit('192.0.2.7')).headers['ratelimit-limit']).toBe('10');
  });
});

describe('Rate limit headers on API routes', () => {
  const merchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
  const wallet = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  let mockSupabase;

  beforeEach(() => {
    mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
      maybeSingle: vi.fn(),
    };
    app.locals.supabase = mockSupabase;
    app.locals.rateLimiters.ip.reset();
    delete app.locals.walletLookup;
  });

  afterAll(() => {
    delete app.locals.walletLookup;
  });

  const expectHeaders = (res) => {
    expect(res.headers['ratelimit-limit']).toMatch(/^\d+$/);
    expect(res.headers['ratelimit-remaining']).toMatch(/^\d+$/);
    expect(res.headers['ratelimit-reset']).toMatch(/^\d+$/);
  };

  it('sets RateLimit headers on public, unknown and invalid requests', async () => {
    const plan = await request(app).get('/plans/00000000-0000-4000-8000-000000000000');
    expect(plan.status).toBe(404);
    expectHeaders(plan);
    // Fresh IP: half of the default 300
    expect(plan.headers['ratelimit-limit']).toBe('150');

    expectHeaders(await request(app).post('/subscriptions').send({}));
    expectHeaders(await request(app).get('/no-such-route'));
  });

  it('grants authenticated merchants more throughput by tier and wallet age', async () => {
    const apiKey = makeApiKey({ merchantId, walletAddress: wallet, environment: 'live' });
    mockSupabase.maybeSingle.mockResolvedValue({ data: apiKey.row, error: null });
    mockSupabase.order = vi.fn().mockResolvedValue({ data: [], error: null });
    app.locals.walletLookup = vi.fn().mockResolvedValue(Date.now() - 365 * DAY_MS);

    const authed = await request(app).get('/subscribers').set('Authorization', apiKey.header);
    // Live key (3x) on a mature wallet (1.5x) of the default 100
    expect(authed.headers['ratelimit-limit']).toBe('450');
    expect(app.locals.walletLookup).toHaveBeenCalledWith(wallet);

    // The IP is now known to belong to a merchant, so public routes allow 4x the default 300
    const plan = await request(app).get('/plans/00000000-0000-4000-8000-000000000000');
    expect(plan.headers['ratelimit-limit']).toBe('1200');
  });
});

// Runs the real Lua scripts; start Redis and set REDIS_TEST_URL to include it
describe.skipIf(!process.env.REDIS_TEST_URL)('RedisStore against a live Redis', () => {
  it('shares one sliding window between two connections', async () => {
    const { default: Redis } = await import('ioredis');
    const prefix = `orbit:rl:test:${Date.now()}:`;
    const clientA = new Redis(process.env.REDIS_TEST_URL);
    const clientB = new Redis(process.env.REDIS_TEST_URL);
    const storeA = new RedisStore(clientA, { prefix });
    const storeB = new RedisStore(clientB, { prefix });
    try {
      const at = 1_000_000;
      const opts = (offset) => ({ at: at + offset, windowMs: 10_000, limit: 2 });
      expect(await storeA.hit('k', opts(0))).toEqual({ allowed: true, count: 1, oldest: at });
      expect(await storeB.hit('k', opts(1))).toEqual({ allowed: true, count: 2, oldest: at });
      expect(await storeA.hit('k', opts(2))).toEqual({ allowed: false, count: 2, oldest: at });
      // The first request leaves the window exactly windowMs later
      expect(await storeB.hit('k', opts(10_000))).toEqual({ allowed: true, count: 2, oldest: at + 1 });

      expect(await storeA.incr('v', 60_000)).toBe(1);
      expect(await storeB.incr('v', 60_000)).toBe(2);
      expect(await storeA.set('n', 'x', 60_000, { onlyIfAbsent: true })).toBe(true);
      expect(await storeB.set('n', 'y', 60_000, { onlyIfAbsent: true })).toBe(false);
      expect(await storeB.getMany(['v', 'n', 'missing'])).toEqual(['2', 'x', null]);
    } finally {
      await storeA.reset();
      await Promise.all([clientA.quit(), clientB.quit()]);
    }
  });
});
