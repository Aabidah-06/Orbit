'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { CREDENTIAL_TYPE, ISSUER, verifyCredentialToken } = require('./credential-verifier');

// Privacy-preserving subscription credentials (#132): Ed25519-signed JWTs a
// merchant hands to a subscriber so third-party services can check the
// subscriber's tier without database access or the raw wallet address.

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
// Ed25519 PKCS#8 DER prefix; appending a 32-byte seed yields a private key
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const issueSchema = z.object({
    subscription_id: z.string().uuid(),
    ttl_seconds: z.number().int().min(60).max(MAX_TTL_SECONDS).optional(),
}).strict();
const verifySchema = z.object({ token: z.string().min(1).max(4096) }).strict();
const revokeSchema = z.object({ reason: z.string().trim().min(1).max(200).optional() }).strict();

const base64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/**
 * Loads the signing key from a PKCS#8 PEM or a base64 32-byte Ed25519 seed.
 * The subject pepper keys the wallet pseudonym; it defaults to a value derived
 * from the signing key so one secret is enough to configure the service.
 */
function createCredentialSigner({ signingKey, subjectSecret } = {}) {
    if (!signingKey) return null;
    const privateKey = /-----BEGIN/.test(signingKey)
        ? crypto.createPrivateKey(signingKey)
        : crypto.createPrivateKey({
            key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(signingKey, 'base64')]),
            format: 'der',
            type: 'pkcs8',
        });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Credential signing key must be an Ed25519 key');

    const publicKey = crypto.createPublicKey(privateKey);
    const publicJwk = publicKey.export({ format: 'jwk' });
    const kid = crypto.createHash('sha256').update(publicJwk.x).digest('hex').slice(0, 16);
    const pepper = subjectSecret
        ? Buffer.from(subjectSecret, 'utf8')
        : crypto.createHash('sha256')
            .update('orbit-credential-subject:')
            .update(privateKey.export({ format: 'der', type: 'pkcs8' }))
            .digest();

    return {
        kid,
        publicKey,
        jwks: { keys: [{ ...publicJwk, kid, alg: 'EdDSA', use: 'sig' }] },
        // Pairwise pseudonym: the same wallet gets a different subject per merchant,
        // so services of different merchants can't correlate a subscriber
        subjectFor(merchantId, walletAddress) {
            return crypto.createHmac('sha256', pepper).update(`${merchantId}:${walletAddress}`).digest('base64url');
        },
        sign(claims) {
            const signingInput = `${base64url({ alg: 'EdDSA', typ: 'JWT', kid })}.${base64url(claims)}`;
            const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url');
            return `${signingInput}.${signature}`;
        },
    };
}

/**
 * Revoked credential ids. Kept in memory so a revocation takes effect on this
 * instance immediately, and mirrored to credential_revocations so every
 * instance (and a restart) sees it.
 */
class RevocationList {
    constructor() {
        this.revoked = new Map();
    }

    async isRevoked(supabase, jti) {
        if (this.revoked.has(jti)) return true;
        const { data, error } = await supabase.from('credential_revocations').select('jti, reason')
            .eq('jti', jti).maybeSingle();
        if (error) throw error;
        if (data) this.revoked.set(jti, data.reason);
        return Boolean(data);
    }

    async revoke(supabase, { jti, subscriptionId, reason }) {
        this.revoked.set(jti, reason);
        const { error } = await supabase.from('credential_revocations').upsert({
            jti,
            subscription_id: subscriptionId,
            reason,
            revoked_at: new Date().toISOString(),
        }, { onConflict: 'jti' });
        if (error) throw error;
    }

    // Revokes every credential issued for a subscription, e.g. when it is cancelled
    async revokeSubscription(supabase, subscriptionId, reason) {
        const { data, error } = await supabase.from('subscription_credentials').select('jti')
            .eq('subscription_id', subscriptionId);
        if (error) throw error;
        for (const { jti } of data || []) await this.revoke(supabase, { jti, subscriptionId, reason });
        return (data || []).length;
    }
}

async function loadMerchantSubscription(supabase, subscriptionId, merchantId) {
    const { data, error } = await supabase.from('subscriptions')
        .select('id, status, customer_wallet_address, next_billing_date, plan_id, plans!inner(merchant_id, name)')
        .eq('id', subscriptionId)
        .eq('plans.merchant_id', merchantId)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function issueCredential(supabase, signer, { merchantId, subscriptionId, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now() }) {
    const sub = await loadMerchantSubscription(supabase, subscriptionId, merchantId);
    if (!sub) return { status: 404, error: 'Subscription not found' };
    if (sub.status !== 'active') return { status: 409, error: 'Credentials can only be issued for active subscriptions' };

    const issuedAt = Math.floor(now / 1000);
    // Never outlive the paid-up period: stop at the next billing date when it is ahead
    const nextBilling = Math.floor(Date.parse(sub.next_billing_date) / 1000);
    let validUntil = issuedAt + ttlSeconds;
    if (Number.isFinite(nextBilling) && nextBilling > issuedAt) validUntil = Math.min(validUntil, nextBilling);

    const claims = {
        iss: ISSUER,
        type: CREDENTIAL_TYPE,
        jti: crypto.randomUUID(),
        sub: signer.subjectFor(merchantId, sub.customer_wallet_address),
        merchant_id: merchantId,
        plan_tier: String(sub.plans?.name ?? sub.plan_id),
        valid_until: validUntil,
        iat: issuedAt,
        exp: validUntil,
    };
    const token = signer.sign(claims);

    const { error } = await supabase.from('subscription_credentials').insert([{
        jti: claims.jti,
        subscription_id: sub.id,
        merchant_id: merchantId,
        subject_hash: claims.sub,
        plan_tier: claims.plan_tier,
        valid_until: new Date(validUntil * 1000).toISOString(),
        issued_at: new Date(issuedAt * 1000).toISOString(),
    }]);
    if (error) throw error;
    return { status: 201, token, claims };
}

/**
 * Full verification: authentic signature and unexpired (offline checks), not
 * revoked, and the underlying subscription is still active right now.
 */
async function verifyCredential(supabase, signer, revocations, token, { now = Date.now() } = {}) {
    const offline = verifyCredentialToken(token, { publicKey: signer.publicKey, now });
    if (!offline.valid) return offline;
    const { claims } = offline;

    if (await revocations.isRevoked(supabase, claims.jti)) return { valid: false, reason: 'revoked' };

    const { data: record, error } = await supabase.from('subscription_credentials')
        .select('jti, subscription_id, merchant_id').eq('jti', claims.jti).maybeSingle();
    if (error) throw error;
    if (!record || record.merchant_id !== claims.merchant_id) return { valid: false, reason: 'unknown_credential' };

    const { data: sub, error: subError } = await supabase.from('subscriptions').select('id, status')
        .eq('id', record.subscription_id).maybeSingle();
    if (subError) throw subError;
    if (sub?.status !== 'active') {
        // Cancelled through a path that didn't revoke eagerly: revoke now
        await revocations.revoke(supabase, { jti: claims.jti, subscriptionId: record.subscription_id, reason: 'subscription_inactive' });
        return { valid: false, reason: 'subscription_inactive' };
    }

    return {
        valid: true,
        claims: {
            sub: claims.sub,
            merchant_id: claims.merchant_id,
            plan_tier: claims.plan_tier,
            valid_until: claims.valid_until,
        },
    };
}

const firstIssue = (error) => {
    const issue = error.issues[0];
    return `Invalid input on ${issue.path.join('.') || 'input'}: ${issue.message}`;
};

function registerCredentialRoutes(app, getSupabase, authenticateMerchant) {
    let envSigner;
    const getSigner = () => {
        if (app.locals.credentialSigner) return app.locals.credentialSigner;
        if (envSigner === undefined) {
            envSigner = createCredentialSigner({
                signingKey: process.env.CREDENTIAL_SIGNING_KEY,
                subjectSecret: process.env.CREDENTIAL_SUBJECT_SECRET,
            });
        }
        return envSigner;
    };
    const revocations = new RevocationList();
    app.locals.credentialRevocations = revocations;

    const notConfigured = (res) => res.status(503).json({ error: 'Credential signing is not configured' });

    app.post('/credentials', authenticateMerchant, async (req, res) => {
        const parsed = issueSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
        const signer = getSigner();
        if (!signer) return notConfigured(res);
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const result = await issueCredential(supabase, signer, {
                merchantId: req.merchant.id,
                subscriptionId: parsed.data.subscription_id,
                ttlSeconds: parsed.data.ttl_seconds,
            });
            if (result.error) return res.status(result.status).json({ error: result.error });
            return res.status(201).json({ token: result.token, credential: result.claims });
        } catch (err) {
            console.error('Error issuing credential:', err);
            return res.status(500).json({ error: 'Failed to issue credential' });
        }
    });

    app.post('/credentials/verify', async (req, res) => {
        const parsed = verifySchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
        const signer = getSigner();
        if (!signer) return notConfigured(res);
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            return res.json(await verifyCredential(supabase, signer, revocations, parsed.data.token));
        } catch (err) {
            console.error('Error verifying credential:', err);
            return res.status(500).json({ error: 'Failed to verify credential' });
        }
    });

    // Public keys for offline verification with credential-verifier.js
    app.get('/credentials/jwks', (req, res) => {
        const signer = getSigner();
        if (!signer) return notConfigured(res);
        return res.json(signer.jwks);
    });

    app.post('/credentials/:jti/revoke', authenticateMerchant, async (req, res) => {
        const parsed = revokeSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) });
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const { data: record, error } = await supabase.from('subscription_credentials')
                .select('jti, subscription_id, merchant_id').eq('jti', req.params.jti).maybeSingle();
            if (error) throw error;
            if (!record || record.merchant_id !== req.merchant.id) return res.status(404).json({ error: 'Credential not found' });
            await revocations.revoke(supabase, {
                jti: record.jti,
                subscriptionId: record.subscription_id,
                reason: parsed.data.reason || 'merchant_revoked',
            });
            return res.json({ revoked: true, jti: record.jti });
        } catch (err) {
            console.error('Error revoking credential:', err);
            return res.status(500).json({ error: 'Failed to revoke credential' });
        }
    });

    return { revocations, getSigner };
}

module.exports = {
    DEFAULT_TTL_SECONDS,
    MAX_TTL_SECONDS,
    RevocationList,
    createCredentialSigner,
    issueCredential,
    registerCredentialRoutes,
    verifyCredential,
};
