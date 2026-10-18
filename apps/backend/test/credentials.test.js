import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../index.js';
import { RevocationList, createCredentialSigner, issueCredential, verifyCredential } from '../credentials.js';
import { verifyCredentialOnline, verifyCredentialToken } from '../credential-verifier.js';
import { createFakeSupabase } from './fakeSupabase.js';
import { makeApiKey } from './helpers.js';

const merchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
const otherMerchantId = '4c4de2b4-7c2b-47ab-95ea-759d88911472';
const subscriptionId = 'a1b2c3d4-0000-4000-8000-000000000001';
const otherSubscriptionId = 'a1b2c3d4-0000-4000-8000-000000000002';
const pastDueSubscriptionId = 'a1b2c3d4-0000-4000-8000-000000000003';
const merchantWallet = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const customerWallet = 'GCUSTOMERWALLETADDRESSFORCREDENTIALTESTS000000000000000000';

const seed = crypto.randomBytes(32).toString('base64');
const signer = createCredentialSigner({ signingKey: seed });
const inThirtyDays = () => new Date(Date.now() + 30 * 86400 * 1000).toISOString();

const subscription = (id, overrides = {}) => ({
    id,
    status: 'active',
    customer_wallet_address: customerWallet,
    next_billing_date: inThirtyDays(),
    plan_id: 'plan-pro',
    plans: { merchant_id: merchantId, name: 'Pro' },
    ...overrides,
});

let db;
let apiKey;

beforeEach(() => {
    apiKey = makeApiKey({ merchantId, walletAddress: merchantWallet });
    db = createFakeSupabase({
        api_keys: [apiKey.row],
        subscriptions: [
            subscription(subscriptionId),
            subscription(otherSubscriptionId, { plans: { merchant_id: otherMerchantId, name: 'Pro' } }),
            subscription(pastDueSubscriptionId, { status: 'past_due' }),
        ],
    }, { unique: { subscription_credentials: [['jti']] } });
    app.locals.supabase = db;
    app.locals.credentialSigner = signer;
    app.locals.credentialRevocations.revoked.clear();
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
});

afterAll(() => {
    delete app.locals.credentialSigner;
    delete app.locals.supabase;
});

const issue = (body) => request(app).post('/credentials').set('Authorization', apiKey.header).send(body);
const verify = (token) => request(app).post('/credentials/verify').send({ token });

// Re-signs a token's claims with a different key, or with modified claims
const forge = (token, mutate, key = crypto.generateKeyPairSync('ed25519').privateKey) => {
    const [h, p] = token.split('.');
    const claims = mutate(JSON.parse(Buffer.from(p, 'base64url').toString()));
    const input = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${input}.${crypto.sign(null, Buffer.from(input), key).toString('base64url')}`;
};

describe('Credential generation (#132)', () => {
    it('issues an Ed25519-signed JWT with anonymized claims for an active subscriber', async () => {
        const res = await issue({ subscription_id: subscriptionId, ttl_seconds: 3600 });
        expect(res.status).toBe(201);

        const [headerB64, payloadB64] = res.body.token.split('.');
        const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
        const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
        expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: signer.kid });
        expect(claims).toMatchObject({ iss: 'orbit', merchant_id: merchantId, plan_tier: 'Pro' });
        expect(claims.valid_until).toBe(claims.iat + 3600);
        expect(claims.exp).toBe(claims.valid_until);

        // The wallet never appears in the token; sub is a stable per-merchant pseudonym
        expect(res.body.token).not.toContain(customerWallet);
        expect(Buffer.from(payloadB64, 'base64url').toString()).not.toContain(customerWallet);
        expect(claims.sub).toBe(signer.subjectFor(merchantId, customerWallet));
        expect(claims.sub).not.toBe(signer.subjectFor(otherMerchantId, customerWallet));

        expect(db.tables.subscription_credentials).toHaveLength(1);
        expect(db.tables.subscription_credentials[0]).toMatchObject({ jti: claims.jti, subscription_id: subscriptionId, subject_hash: claims.sub });
    });

    it('caps validity at the next billing date', async () => {
        const nextBilling = new Date(Date.now() + 600 * 1000);
        db.tables.subscriptions[0].next_billing_date = nextBilling.toISOString();
        const res = await issue({ subscription_id: subscriptionId, ttl_seconds: 86400 });
        expect(res.body.credential.valid_until).toBe(Math.floor(nextBilling.getTime() / 1000));
    });

    it('refuses inactive subscriptions and subscriptions of other merchants', async () => {
        expect((await issue({ subscription_id: pastDueSubscriptionId })).status).toBe(409);
        expect((await issue({ subscription_id: otherSubscriptionId })).status).toBe(404);
        expect((await issue({ subscription_id: 'not-a-uuid' })).status).toBe(400);
        expect((await request(app).post('/credentials').send({ subscription_id: subscriptionId })).status).toBe(401);
    });

    it('returns 503 when no signing key is configured', async () => {
        delete app.locals.credentialSigner;
        const previous = process.env.CREDENTIAL_SIGNING_KEY;
        delete process.env.CREDENTIAL_SIGNING_KEY;
        const res = await verify('a.b.c');
        if (previous !== undefined) process.env.CREDENTIAL_SIGNING_KEY = previous;
        expect(res.status).toBe(503);
    });

    it('loads PKCS#8 PEM keys as well as raw seeds', () => {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        const pemSigner = createCredentialSigner({ signingKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) });
        expect(pemSigner.jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
        expect(() => createCredentialSigner({
            signingKey: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }),
        })).toThrow(/Ed25519/);
    });
});

describe('Signature verification', () => {
    it('validates an authentic credential for an active subscription', async () => {
        const { body } = await issue({ subscription_id: subscriptionId });
        const res = await verify(body.token);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            valid: true,
            claims: { sub: body.credential.sub, merchant_id: merchantId, plan_tier: 'Pro', valid_until: body.credential.valid_until },
        });
    });

    it('rejects tampered claims, foreign keys, truncated signatures and garbage', async () => {
        const { body } = await issue({ subscription_id: subscriptionId });
        const [h, p, s] = body.token.split('.');
        const upgraded = JSON.parse(Buffer.from(p, 'base64url').toString());
        upgraded.plan_tier = 'Enterprise';
        const tampered = `${h}.${Buffer.from(JSON.stringify(upgraded)).toString('base64url')}.${s}`;

        expect((await verify(tampered)).body).toEqual({ valid: false, reason: 'invalid_signature' });
        expect((await verify(forge(body.token, (c) => c))).body.reason).toBe('invalid_signature');
        expect((await verify(`${h}.${p}.${s.slice(0, 20)}`)).body.reason).toBe('invalid_signature');
        expect((await verify('not-a-jwt')).body.reason).toBe('malformed');
        const noneAlg = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.${s}`;
        expect((await verify(noneAlg)).body.reason).toBe('unsupported_algorithm');
    });

    it('rejects expired credentials', async () => {
        const { body } = await issue({ subscription_id: subscriptionId, ttl_seconds: 60 });
        const result = verifyCredentialToken(body.token, { jwks: signer.jwks, now: Date.now() + 61_000 });
        expect(result).toEqual({ valid: false, reason: 'expired' });
    });

    it('rejects validly signed credentials that Orbit never issued', async () => {
        const { body } = await issue({ subscription_id: subscriptionId });
        const unregistered = signer.sign({ ...body.credential, jti: crypto.randomUUID() });
        expect((await verify(unregistered)).body).toEqual({ valid: false, reason: 'unknown_credential' });
    });
});

describe('Revocation', () => {
    it('invalidates credentials immediately when the subscription is cancelled', async () => {
        const { body } = await issue({ subscription_id: subscriptionId });
        expect((await verify(body.token)).body.valid).toBe(true);

        const cancel = await request(app).post(`/subscriptions/${subscriptionId}/cancel`).set('Authorization', apiKey.header).send({});
        expect(cancel.status).toBe(200);

        expect(db.tables.credential_revocations).toHaveLength(1);
        expect(db.tables.credential_revocations[0]).toMatchObject({ jti: body.credential.jti, reason: 'subscription_cancelled' });
        expect((await verify(body.token)).body).toEqual({ valid: false, reason: 'revoked' });
    });

    it('rejects credentials whose subscription lapsed without an explicit revocation', async () => {
        const { body } = await issue({ subscription_id: subscriptionId });
        db.tables.subscriptions[0].status = 'cancelled';
        expect((await verify(body.token)).body).toEqual({ valid: false, reason: 'subscription_inactive' });
        // ...and records the revocation so later checks short-circuit
        expect(app.locals.credentialRevocations.revoked.has(body.credential.jti)).toBe(true);
        expect(db.tables.credential_revocations[0].reason).toBe('subscription_inactive');
    });

    it('persists revocations so other instances honour them', async () => {
        const supabase = createFakeSupabase({ subscriptions: [subscription(subscriptionId)] });
        const { token, claims } = await issueCredential(supabase, signer, { merchantId, subscriptionId });

        const instanceA = new RevocationList();
        const instanceB = new RevocationList();
        await instanceA.revokeSubscription(supabase, subscriptionId, 'subscription_cancelled');
        expect(instanceB.revoked.size).toBe(0);
        expect(await verifyCredential(supabase, signer, instanceB, token)).toEqual({ valid: false, reason: 'revoked' });
        expect(instanceB.revoked.get(claims.jti)).toBe('subscription_cancelled');
    });

    it('lets a merchant revoke a single credential, but not another merchant', async () => {
        const { body } = await issue({ subscription_id: subscriptionId });
        db.tables.subscription_credentials.push({ jti: 'b0000000-0000-4000-8000-000000000000', merchant_id: otherMerchantId, subscription_id: otherSubscriptionId });

        const denied = await request(app).post('/credentials/b0000000-0000-4000-8000-000000000000/revoke').set('Authorization', apiKey.header).send({});
        expect(denied.status).toBe(404);

        const res = await request(app).post(`/credentials/${body.credential.jti}/revoke`).set('Authorization', apiKey.header).send({ reason: 'abuse' });
        expect(res.body).toEqual({ revoked: true, jti: body.credential.jti });
        expect((await verify(body.token)).body.reason).toBe('revoked');
    });
});

describe('Open-source verification helper', () => {
    it('verifies tokens offline against the published JWKS', async () => {
        const { body } = await issue({ subscription_id: subscriptionId });
        const jwks = (await request(app).get('/credentials/jwks')).body;
        expect(jwks).toEqual(signer.jwks);
        expect(jwks.keys[0]).not.toHaveProperty('d');

        const result = verifyCredentialToken(body.token, { jwks });
        expect(result.valid).toBe(true);
        expect(result.claims.plan_tier).toBe('Pro');
        expect(verifyCredentialToken(body.token, { jwks: { keys: [] } })).toEqual({ valid: false, reason: 'unknown_key' });
    });

    it('verifies online through POST /credentials/verify', async () => {
        const { body } = await issue({ subscription_id: subscriptionId });
        const fetchImpl = async (url, init) => {
            const res = await request(app).post(new URL(url).pathname).set('Content-Type', 'application/json').send(init.body);
            return { ok: res.status < 300, status: res.status, json: async () => res.body };
        };
        expect((await verifyCredentialOnline(body.token, { baseUrl: 'https://orbit.test', fetchImpl })).valid).toBe(true);
    });
});
