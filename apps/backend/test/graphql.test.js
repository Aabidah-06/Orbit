import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import app from '../index.js';
import { makeApiKey } from './helpers.js';

const merchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
const planId = 'e0b8e99b-5136-4d1d-9351-91a5db4fb056';
const subId = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';
const otherId = '00000000-0000-4000-8000-000000000000';
const wallet = Keypair.random();
let key, supabase, queries;

beforeEach(() => {
  key = makeApiKey({ merchantId, walletAddress: wallet.publicKey() }); queries = [];
  supabase = { from: vi.fn((table) => {
    const query = { table, filters: [] }; queries.push(query);
    const chain = {};
    for (const method of ['select', 'eq', 'in', 'order', 'range', 'limit']) chain[method] = vi.fn((...args) => { query.filters.push([method, ...args]); return chain; });
    const result = () => {
      const ids = query.filters.find(([m]) => m === 'in')?.[2];
      let data = table === 'merchants' ? [{ id: merchantId, name: 'Merchant', wallet_address: wallet.publicKey() }] :
        table === 'plans' ? [{ id: planId, merchant_id: merchantId, name: 'Pro', usdc_amount: '290000000', interval_seconds: 2592000 }] :
        table === 'subscriptions' ? [subId, '4a7f2e18-6c51-41b9-9cf3-90d1bf379b33'].map((id) => ({ id, plan_id: planId, status: 'past_due', customer_wallet_address: wallet.publicKey(), next_billing_date: '2026-11-01' })) : [];
      if (ids) data = data.filter((row) => ids.includes(row.id));
      for (const [method, column, value] of query.filters) if (method === 'eq' && column === 'id') data = data.filter((row) => row.id === value);
      return { data, count: data.length, error: null };
    };
    chain.then = (resolve, reject) => Promise.resolve(result()).then(resolve, reject);
    chain.maybeSingle = async () => table === 'api_keys' ? { data: key.row } : { data: result().data[0] || null };
    return chain;
  }), rpc: vi.fn(async (name) => ({ data: name === 'merchant_analytics' ? { activeSubscribers: 2, settledPayments: 4, settledAmount: '123000000' } : [] })) };
  app.locals.supabase = supabase;
  app.locals.rateLimiters.ip.reset(); app.locals.rateLimiters.apiKey.reset();
});
afterAll(async () => { await app.locals.graphqlServer.stop(); });
const gql = (query, variables, auth = key.header) => request(app).post('/graphql').set('Authorization', auth).send({ query, variables });

describe('Federated merchant analytics API', () => {
  it('requires a verified merchant identity', async () => {
    const response = await request(app).post('/graphql').send({ query: '{ subscribers { total } }' });
    expect(response.status).toBe(401);
  });
  it('serves nested merchant/subscriber/plan queries with one batched plan lookup', async () => {
    const result = await gql('query($id: ID!) { merchant(id: $id) { name subscriptions { nodes { id plan { name merchant { id } } payments { id } } total } } }', { id: merchantId });
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data.merchant.subscriptions.nodes).toHaveLength(2);
    expect(queries.filter((q) => q.table === 'plans')).toHaveLength(1);
    expect(supabase.rpc).toHaveBeenCalledWith('graphql_subscription_payments', expect.objectContaining({ p_merchant_id: merchantId, p_requests: expect.any(Array) }));
    expect(supabase.rpc.mock.calls[0][1].p_requests).toHaveLength(2);
    expect(queries.find((q) => q.table === 'subscriptions').filters).toContainEqual(['eq', 'plans.merchant_id', merchantId]);
  });
  it('filters and bounds pagination at the database, with stable ordering', async () => {
    const result = await gql('{ subscribers(filter: { status: "past_due" }, pagination: { limit: 10, offset: 20 }) { total limit offset nodes { status } } }');
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data.subscribers).toMatchObject({ limit: 10, offset: 20 });
    expect(queries.find((q) => q.table === 'subscriptions').filters).toEqual(expect.arrayContaining([
      ['range', 20, 29], ['eq', 'status', 'past_due'], ['order', 'id'],
    ]));
    expect((await gql('{ subscribers(pagination: { limit: 101 }) { total } }')).body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });
  it('isolates merchants in direct queries and federation entity references', async () => {
    expect((await gql('query($id: ID!) { merchant(id: $id) { name } }', { id: otherId })).body.data.merchant).toBeNull();
    const result = await gql('query($refs: [_Any!]!) { _entities(representations: $refs) { ... on Merchant { id } } }', { refs: [{ __typename: 'Merchant', id: otherId }] });
    expect(result.body.errors).toBeUndefined(); expect(result.body.data._entities).toEqual([null]);
    const service = await gql('{ _service { sdl } }');
    expect(service.body.data._service.sdl).toContain('@key');
  });
  it('never shares DataLoader caches between requests', async () => {
    await gql('query($id: ID!) { merchant(id: $id) { name } }', { id: merchantId });
    await gql('query($id: ID!) { merchant(id: $id) { name } }', { id: merchantId });
    expect(queries.filter((q) => q.table === 'merchants')).toHaveLength(2);
  });
  it('also caches repeated nested merchant collections instead of querying once per subscriber', async () => {
    const result = await gql('{ subscribers { nodes { plan { merchant { plans { name } payrollSplits { amount } subscriptions { total } } } } } }');
    expect(result.body.errors).toBeUndefined();
    expect(queries.filter((q) => q.table === 'plans')).toHaveLength(2); // one ID batch, one collection page
    expect(queries.filter((q) => q.table === 'tax_transactions')).toHaveLength(1);
    expect(queries.filter((q) => q.table === 'subscriptions')).toHaveLength(1);
  });
  it('aggregates time-bounded analytics in the database', async () => {
    const response = await gql('{ analytics(timeframe: { from: "2026-10-01", to: "2026-11-01" }) { activeSubscribers settledPayments settledAmount } }');
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.analytics.settledAmount).toBe('123000000');
    expect(supabase.rpc).toHaveBeenCalledWith('merchant_analytics', { p_merchant_id: merchantId, p_from: '2026-10-01T00:00:00.000Z', p_to: '2026-11-01T00:00:00.000Z' });
    expect((await gql('{ analytics(timeframe: { from: "invalid", to: "2026-11-01" }) { settledPayments } }')).body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });
  it('accepts a signed Stellar wallet challenge exactly once and rejects forged identities', async () => {
    const challenge = await request(app).post('/auth/wallet/challenge').send({ address: wallet.publicKey() });
    const signature = Buffer.from(wallet.signMessage(challenge.body.message)).toString('base64');
    const auth = `Wallet ${challenge.body.nonce}:${signature}`;
    const response = await gql('{ subscribers { total } }', null, auth);
    expect(response.body.errors).toBeUndefined(); expect(response.status).toBe(200);
    expect((await gql('{ subscribers { total } }', null, auth)).status).toBe(401);
    expect((await gql('{ subscribers { total } }', null, 'Wallet forged:ZmFrZQ==')).status).toBe(401);
  });
  it('rejects a wallet challenge signed by another key or used after expiry', async () => {
    const challenge = await request(app).post('/auth/wallet/challenge').send({ address: wallet.publicKey() });
    const forged = Buffer.from(Keypair.random().signMessage(challenge.body.message)).toString('base64');
    expect((await gql('{ subscribers { total } }', null, `Wallet ${challenge.body.nonce}:${forged}`)).status).toBe(401);
    const expiring = await request(app).post('/auth/wallet/challenge').send({ address: wallet.publicKey() });
    const signature = Buffer.from(wallet.signMessage(expiring.body.message)).toString('base64');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301000);
    try { expect((await gql('{ subscribers { total } }', null, `Wallet ${expiring.body.nonce}:${signature}`)).status).toBe(401); }
    finally { clock.mockRestore(); }
  });
});
