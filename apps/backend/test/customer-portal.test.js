import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Keypair, StrKey, Account } from '@stellar/stellar-sdk';
import app from '../index.js';
import portal from '../customer-portal.js';

const alice = Keypair.random();
const bob = Keypair.random();
const merchant = Keypair.random();
const ALICE = alice.publicKey();
const BOB = bob.publicKey();
const M = merchant.publicKey();
const SESSION_SECRET = 'a-long-random-testing-key-that-is-over-32-bytes';

// Small service-role Supabase fake. Each operation applies predicates atomically;
// a consumed challenge cannot be consumed a second time.
function fakeSupabase() {
    const rows = {
        customer_portal_challenges: [], customer_portal_sessions: [],
        subscriptions: [
            { id: '00000000-0000-4000-8000-000000000001', plan_id: 'plan-a', status: 'active',
                customer_wallet_address: ALICE, created_at: '2026-10-01T00:00:00Z',
                plans: { merchants: { wallet_address: M } } },
            { id: '00000000-0000-4000-8000-000000000002', plan_id: 'plan-b', status: 'active',
                customer_wallet_address: BOB, created_at: '2026-10-02T00:00:00Z',
                plans: { merchants: { wallet_address: M } } },
        ],
        customer_portal_receipts: [
            { id: '00000000-0000-4000-8000-000000000011', subscription_id: '00000000-0000-4000-8000-000000000001',
                customer_wallet_address: ALICE, tx_hash: 'a'.repeat(64), created_at: '2026-10-01T00:00:00Z' },
            { id: '00000000-0000-4000-8000-000000000012', subscription_id: '00000000-0000-4000-8000-000000000002',
                customer_wallet_address: BOB, tx_hash: 'b'.repeat(64), created_at: '2026-10-02T00:00:00Z' },
        ],
    };
    const calls = [];
    const from = (table) => {
        calls.push(table);
        let predicates = [], updates = null, offset = 0, end = 999;
        const matching = () => (rows[table] || []).filter(row => predicates.every(fn => fn(row)));
        const query = {
            select: () => query,
            eq: (key, value) => { predicates.push(row => row[key] === value); return query; },
            is: (key, value) => { predicates.push(row => (row[key] ?? null) === value); return query; },
            gt: (key, value) => { predicates.push(row => row[key] > value); return query; },
            order: () => query,
            range: (a, b) => { offset = a; end = b; return query; },
            insert: (row) => { rows[table].push(...(Array.isArray(row) ? row : [row])); return Promise.resolve({ error: null }); },
            update: (value) => { updates = value; return query; },
            maybeSingle: async () => {
                const matches = matching();
                if (updates) matches.forEach(row => Object.assign(row, updates));
                return { data: matches[0] || null, error: null };
            },
            then: (resolve, reject) => Promise.resolve((() => {
                const matches = matching();
                if (updates) matches.forEach(row => Object.assign(row, updates));
                return { data: updates ? matches : matches.slice(offset, end + 1), error: null };
            })()).then(resolve, reject),
        };
        return query;
    };
    return { rows, calls, from };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
async function logIn(keypair) {
    const wallet_address = keypair.publicKey();
    const first = await request(app).post('/customer-portal/auth').send({ wallet_address });
    expect(first.status).toBe(201);
    const signature = Buffer.from(keypair.sign(Buffer.from(first.body.message, 'utf8'))).toString('base64');
    const second = await request(app).post('/customer-portal/auth')
        .send({ wallet_address, challenge_id: first.body.challenge_id, signature });
    expect(second.status).toBe(200);
    return { token: second.body.token, challenge_id: first.body.challenge_id, signature };
}

let originalSecret;
beforeEach(() => {
    originalSecret = process.env.CUSTOMER_PORTAL_JWT_SECRET;
    process.env.CUSTOMER_PORTAL_JWT_SECRET = SESSION_SECRET;
    app.locals.supabase = fakeSupabase();
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
});
afterEach(() => {
    if (originalSecret === undefined) delete process.env.CUSTOMER_PORTAL_JWT_SECRET;
    else process.env.CUSTOMER_PORTAL_JWT_SECRET = originalSecret;
    delete app.locals.supabase;
    delete app.locals.sorobanServer;
    delete process.env.ORBIT_CONTRACT_ID;
});

describe('Customer portal challenge and session (#74)', () => {
    it('generates distinct 256-bit nonces and short-lived challenges', () => {
        const one = portal.makeChallenge(ALICE);
        const two = portal.makeChallenge(ALICE);
        expect(one.message).not.toBe(two.message);
        expect(one.message).toContain(ALICE);
        expect(Date.parse(one.expiresAt) - Date.now()).toBeGreaterThan(295000);
    });
    it('accepts only a real Stellar signature over the complete challenge', () => {
        const { message } = portal.makeChallenge(ALICE);
        const signature = Buffer.from(alice.sign(Buffer.from(message))).toString('base64');
        expect(portal.verifyWalletSignature(ALICE, message, signature)).toBe(true);
        expect(portal.verifyWalletSignature(BOB, message, signature)).toBe(false);
        expect(portal.verifyWalletSignature(ALICE, message + ' changed', signature)).toBe(false);
        expect(portal.verifyWalletSignature(ALICE, message, 'junk')).toBe(false);
    });
    it('rejects tampered or expired JWTs and missing configuration', () => {
        const sid = '00000000-0000-4000-8000-000000000099';
        const token = portal.signSession(ALICE, sid, 1000, SESSION_SECRET);
        expect(portal.verifySession(token, 1200, SESSION_SECRET)?.sub).toBe(ALICE);
        expect(portal.verifySession(token, 1901, SESSION_SECRET)).toBeNull();
        expect(portal.verifySession(token.slice(0, -1) + 'Z', 1001, SESSION_SECRET)).toBeNull();
        delete process.env.CUSTOMER_PORTAL_JWT_SECRET;
        expect(() => portal.signSession(ALICE, sid)).toThrow('CUSTOMER_PORTAL_JWT_SECRET');
    });
    it('enforces single-use challenges and refuses wrong-wallet signatures', async () => {
        const challenge = await request(app).post('/customer-portal/auth').send({ wallet_address: ALICE });
        const wrong = await request(app).post('/customer-portal/auth').send({
            wallet_address: ALICE, challenge_id: challenge.body.challenge_id,
            signature: Buffer.from(bob.sign(Buffer.from(challenge.body.message))).toString('base64'),
        });
        expect(wrong.status).toBe(401);
        const signature = Buffer.from(alice.sign(Buffer.from(challenge.body.message))).toString('base64');
        const payload = { wallet_address: ALICE, challenge_id: challenge.body.challenge_id, signature };
        expect((await request(app).post('/customer-portal/auth').send(payload)).status).toBe(200);
        expect((await request(app).post('/customer-portal/auth').send(payload)).status).toBe(401);
    });
    it('rejects expired challenges', async () => {
        const challenge = await request(app).post('/customer-portal/auth').send({ wallet_address: ALICE });
        app.locals.supabase.rows.customer_portal_challenges[0].expires_at = '2020-01-01T00:00:00Z';
        const signature = Buffer.from(alice.sign(Buffer.from(challenge.body.message))).toString('base64');
        const result = await request(app).post('/customer-portal/auth').send({
            wallet_address: ALICE, challenge_id: challenge.body.challenge_id, signature,
        });
        expect(result.status).toBe(401);
    });
    it('rejects missing session tokens, and isolates subscriptions across wallets', async () => {
        expect((await request(app).get('/customer-portal/subscriptions')).status).toBe(401);
        const { token } = await logIn(alice);
        const res = await request(app).get('/customer-portal/subscriptions').set(auth(token));
        expect(res.status).toBe(200);
        expect(res.body.subscriptions).toHaveLength(1);
        expect(res.body.subscriptions[0].customer_wallet_address).toBe(ALICE);
    });
    it('prevents wallets downloading or enumerating other wallets receipts', async () => {
        const { token } = await logIn(alice);
        const list = await request(app).get('/customer-portal/receipts').set(auth(token));
        expect(list.status).toBe(200);
        expect(list.body.receipts.map(x => x.id)).toEqual(['00000000-0000-4000-8000-000000000011']);
        expect(list.body.receipts[0].transaction_url).toContain('a'.repeat(64));
        const forbidden = await request(app).get('/customer-portal/receipts/00000000-0000-4000-8000-000000000012/download').set(auth(token));
        expect(forbidden.status).toBe(404);
        const own = await request(app).get('/customer-portal/receipts/00000000-0000-4000-8000-000000000011/download').set(auth(token));
        expect(own.status).toBe(200);
        expect(own.headers['content-disposition']).toContain('attachment;');
    });
    it('revokes sessions on logout and blocks subsequent requests', async () => {
        const { token } = await logIn(alice);
        expect((await request(app).post('/customer-portal/logout').set(auth(token))).status).toBe(204);
        expect((await request(app).get('/customer-portal/subscriptions').set(auth(token))).status).toBe(401);
    });
    it('refuses to prepare cancellation for another wallet subscription', async () => {
        const { token } = await logIn(alice);
        const other = await request(app).post('/customer-portal/cancel').set(auth(token))
            .send({ subscription_id: '00000000-0000-4000-8000-000000000002' });
        expect(other.status).toBe(404);
        const bad = await request(app).post('/customer-portal/cancel').set(auth(token))
            .send({ subscription_id: 'nonsense' });
        expect(bad.status).toBe(400);
    });
    it('prepares customer-source cancellation XDR without changing DB state', async () => {
        const { token } = await logIn(alice);
        process.env.ORBIT_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
        app.locals.sorobanServer = {
            getAccount: async wallet => new Account(wallet, '100'),
            prepareTransaction: async tx => tx,
        };
        const result = await request(app).post('/customer-portal/cancel').set(auth(token))
            .send({ subscription_id: '00000000-0000-4000-8000-000000000001' });
        expect(result.status).toBe(200);
        expect(typeof result.body.transaction_xdr).toBe('string');
        expect(result.body.transaction_xdr).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        expect(result.body.customer_wallet_address).toBe(ALICE);
        expect(result.body.message).toContain('not changed');
        expect(app.locals.supabase.rows.subscriptions[0].status).toBe('active');
    });
    it('validates pagination before querying customer records', async () => {
        const { token } = await logIn(alice);
        const result = await request(app).get('/customer-portal/subscriptions?limit=100000').set(auth(token));
        expect(result.status).toBe(400);
    });
});
