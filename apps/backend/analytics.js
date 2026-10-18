'use strict';

const crypto = require('node:crypto');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');

const RANGES = Object.freeze({ '7D': 7, '30D': 30, '90D': 90, '1Y': 365 });
const CHALLENGE_MS = 5 * 60 * 1000;
const SESSION_MS = 15 * 60 * 1000;
const SIGNING_PREFIX = Buffer.from('Stellar Signed Message:\n');

function analyticsSecret() {
    const value = process.env.ORBIT_ANALYTICS_SESSION_SECRET;
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 32 ? value : null;
}
function safeEqual(left, right) {
    const a = Buffer.from(left), b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function makeToken({ merchantId, walletAddress }, secret, now = Date.now()) {
    const payload = {
        purpose: 'orbit-merchant-analytics', sub: merchantId, wallet: walletAddress,
        exp: now + SESSION_MS, iat: now,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}
function readToken(token, secret, now = Date.now()) {
    if (!secret || typeof token !== 'string' || token.length > 2048 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    const [body, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { return null; }
    if (payload?.purpose !== 'orbit-merchant-analytics' ||
        typeof payload.sub !== 'string' || typeof payload.wallet !== 'string' ||
        !StrKey.isValidEd25519PublicKey(payload.wallet) ||
        !Number.isFinite(payload.exp) || payload.exp <= now ||
        !Number.isFinite(payload.iat) || payload.iat > now + 30000 ||
        payload.exp - payload.iat > SESSION_MS) return null;
    return payload;
}
function verifySep53(message, signature, publicKey) {
    if (typeof message !== 'string' || typeof signature !== 'string' ||
        !StrKey.isValidEd25519PublicKey(publicKey) ||
        !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const bytes = Buffer.from(signature, 'base64');
    if (bytes.length !== 64) return false;
    const digest = crypto.createHash('sha256')
        .update(Buffer.concat([SIGNING_PREFIX, Buffer.from(message, 'utf8')])).digest();
    try { return Keypair.fromPublicKey(publicKey).verify(digest, bytes); }
    catch { return false; }
}
function requireOrigin(req, res) {
    const allowed = process.env.ORBIT_ANALYTICS_ALLOWED_ORIGIN || 'http://localhost:3000';
    if (req.get('origin') !== allowed) {
        res.status(403).json({ error: 'Untrusted analytics request origin' });
        return false;
    }
    return true;
}
const invalidSession = (res) => res.status(401).json({ error: 'Connect and sign with the registered merchant wallet to view analytics' });

function registerAnalyticsRoutes(app, getSupabase) {
    // Only registered merchants can request signed, single-use challenges.
    app.post('/analytics/challenge', async (req, res) => {
        if (!requireOrigin(req, res)) return;
        if (!analyticsSecret()) return res.status(503).json({ error: 'Analytics signing is not configured' });
        const wallet = req.body?.wallet_address;
        if (!StrKey.isValidEd25519PublicKey(wallet || '')) return res.status(400).json({ error: 'Invalid merchant wallet' });
        const supabase = getSupabase();
        if (!supabase) return res.status(503).json({ error: 'Database not configured' });
        try {
            const { data: merchant, error: lookupError } = await supabase.from('merchants')
                .select('id,wallet_address').eq('wallet_address', wallet).maybeSingle();
            if (lookupError) throw lookupError;
            if (!merchant) return res.status(404).json({ error: 'Merchant wallet is not registered' });
            const id = crypto.randomUUID();
            const expiresAt = new Date(Date.now() + CHALLENGE_MS).toISOString();
            const message = [
                'Orbit merchant analytics — read-only access',
                `Origin: ${process.env.ORBIT_ANALYTICS_ALLOWED_ORIGIN || 'http://localhost:3000'}`,
                `Merchant: ${merchant.id}`, `Wallet: ${wallet}`,
                `Challenge: ${crypto.randomBytes(32).toString('hex')}`,
                `Expires: ${expiresAt}`, 'No funds or transaction approval is requested.',
            ].join('\n');
            const { error } = await supabase.from('merchant_analytics_challenges')
                .insert([{ id, merchant_id: merchant.id, wallet_address: wallet, message, expires_at: expiresAt }]);
            if (error) throw error;
            res.set('Cache-Control', 'no-store');
            return res.json({ challenge_id: id, message });
        } catch (error) {
            console.error('Analytics challenge failed', error);
            return res.status(503).json({ error: 'Merchant authentication is unavailable' });
        }
    });
    app.post('/analytics/session', async (req, res) => {
        if (!requireOrigin(req, res)) return;
        const secret = analyticsSecret();
        if (!secret) return res.status(503).json({ error: 'Analytics signing is not configured' });
        const { challenge_id: id, signature } = req.body || {};
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || typeof signature !== 'string')
            return res.status(400).json({ error: 'Invalid signature request' });
        const supabase = getSupabase();
        if (!supabase) return res.status(503).json({ error: 'Database not configured' });
        try {
            const { data: challenge, error } = await supabase.from('merchant_analytics_challenges')
                .select('id,merchant_id,wallet_address,message,expires_at,used_at')
                .eq('id', id).maybeSingle();
            if (error) throw error;
            if (!challenge || challenge.used_at || Date.parse(challenge.expires_at) <= Date.now() ||
                !verifySep53(challenge.message, signature, challenge.wallet_address)) return invalidSession(res);
            // Atomic consume prevents two concurrent requests using the same challenge.
            const { data: consumed, error: consumeError } = await supabase.from('merchant_analytics_challenges')
                .update({ used_at: new Date().toISOString() }).eq('id', id)
                .is('used_at', null).gt('expires_at', new Date().toISOString())
                .select('id').maybeSingle();
            if (consumeError) throw consumeError;
            if (!consumed) return invalidSession(res);
            const { data: merchant, error: merchantError } = await supabase.from('merchants')
                .select('id,wallet_address').eq('id', challenge.merchant_id)
                .eq('wallet_address', challenge.wallet_address).maybeSingle();
            if (merchantError) throw merchantError;
            if (!merchant) return invalidSession(res);
            res.set('Cache-Control', 'no-store');
            return res.json({ token: makeToken({ merchantId: merchant.id, walletAddress: merchant.wallet_address }, secret), expires_in_seconds: 900 });
        } catch (error) {
            console.error('Analytics session failed', error);
            return res.status(503).json({ error: 'Merchant authentication is unavailable' });
        }
    });
    app.get('/analytics/overview', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const secret = analyticsSecret();
        if (!secret) return res.status(503).json({ error: 'Analytics signing is not configured' });
        const auth = req.get('authorization') || '';
        const claims = auth.startsWith('Bearer ') ? readToken(auth.slice(7), secret) : null;
        if (!claims) return invalidSession(res);
        const range = req.query.range || '30D';
        if (!Object.hasOwn(RANGES, range)) return res.status(400).json({ error: 'range must be 7D, 30D, 90D or 1Y' });
        const supabase = getSupabase();
        if (!supabase) return res.status(503).json({ error: 'Database not configured' });
        try {
            // Revocation check: a removed or re-assigned wallet cannot keep viewing data.
            const { data: merchant, error: merchantError } = await supabase.from('merchants')
                .select('id').eq('id', claims.sub).eq('wallet_address', claims.wallet).maybeSingle();
            if (merchantError) throw merchantError;
            if (!merchant) return invalidSession(res);
            const end = new Date(), start = new Date(end.getTime() - RANGES[range] * 86400000);
            const { data, error } = await supabase.rpc('merchant_analytics_overview', {
                p_merchant_id: merchant.id, p_start: start.toISOString(), p_end: end.toISOString(),
            });
            if (error) throw error;
            if (!data) return res.status(503).json({ error: 'Analytics database migration required' });
            return res.json({ range, period_start: start.toISOString(), period_end: end.toISOString(), ...data });
        } catch (error) {
            console.error('Analytics overview unavailable', error);
            return res.status(503).json({ error: 'Verified settlement analytics unavailable; apply the #76 and #77 migrations' });
        }
    });
}
module.exports = { registerAnalyticsRoutes, makeToken, readToken, verifySep53, RANGES };
