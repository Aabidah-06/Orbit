import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import app from '../index.js';
import { makeApiKey } from './helpers.js';

describe('Legacy subscription routes require owner authorization (#74)', () => {
  const merchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
  const otherId = '00000000-0000-4000-8000-000000000000';
  const subscriptionId = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';
  let apiKey;
  let db;

  beforeEach(() => {
    apiKey = makeApiKey({ merchantId, walletAddress: Keypair.random().publicKey() });
    db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: subscriptionId, status: 'active', plans: { merchant_id: otherId } },
        error: null,
      }),
      maybeSingle: vi.fn().mockResolvedValue({ data: apiKey.row, error: null }),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    app.locals.supabase = db;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
  });

  afterEach(() => { delete app.locals.supabase; });

  const endpoints = [
    { method: 'get', path: 'timeline' },
    { method: 'post', path: 'cancel' },
    { method: 'post', path: 'refund' },
    { method: 'post', path: 'recovery-link' },
  ];

  for (const { method, path } of endpoints) {
    it(`${method.toUpperCase()} ${path} denies anonymous callers`, async () => {
      const res = await request(app)[method](`/subscriptions/${subscriptionId}/${path}`);
      expect(res.status).toBe(401);
      expect(db.single).not.toHaveBeenCalled();
    });

    it(`${method.toUpperCase()} ${path} denies another merchant without leaking the record`, async () => {
      const res = await request(app)[method](`/subscriptions/${subscriptionId}/${path}`)
        .set('Authorization', apiKey.header);
      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });
  }

  it('allows the owning merchant to read its own timeline', async () => {
    db.single.mockResolvedValue({
      data: { id: subscriptionId, status: 'active', customer_wallet_address: Keypair.random().publicKey(),
        created_at: '2026-10-01T00:00:00Z', plans: { merchant_id: merchantId, name: 'Plan' } },
      error: null,
    });
    const res = await request(app).get(`/subscriptions/${subscriptionId}/timeline`)
      .set('Authorization', apiKey.header);
    expect(res.status).toBe(200);
    expect(res.body.subscription.id).toBe(subscriptionId);
  });
});
