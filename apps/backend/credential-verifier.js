'use strict';

// Orbit subscription credential verifier (#132).
//
// Self-contained (Node >= 18, no dependencies) so a Discord bot, download gate
// or private API can copy this file and check an Orbit credential offline:
//
//   const { verifyCredentialToken } = require('./credential-verifier');
//   const jwks = await (await fetch('https://api.example/credentials/jwks')).json();
//   const result = verifyCredentialToken(token, { jwks });
//   if (result.valid) grantAccess(result.claims.plan_tier);
//
// Offline checks prove the token is authentic and unexpired. To also honour
// revocations made after issuance (cancelled subscriptions), call
// verifyCredentialOnline(), which asks Orbit's POST /credentials/verify.

const crypto = require('node:crypto');

const ISSUER = 'orbit';
const CREDENTIAL_TYPE = 'OrbitSubscriptionCredential';
const MAX_TOKEN_LENGTH = 4096;

const fail = (reason) => ({ valid: false, reason });

function decodeSegment(segment) {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

// Accepts a KeyObject, a PEM string, a JWK, or a JWKS ({ keys: [...] }) and returns
// the Ed25519 public KeyObject matching `kid` (or the only key, when no kid is set)
function resolvePublicKey({ publicKey, jwks }, kid) {
    if (publicKey) {
        if (publicKey instanceof crypto.KeyObject) return publicKey;
        if (typeof publicKey === 'string') return crypto.createPublicKey(publicKey);
        return crypto.createPublicKey({ key: publicKey, format: 'jwk' });
    }
    const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
    const jwk = keys.find((k) => k.kid === kid) || (keys.length === 1 && !kid ? keys[0] : null);
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return null;
    return crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
}

/**
 * Verifies an Orbit credential's Ed25519 signature, issuer, type and expiry.
 * Returns { valid: true, claims, header } or { valid: false, reason }.
 */
function verifyCredentialToken(token, { publicKey, jwks, now = Date.now(), issuer = ISSUER } = {}) {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        return fail('malformed');
    }
    const [headerB64, payloadB64, signatureB64] = token.split('.');

    let header;
    let claims;
    try {
        header = decodeSegment(headerB64);
        claims = decodeSegment(payloadB64);
    } catch {
        return fail('malformed');
    }
    if (header?.alg !== 'EdDSA' || header?.typ !== 'JWT') return fail('unsupported_algorithm');

    let key;
    try { key = resolvePublicKey({ publicKey, jwks }, header.kid); }
    catch { key = null; }
    if (!key) return fail('unknown_key');

    const signature = Buffer.from(signatureB64, 'base64url');
    let authentic = false;
    try {
        authentic = signature.length === 64 &&
            crypto.verify(null, Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), key, signature);
    } catch {
        authentic = false;
    }
    if (!authentic) return fail('invalid_signature');

    if (claims?.iss !== issuer || claims?.type !== CREDENTIAL_TYPE) return fail('invalid_issuer');
    if (typeof claims.sub !== 'string' || typeof claims.merchant_id !== 'string' ||
        typeof claims.plan_tier !== 'string' || typeof claims.jti !== 'string' ||
        !Number.isInteger(claims.valid_until)) {
        return fail('invalid_claims');
    }
    if (claims.valid_until * 1000 <= now) return fail('expired');
    return { valid: true, claims, header };
}

/**
 * Asks Orbit whether a credential is valid right now, including revocation and
 * the subscription's current status.
 */
async function verifyCredentialOnline(token, { baseUrl, fetchImpl = globalThis.fetch } = {}) {
    const response = await fetchImpl(new URL('/credentials/verify', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
    });
    if (!response.ok && response.status !== 400) throw new Error(`Orbit verification failed with HTTP ${response.status}`);
    return response.json();
}

module.exports = {
    CREDENTIAL_TYPE,
    ISSUER,
    decodeSegment,
    verifyCredentialOnline,
    verifyCredentialToken,
};
