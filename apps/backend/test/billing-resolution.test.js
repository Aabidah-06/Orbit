import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { makeApiKey } from './helpers.js';
import { failureDiagnostic } from '../billing-resolution.js';

const merchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
const subId = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';
const planId = 'e0b8e99b-5136-4d1d-9351-91a5db4fb056';
let key, sub, database;
beforeEach(() => {
  delete app.locals.sorobanServer;
  key = makeApiKey({ merchantId, walletAddress: 'merchant-wallet' });
  sub = { id: subId, plan_id: planId, status: 'past_due', plans: { merchant_id: merchantId },
    last_failure: { code: 'expired_allowance', message: 'Token allowance expired' } };
  database = { from: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    single: vi.fn(async () => ({ data: sub })), maybeSingle: vi.fn(async () => ({ data: key.row })),
    rpc: vi.fn(async (name) => ({ data: name === 'waive_subscription_interval' ? { ...sub, status: 'active' } : true })) };
  app.locals.supabase = database; app.locals.rateLimiters.ip.reset(); app.locals.rateLimiters.apiKey.reset();
});
afterAll(async () => { await app.locals.graphqlServer.stop(); });

describe('Past-due resolution API', () => {
  it.each([['insufficient balance', 'insufficient_balance'], ['allowance expired', 'expired_allowance'],
    ['insufficient allowance', 'insufficient_allowance'], ['RPC timed out', 'rpc_timeout'], ['unknown error', 'unknown']])(
    'classifies %s without inventing a diagnosis', (message, code) => { expect(failureDiagnostic(message).code).toBe(code); });

  it('returns persisted diagnostics only to the owning merchant', async () => {
    const result = await request(app).get(`/subscriptions/${subId}/diagnostics`).set('Authorization', key.header);
    expect(result.status).toBe(200); expect(result.body.failure.code).toBe('expired_allowance');
    sub.plans.merchant_id = 'another-merchant';
    expect((await request(app).get(`/subscriptions/${subId}/diagnostics`).set('Authorization', key.header)).status).toBe(404);
    expect((await request(app).get(`/subscriptions/${subId}/diagnostics`)).status).toBe(401);
  });

  it('waives through an atomic database function under a billing lock', async () => {
    const response = await request(app).post(`/subscriptions/${subId}/waive`).set('Authorization', key.header).send({});
    expect(response.status).toBe(200); expect(response.body.subscription.status).toBe('active');
    expect(database.rpc).toHaveBeenCalledWith('waive_subscription_interval', {
      p_subscription_id: subId, p_merchant_id: merchantId, p_actor_address: 'merchant-wallet',
    });
    expect(database.rpc.mock.calls.map(([name]) => name)).toEqual(['acquire_billing_lock', 'waive_subscription_interval', 'release_billing_lock']);
  });

  it('blocks waiver while a signed charge is in flight', async () => {
    database.rpc.mockResolvedValue({ data: false });
    expect((await request(app).post(`/subscriptions/${subId}/waive`).set('Authorization', key.header).send({})).status).toBe(409);
    expect(database.rpc).toHaveBeenCalledTimes(1);
  });

  it('produces a checkout link keyed by the plan, and enforces ownership', async () => {
    const response = await request(app).post(`/subscriptions/${subId}/recovery-link`).set('Authorization', key.header).send({});
    expect(response.status).toBe(200); expect(new URL(response.body.recovery_url).pathname).toBe(`/pay/${planId}`);
    sub.plans.merchant_id = 'another-merchant';
    expect((await request(app).post(`/subscriptions/${subId}/recovery-link`).set('Authorization', key.header).send({})).status).toBe(404);
  });

  it('exposes indexer lag warnings through readiness HTTP status', async () => {
    app.locals.ledgerIndexer = { health: vi.fn(async () => ({ ready: false, ledger_lag: 21, warning: 'Indexer is behind' })) };
    const response = await request(app).get('/health/ready');
    expect(response.status).toBe(503); expect(response.body.ledger_lag).toBe(21);
    app.locals.ledgerIndexer.health.mockResolvedValue({ ready: true, ledger_lag: 0 });
    expect((await request(app).get('/health/ready')).status).toBe(200);
    delete app.locals.ledgerIndexer;
    expect((await request(app).get('/health/ready')).status).toBe(503);
  });
  it('checks only the stored pending hash and reconciles confirmed outcomes', async () => {
    sub.last_failure = { code: 'rpc_timeout', transaction_hash: 'stored-hash' };
    app.locals.sorobanServer = { getTransaction: vi.fn(async () => ({ status: 'NOT_FOUND' })) };
    const check = () => request(app).post(`/subscriptions/${subId}/check-pull`).set('Authorization', key.header).send({ txHash: 'untrusted-hash' });
    expect((await check()).status).toBe(202);
    expect(app.locals.sorobanServer.getTransaction).toHaveBeenCalledWith('stored-hash');
    app.locals.sorobanServer.getTransaction.mockResolvedValue({ status: 'SUCCESS', createdAt: 1790812800 });
    const response = await check();
    expect(response.status).toBe(200); expect(response.body.status).toBe('SUCCESS');
    expect(database.rpc).toHaveBeenCalledWith('resolve_pending_pull', expect.objectContaining({
      p_subscription_id: subId, p_transaction_hash: 'stored-hash', p_succeeded: true,
    }));
    sub.plans.merchant_id = 'another-merchant';
    expect((await check()).status).toBe(404);
    delete app.locals.sorobanServer;
  });
});
