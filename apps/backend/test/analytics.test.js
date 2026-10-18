import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import app from '../index.js';
import analytics from '../analytics.js';

const { makeToken, readToken, verifySep53 } = analytics;
const SECRET = 'an-integration-test-only-secret-with-at-least-32-bytes';
const wallet = Keypair.random();
const merchant = 'b042d621-f45f-441c-ad32-56759d275055';
const origin = 'http://localhost:3000';

function sign(message) {
  const digest = crypto.createHash('sha256').update('Stellar Signed Message:\n' + message).digest();
  return Buffer.from(wallet.sign(digest)).toString('base64');
}

describe('merchant analytics authentication and reporting (#77)', () => {
  beforeEach(() => {
    process.env.ORBIT_ANALYTICS_SESSION_SECRET = SECRET;
    process.env.ORBIT_ANALYTICS_ALLOWED_ORIGIN = origin;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
    delete app.locals.supabase;
  });
  it('verifies SEP-53 signatures and rejects changed messages', () => {
    expect(verifySep53('Orbit test', sign('Orbit test'), wallet.publicKey())).toBe(true);
    expect(verifySep53('Orbit test changed', sign('Orbit test'), wallet.publicKey())).toBe(false);
  });
  it('rejects tampered and expired access tokens', () => {
    const token = makeToken({ merchantId: merchant, walletAddress: wallet.publicKey() }, SECRET, 1000);
    expect(readToken(token, SECRET, 2000)?.sub).toBe(merchant);
    expect(readToken(token, SECRET, 16 * 60 * 1000)).toBeNull();
    expect(readToken(token + 'a', SECRET, 2000)).toBeNull();
  });
  it('never returns analytics without a verified session', async () => {
    const res = await request(app).get('/analytics/overview');
    expect(res.status).toBe(401);
  });
  it('rejects an untrusted challenge origin', async () => {
    const res = await request(app).post('/analytics/challenge').set('Origin', 'https://attacker.example')
      .send({ wallet_address: wallet.publicKey() });
    expect(res.status).toBe(403);
  });
  it('consumes wallet challenges only once and rejects replay', async () => {
    let stored;
    let used = false;
    const mock = {
      from: vi.fn().mockImplementation((table) => {
        if (table === 'merchants') {
          const builder = { select: () => builder, eq: () => builder,
            maybeSingle: async () => ({ data: { id: merchant, wallet_address: wallet.publicKey() }, error: null }) };
          return builder;
        }
        if (table === 'merchant_analytics_challenges') {
          const writer = {
            insert: async rows => { stored = { ...rows[0], used_at: null }; return { error: null }; },
            select: () => writer, eq: () => writer, is: () => writer, gt: () => writer,
            update: () => { writer.pendingUpdate = true; return writer; },
            maybeSingle: async () => {
              if (writer.pendingUpdate) {
                if (used) return { data: null, error: null };
                used = true;
                return { data: { id: stored.id }, error: null };
              }
              return { data: { ...stored, used_at: used ? new Date().toISOString() : null }, error: null };
            },
          };
          return writer;
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    app.locals.supabase = mock;
    const challenge = await request(app).post('/analytics/challenge').set('Origin', origin)
      .send({ wallet_address: wallet.publicKey() });
    expect(challenge.status).toBe(200);
    const signature = sign(challenge.body.message);
    const requestSession = () => request(app).post('/analytics/session').set('Origin', origin)
      .send({ challenge_id: challenge.body.challenge_id, signature });
    const first = await requestSession();
    expect(first.status).toBe(200);
    expect(readToken(first.body.token, SECRET)?.sub).toBe(merchant);
    const replay = await requestSession();
    expect(replay.status).toBe(401);
  });
  it('returns verified merchant metrics from a database RPC, not from client parameters', async () => {
    const mock = {
      from: vi.fn().mockImplementation((table) => {
        if (table !== 'merchants') throw new Error('Unexpected table');
        const builder = { select: () => builder, eq: () => builder,
          maybeSingle: async () => ({ data: { id: merchant }, error: null }) };
        return builder;
      }),
      rpc: vi.fn().mockResolvedValue({ data: {
        active_subscribers: 2, mrr_usdc_units: '580000000', mrr_incomplete: false,
        settled_volume_usdc_units: '150000000', period_settled_usdc_units: '150000000',
        new_subscribers: 1, previous_new_subscribers: 0, points: [],
      }, error: null }),
    };
    app.locals.supabase = mock;
    const token = makeToken({ merchantId: merchant, walletAddress: wallet.publicKey() }, SECRET);
    const res = await request(app).get('/analytics/overview?range=7D')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.mrr_usdc_units).toBe('580000000');
    expect(mock.rpc.mock.calls[0][1].p_merchant_id).toBe(merchant);
    const invalid = await request(app).get('/analytics/overview?range=ALL')
      .set('Authorization', `Bearer ${token}`);
    expect(invalid.status).toBe(400);
  });
});
