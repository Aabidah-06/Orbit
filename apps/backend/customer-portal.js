'use strict';

const crypto = require('node:crypto');
const { Keypair, StrKey, Networks, TransactionBuilder, Contract, Address } = require('@stellar/stellar-sdk');

const CHALLENGE_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 900;
const JWT_ISSUER = 'orbit-customer-portal';
const JWT_AUDIENCE = 'orbit-customer';
const DATE_SAFE_MAX = 24 * 60 * 60;

function requireSecret() {
    const secret = process.env.CUSTOMER_PORTAL_JWT_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
        const error = new Error('CUSTOMER_PORTAL_JWT_SECRET must contain at least 32 bytes');
        error.status = 503;
        throw error;
    }
    return secret;
}

function makeChallenge(wallet, now = new Date(), network = Networks.TESTNET) {
    if (!StrKey.isValidEd25519PublicKey(wallet)) throw new Error('Invalid Stellar wallet address');
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000).toISOString();
    const message = [
        'Orbit Customer Portal sign-in',
        `Network: ${network}`,
        `Wallet: ${wallet}`,
        `Nonce: ${nonce}`,
        `Expires: ${expiresAt}`,
        'This signature only authenticates your wallet and does not authorize a transaction.',
    ].join('\n');
    return { message, expiresAt };
}

function verifyWalletSignature(wallet, message, signature) {
    if (!StrKey.isValidEd25519PublicKey(wallet) || typeof message !== 'string' ||
        typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const raw = Buffer.from(signature, 'base64');
    if (raw.length !== 64 || raw.toString('base64') !== signature) return false;
    try {
        return Keypair.fromPublicKey(wallet).verify(Buffer.from(message, 'utf8'), raw);
    } catch {
        return false;
    }
}

function b64(value) { return Buffer.from(value).toString('base64url'); }

function signSession(wallet, sid, nowSeconds = Math.floor(Date.now() / 1000), secret = requireSecret()) {
    const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64(JSON.stringify({ iss: JWT_ISSUER, aud: JWT_AUDIENCE,
        sub: wallet, sid, iat: nowSeconds, exp: nowSeconds + SESSION_TTL_SECONDS }));
    const input = `${header}.${payload}`;
    const sig = crypto.createHmac('sha256', secret).update(input).digest('base64url');
    return `${input}.${sig}`;
}

function verifySession(token, nowSeconds = Math.floor(Date.now() / 1000), secret = requireSecret()) {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return null;
    const input = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac('sha256', secret).update(input).digest();
    const actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) return null;
    try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (header.alg !== 'HS256' || header.typ !== 'JWT' || payload.iss !== JWT_ISSUER ||
            payload.aud !== JWT_AUDIENCE || !StrKey.isValidEd25519PublicKey(payload.sub) ||
            typeof payload.sid !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.sid) ||
            !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
            payload.iat > nowSeconds + 30 || payload.exp <= nowSeconds ||
            payload.exp - payload.iat !== SESSION_TTL_SECONDS) return null;
        return payload;
    } catch { return null; }
}

function parsePage(query) {
    const page = query.page === undefined ? 1 : Number(query.page);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
    return { page, limit, from: (page - 1) * limit, to: page * limit - 1 };
}

function explorerUrl(txHash, network) {
    if (typeof txHash !== 'string' || !/^[a-f0-9]{64}$/i.test(txHash)) return null;
    const explorerNetwork = network === Networks.PUBLIC ? 'public' : 'testnet';
    return `https://stellar.expert/explorer/${explorerNetwork}/tx/${txHash}`;
}

function registerCustomerPortalRoutes(app, getSupabase, getSorobanServer) {
    const network = () => process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
    const failed = (res, error) => {
        console.error('Customer portal:', error.message);
        return res.status(error.status || 500).json({ error: error.status === 503 ? error.message : 'Customer portal request failed' });
    };

    // Start or complete the same two-phase endpoint, without ever trusting a
    // wallet address supplied on subsequent authenticated requests.
    app.post('/customer-portal/auth', async (req, res) => {
        const { wallet_address: wallet, challenge_id: id, signature } = req.body || {};
        if (typeof wallet !== 'string' || !StrKey.isValidEd25519PublicKey(wallet)) return res.status(400).json({ error: 'Valid Stellar wallet_address required' });
        const supabase = getSupabase();
        if (!supabase) return res.status(503).json({ error: 'Database is unavailable' });
        try {
            requireSecret();
            if (signature === undefined && id === undefined) {
                const { message, expiresAt } = makeChallenge(wallet, new Date(), network());
                const challengeId = crypto.randomUUID();
                const { error } = await supabase.from('customer_portal_challenges').insert({
                    id: challengeId, wallet_address: wallet, message, expires_at: expiresAt,
                });
                if (error) throw error;
                res.setHeader('Cache-Control', 'no-store');
                return res.status(201).json({ challenge_id: challengeId, message, expires_at: expiresAt });
            }
            if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) || typeof signature !== 'string') {
                return res.status(400).json({ error: 'challenge_id and signature are required' });
            }
            const now = new Date().toISOString();
            const { data: challenge, error: getError } = await supabase.from('customer_portal_challenges')
                .select('id,message').eq('id', id).eq('wallet_address', wallet)
                .is('used_at', null).gt('expires_at', now).maybeSingle();
            if (getError) throw getError;
            if (!challenge || !verifyWalletSignature(wallet, challenge.message, signature)) {
                return res.status(401).json({ error: 'Invalid or expired challenge signature' });
            }
            // Conditional update is an atomic replay barrier across backend instances.
            const { data: consumed, error: updateError } = await supabase.from('customer_portal_challenges')
                .update({ used_at: now }).eq('id', id).eq('wallet_address', wallet)
                .is('used_at', null).gt('expires_at', now).select('id').maybeSingle();
            if (updateError) throw updateError;
            if (!consumed) return res.status(401).json({ error: 'Challenge already used or expired' });

            const sessionId = crypto.randomUUID();
            const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
            const { error: sessionError } = await supabase.from('customer_portal_sessions').insert({
                id: sessionId, wallet_address: wallet, expires_at: expiresAt,
            });
            if (sessionError) throw sessionError;
            const token = signSession(wallet, sessionId);
            res.setHeader('Cache-Control', 'no-store');
            return res.json({ token, token_type: 'Bearer', expires_in: SESSION_TTL_SECONDS, wallet_address: wallet });
        } catch (error) { return failed(res, error); }
    });

    async function requireCustomer(req, res, next) {
        try {
            const auth = req.get('Authorization') || '';
            const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(auth);
            if (!match) return res.status(401).json({ error: 'Customer session required' });
            const session = verifySession(match[1]);
            if (!session) return res.status(401).json({ error: 'Invalid or expired customer session' });
            const supabase = getSupabase();
            if (!supabase) return res.status(503).json({ error: 'Database is unavailable' });
            const { data, error } = await supabase.from('customer_portal_sessions')
                .select('id').eq('id', session.sid).eq('wallet_address', session.sub)
                .is('revoked_at', null).gt('expires_at', new Date().toISOString()).maybeSingle();
            if (error) throw error;
            if (!data) return res.status(401).json({ error: 'Customer session revoked or expired' });
            req.customerWallet = session.sub;
            req.customerSessionId = session.sid;
            next();
        } catch (error) { return failed(res, error); }
    }

    app.post('/customer-portal/logout', requireCustomer, async (req, res) => {
        try {
            const { error } = await getSupabase().from('customer_portal_sessions')
                .update({ revoked_at: new Date().toISOString() }).eq('id', req.customerSessionId)
                .eq('wallet_address', req.customerWallet);
            if (error) throw error;
            return res.status(204).end();
        } catch (error) { return failed(res, error); }
    });

    app.get('/customer-portal/subscriptions', requireCustomer, async (req, res) => {
        const page = parsePage(req.query);
        if (!page) return res.status(400).json({ error: 'Invalid page or limit' });
        try {
            const { data, error } = await getSupabase().from('subscriptions')
                .select('id,plan_id,status,next_billing_date,created_at,plans(name,merchant_id,merchants(name,wallet_address))')
                .eq('customer_wallet_address', req.customerWallet).eq('status', 'active')
                .order('created_at', { ascending: false }).range(page.from, page.to);
            if (error) throw error;
            return res.json({ subscriptions: data || [], page: page.page, limit: page.limit });
        } catch (error) { return failed(res, error); }
    });

    // SQL view joins the audited, CONFIRMED pull to the customer-owned subscription
    // BEFORE applying pagination; it never reads other wallets' receipts.
    app.get('/customer-portal/receipts', requireCustomer, async (req, res) => {
        const page = parsePage(req.query);
        if (!page) return res.status(400).json({ error: 'Invalid page or limit' });
        try {
            const { data, error } = await getSupabase().from('customer_portal_receipts')
                .select('id,subscription_id,plan_name,merchant_name,created_at,tx_hash')
                .eq('customer_wallet_address', req.customerWallet)
                .order('created_at', { ascending: false }).range(page.from, page.to);
            if (error) throw error;
            return res.json({ receipts: (data || []).map(row => ({
                ...row,
                transaction_url: explorerUrl(row.tx_hash, network()),
                download_url: `/customer-portal/receipts/${row.id}/download`,
            })), page: page.page, limit: page.limit });
        } catch (error) { return failed(res, error); }
    });

    app.get('/customer-portal/receipts/:id/download', requireCustomer, async (req, res) => {
        const { id } = req.params;
        if (!/^[a-f0-9-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid receipt id' });
        try {
            const { data, error } = await getSupabase().from('customer_portal_receipts')
                .select('id,subscription_id,plan_name,merchant_name,created_at,tx_hash')
                .eq('id', id).eq('customer_wallet_address', req.customerWallet).maybeSingle();
            if (error) throw error;
            if (!data) return res.status(404).json({ error: 'Receipt not found' });
            // Downloadable confirmation, not a tax invoice; the exact chain
            // amount is unavailable in legacy audit records.
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="orbit-receipt-${id}.json"`);
            res.setHeader('Cache-Control', 'private, no-store');
            return res.send(JSON.stringify({ ...data, transaction_url: explorerUrl(data.tx_hash, network()),
                note: 'Transaction confirmation only; no amount or tax invoice is asserted.' }, null, 2));
        } catch (error) { return failed(res, error); }
    });

    app.post('/customer-portal/cancel', requireCustomer, async (req, res) => {
        const id = req.body?.subscription_id;
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) {
            return res.status(400).json({ error: 'Valid subscription_id required' });
        }
        try {
            const { data: sub, error } = await getSupabase().from('subscriptions')
                .select('id,status,customer_wallet_address,plans(merchants(wallet_address))')
                .eq('id', id).eq('customer_wallet_address', req.customerWallet).maybeSingle();
            if (error) throw error;
            if (!sub) return res.status(404).json({ error: 'Subscription not found' });
            if (sub.status !== 'active') return res.status(409).json({ error: 'Subscription is not active' });
            const merchant = sub.plans?.merchants?.wallet_address;
            const contractId = process.env.ORBIT_CONTRACT_ID;
            if (!StrKey.isValidEd25519PublicKey(merchant || '') || !StrKey.isValidContract(contractId || '')) {
                return res.status(503).json({ error: 'Cancellation network is not configured' });
            }
            const soroban = getSorobanServer(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org');
            const account = await soroban.getAccount(req.customerWallet);
            const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: network() })
                .addOperation(new Contract(contractId).call('cancel_vault',
                    Address.fromString(req.customerWallet).toScVal(),
                    Address.fromString(merchant).toScVal()))
                .setTimeout(300).build();
            const prepared = await soroban.prepareTransaction(tx);
            res.setHeader('Cache-Control', 'no-store');
            return res.json({ transaction_xdr: prepared.toEnvelope().toXdr('base64'), network_passphrase: network(),
                subscription_id: id, customer_wallet_address: req.customerWallet,
                message: 'Sign and submit this transaction in your wallet. Subscription status is not changed until on-chain confirmation.' });
        } catch (error) { return failed(res, error); }
    });
}

module.exports = { registerCustomerPortalRoutes, makeChallenge, verifyWalletSignature,
    signSession, verifySession, parsePage, explorerUrl,
    CHALLENGE_TTL_SECONDS, SESSION_TTL_SECONDS };
