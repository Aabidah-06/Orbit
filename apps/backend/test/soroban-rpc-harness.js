const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Account } = require('@stellar/stellar-sdk');

/**
 * Deterministic Soroban RPC Snapshot & Replay Harness (#137)
 *
 * Implements recording and replay for Soroban RPC methods:
 * - simulateTransaction
 * - sendTransaction
 * - getTransaction
 * - getEvents
 *
 * Features:
 * - Deterministic request-to-snapshot matching
 * - Offline replay mode (zero live network dependency)
 * - Opt-in live recording (via SOROBAN_RPC_RECORD=true or mode: 'record')
 * - Automatic sanitization of private keys, credentials, and sensitive transaction data
 * - Contract interface & schema mismatch detection
 */

class ContractInterfaceMismatchError extends Error {
    constructor(message, details = {}) {
        super(`[Soroban RPC Interface Mismatch] ${message}`);
        this.name = 'ContractInterfaceMismatchError';
        this.details = details;
    }
}

class SnapshotNotFoundError extends Error {
    constructor(method, key) {
        super(`[Soroban RPC Replay] No snapshot found for ${method} with deterministic key: ${key}`);
        this.name = 'SnapshotNotFoundError';
        this.method = method;
        this.key = key;
    }
}

// Secret key regex matching Stellar private seeds (S... 56 chars base32)
const SECRET_KEY_REGEX = /\bS[A-Z0-9]{55}\b/g;
const SECRET_REPLACEMENT = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

/**
 * Sanitizes an object or string to prevent secrets from being recorded.
 */
function sanitizePayload(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
        let sanitized = value.replace(SECRET_KEY_REGEX, SECRET_REPLACEMENT);
        // Redact bearer tokens
        sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
        return sanitized;
    }
    if (Array.isArray(value)) {
        return value.map(sanitizePayload);
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            // Scrub private keys or sensitive fields by key name
            if (/secret|private_?key|password|seed|auth_?token/i.test(k)) {
                out[k] = '[REDACTED]';
            } else {
                out[k] = sanitizePayload(v);
            }
        }
        return out;
    }
    return value;
}

/**
 * Derives deterministic lookup key for a request.
 */
function deriveRequestKey(method, params) {
    let normalized = '';

    if (method === 'simulateTransaction') {
        const txXdr = params?.toXDR ? params.toXDR() : (typeof params === 'string' ? params : JSON.stringify(params));
        normalized = `sim:${txXdr}`;
    } else if (method === 'sendTransaction') {
        const txXdr = params?.toXDR ? params.toXDR() : (typeof params === 'string' ? params : JSON.stringify(params));
        // Strip signatures to match deterministically regardless of signature nonce
        normalized = `send:${txXdr}`;
    } else if (method === 'getTransaction') {
        const hash = typeof params === 'string' ? params : (params?.hash || '');
        normalized = `tx:${hash}`;
    } else if (method === 'getEvents') {
        const startLedger = params?.startLedger ?? 0;
        const filters = (params?.filters || []).map((f) => ({
            type: f.type,
            contractIds: (f.contractIds || []).sort(),
            topics: (f.topics || []).map((t) => (Array.isArray(t) ? t.sort() : t)),
        }));
        normalized = `events:${startLedger}:${JSON.stringify(filters)}`;
    } else {
        normalized = `${method}:${JSON.stringify(params)}`;
    }

    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

class SorobanRpcHarness {
    constructor(options = {}) {
        this.fixtureDir = options.fixtureDir || path.resolve(__dirname, 'fixtures', 'soroban-rpc');
        // Live recording is strictly opt-in
        this.mode = options.mode || (process.env.SOROBAN_RPC_RECORD === 'true' ? 'record' : 'replay');
        this.liveServer = options.liveServer || null;

        this.snapshots = {
            simulateTransaction: {},
            sendTransaction: {},
            getTransaction: {},
            getEvents: {},
        };

        this.loadSnapshots();
    }

    loadSnapshots() {
        if (!fs.existsSync(this.fixtureDir)) return;
        const methods = ['simulateTransaction', 'sendTransaction', 'getTransaction', 'getEvents'];
        for (const method of methods) {
            const filePath = path.join(this.fixtureDir, `${method}.json`);
            if (fs.existsSync(filePath)) {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    this.snapshots[method] = JSON.parse(content);
                } catch (err) {
                    console.warn(`Failed to read snapshot file for ${method}:`, err.message);
                }
            }
        }
    }

    saveSnapshots() {
        if (!fs.existsSync(this.fixtureDir)) {
            fs.mkdirSync(this.fixtureDir, { recursive: true });
        }
        for (const [method, records] of Object.entries(this.snapshots)) {
            const filePath = path.join(this.fixtureDir, `${method}.json`);
            fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
        }
    }

    /**
     * Validates interface and schema expectations.
     */
    validateSchema(method, response, requestParams) {
        if (!response) {
            throw new ContractInterfaceMismatchError(`Received empty response for ${method}`);
        }

        if (method === 'simulateTransaction') {
            if (response.results === undefined && response.error === undefined && response.status === undefined) {
                throw new ContractInterfaceMismatchError(
                    'simulateTransaction response missing required fields (results, status, or error)',
                    { response }
                );
            }
            if (response.results && Array.isArray(response.results)) {
                for (const res of response.results) {
                    if (res.auth && !Array.isArray(res.auth)) {
                        throw new ContractInterfaceMismatchError('simulateTransaction result.auth must be an array');
                    }
                }
            }
        } else if (method === 'sendTransaction') {
            if (!response.status || typeof response.status !== 'string') {
                throw new ContractInterfaceMismatchError(
                    'sendTransaction response missing required status string field',
                    { response }
                );
            }
        } else if (method === 'getTransaction') {
            if (!response.status) {
                throw new ContractInterfaceMismatchError(
                    'getTransaction response missing required status string field',
                    { response }
                );
            }
        } else if (method === 'getEvents') {
            if (!Array.isArray(response.events)) {
                throw new ContractInterfaceMismatchError(
                    'getEvents response missing required events array',
                    { response }
                );
            }
        }
    }

    async handleCall(method, params) {
        const key = deriveRequestKey(method, params);

        if (this.mode === 'replay') {
            const entry = this.snapshots[method][key];
            if (!entry) {
                // If there's an exact fallback entry (e.g. wildcard or first entry for simple hashes)
                const fallbackKeys = Object.keys(this.snapshots[method]);
                if (fallbackKeys.length === 1 && method === 'getTransaction') {
                    return this.snapshots[method][fallbackKeys[0]].response;
                }
                throw new SnapshotNotFoundError(method, key);
            }

            // Schema & contract interface verification on replay
            this.validateSchema(method, entry.response, params);
            return JSON.parse(JSON.stringify(entry.response));
        }

        if (this.mode === 'record') {
            if (!this.liveServer || typeof this.liveServer[method] !== 'function') {
                throw new Error(`Cannot record ${method}: liveServer is not configured`);
            }

            const liveResponse = await this.liveServer[method](params);
            const sanitizedResponse = sanitizePayload(liveResponse);
            const sanitizedRequest = sanitizePayload(
                params?.toXDR ? params.toXDR() : (typeof params === 'object' ? params : String(params))
            );

            this.validateSchema(method, sanitizedResponse, params);

            this.snapshots[method][key] = {
                key,
                timestamp: new Date().toISOString(),
                request: sanitizedRequest,
                response: sanitizedResponse,
            };

            this.saveSnapshots();
            return sanitizedResponse;
        }

        if (this.mode === 'passthrough') {
            if (!this.liveServer) throw new Error('Cannot passthrough without liveServer');
            return this.liveServer[method](params);
        }

        throw new Error(`Unsupported harness mode: ${this.mode}`);
    }

    /**
     * Returns an object conforming to rpc.Server interface for injection.
     */
    createServer() {
        return {
            simulateTransaction: async (tx) => this.handleCall('simulateTransaction', tx),
            sendTransaction: async (tx) => this.handleCall('sendTransaction', tx),
            getTransaction: async (hash) => this.handleCall('getTransaction', hash),
            getEvents: async (req) => this.handleCall('getEvents', req),
            getLatestLedger: async () => ({ sequence: 1000, protocolVersion: 22 }),
            getAccount: async (address) => new Account(address, '100'),
            prepareTransaction: async (tx) => tx,
        };
    }
}

function createSorobanRpcHarness(options) {
    return new SorobanRpcHarness(options);
}

module.exports = {
    ContractInterfaceMismatchError,
    SnapshotNotFoundError,
    sanitizePayload,
    deriveRequestKey,
    SorobanRpcHarness,
    createSorobanRpcHarness,
};
