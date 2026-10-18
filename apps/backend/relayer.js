// Fee-bump relayer: submits merchant pulls on the merchant's behalf and pays the network fees.
//
// The merchant never builds, funds or sequences a transaction. They sign only the Soroban
// authorization entry for pull_funds (the contract's merchant.require_auth()). The relayer
// places that entry in a transaction sourced from one of its channel accounts, wraps it in
// a FeeBumpTransaction whose fee source is the Orbit relayer account, and submits it.
//
// Because the merchant's signature covers the invocation and not the transaction, the
// relayer can rebuild and resubmit with a fresh sequence number on txBadSeq or
// TRY_AGAIN_LATER without asking the merchant to sign again.
const {
    Keypair, Account, Address, Operation, TransactionBuilder, Networks, BASE_FEE, xdr, hash,
    inspectAuthEntry, buildAuthorizationEntryPreimage, rpc,
} = require('@stellar/stellar-sdk');

const DEFAULTS = {
    // Fee bump inclusion fee per operation, in stroops
    baseFee: Number(BASE_FEE),
    // Upper bound on the total fee the relayer will sponsor for a single pull
    maxFeeStroops: 5_000_000,
    dailyFeeLimitStroops: 50_000_000,
    maxAttempts: 3,
    retryDelayMs: 1000,
    queueTimeoutMs: 30000,
    // How long a prepared authorization stays signable (~5s per ledger)
    authValidityLedgers: 100,
    txTimeoutSeconds: 60,
};

class RelayerError extends Error {
    constructor(code, status, message, { retryAfter } = {}) {
        super(message);
        this.name = 'RelayerError';
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

// Checked by name rather than instanceof, which fails if the module is loaded twice
const isRelayerError = (err) => err?.name === 'RelayerError' && Number.isInteger(err.status);

const ADDRESS_CREDENTIAL_TYPES = ['address', 'addressV2'];

// Extracts the transaction result code, unwrapping the inner result of a fee bump
const resultCode = (txResult) => {
    const type = txResult?.result?.type;
    if (type === 'txFeeBumpInnerFailed' || type === 'txFeeBumpInnerSuccess') {
        return txResult.result.innerResultPair?.result?.result?.type ?? type;
    }
    return type ?? null;
};

const pullArgs = (user, merchant) => [new Address(user).toScVal(), new Address(merchant).toScVal()];

// The exact invocation a merchant must authorize: pull_funds(user, merchant) with no sub-calls
const pullInvocation = (contractId, user, merchant) => new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName: 'pull_funds',
        args: pullArgs(user, merchant),
    })),
    subInvocations: [],
});

// ==========================================
// SEQUENCE MANAGER
// ==========================================
// Caches the last used sequence number per source account. Reading the sequence from the
// ledger for every transaction would hand a stale number to the next transaction while an
// earlier one is still pending, so the cache only advances when a submission is accepted
// and is dropped (re-read from the ledger) after a txBadSeq.
class SequenceManager {
    constructor(server) {
        this.server = server;
        this.sequences = new Map();
    }

    // Returns an Account whose next built transaction uses the next free sequence number
    async account(publicKey) {
        if (!this.sequences.has(publicKey)) {
            const onChain = await this.server.getAccount(publicKey);
            this.sequences.set(publicKey, onChain.sequenceNumber());
        }
        return new Account(publicKey, this.sequences.get(publicKey));
    }

    commit(publicKey, usedSequence) {
        this.sequences.set(publicKey, usedSequence);
    }

    invalidate(publicKey) {
        this.sequences.delete(publicKey);
    }
}

// ==========================================
// CHANNEL POOL
// ==========================================
// Hands out channel accounts one relay at a time, so no two in-flight transactions share a
// source account. Callers beyond the pool size wait in FIFO order up to queueTimeoutMs.
class ChannelPool {
    constructor(keypairs, { queueTimeoutMs = DEFAULTS.queueTimeoutMs } = {}) {
        if (keypairs.length === 0) throw new Error('ChannelPool needs at least one channel account');
        this.idle = [...keypairs];
        this.waiters = [];
        this.queueTimeoutMs = queueTimeoutMs;
    }

    get queued() {
        return this.waiters.length;
    }

    acquire() {
        if (this.idle.length > 0) return Promise.resolve(this.idle.shift());

        return new Promise((resolve, reject) => {
            const waiter = { resolve };
            waiter.timer = setTimeout(() => {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                reject(new RelayerError('relayer_busy', 503, 'All relayer channels are busy, please retry later', { retryAfter: 5 }));
            }, this.queueTimeoutMs);
            this.waiters.push(waiter);
        });
    }

    release(keypair) {
        const waiter = this.waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(keypair);
        } else {
            this.idle.push(keypair);
        }
    }
}

// ==========================================
// FEE BUDGET (Supabase)
// ==========================================
// Daily per-merchant sponsorship budget. reserve_relayer_fee atomically books the maximum
// fee before submission; the booking is later corrected to the fee actually charged.
const createSupabaseFeeBudget = (getSupabase, { dailyLimitStroops = DEFAULTS.dailyFeeLimitStroops } = {}) => ({
    dailyLimitStroops,

    // Returns the UTC usage date the amount was booked against, or null if over budget
    async reserve(merchantId, amount) {
        const { data, error } = await getSupabase().rpc('reserve_relayer_fee', {
            p_merchant_id: merchantId,
            p_amount: amount,
            p_daily_limit: dailyLimitStroops,
        });
        if (error) throw error;
        return data ?? null;
    },

    async adjust(merchantId, usageDate, feeDelta, txDelta) {
        const { error } = await getSupabase().rpc('adjust_relayer_fee', {
            p_merchant_id: merchantId,
            p_usage_date: usageDate,
            p_fee_delta: feeDelta,
            p_tx_delta: txDelta,
        });
        if (error) throw error;
    },

    async usage(merchantId) {
        const usageDate = new Date().toISOString().slice(0, 10);
        const { data, error } = await getSupabase()
            .from('relayer_fee_usage')
            .select('fee_stroops, tx_count')
            .eq('merchant_id', merchantId)
            .eq('usage_date', usageDate)
            .maybeSingle();
        if (error) throw error;
        return { usageDate, feeStroops: Number(data?.fee_stroops ?? 0), txCount: data?.tx_count ?? 0 };
    },
});

// ==========================================
// RELAYER
// ==========================================
const createRelayer = ({
    server,
    sponsor,
    channels = [sponsor],
    contractId,
    networkPassphrase = Networks.TESTNET,
    budget,
    logger = console,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    options = {},
}) => {
    const opts = { ...DEFAULTS, ...options };
    const pool = new ChannelPool(channels, { queueTimeoutMs: opts.queueTimeoutMs });
    const sequences = new SequenceManager(server);

    const buildInner = (account, user, merchant, auth) =>
        new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
            .addOperation(Operation.invokeContractFunction({
                contract: contractId,
                function: 'pull_funds',
                args: pullArgs(user, merchant),
                auth,
            }))
            .setTimeout(opts.txTimeoutSeconds)
            .build();

    // Simulates the pull and returns the merchant's unsigned authorization entry
    const preparePullAuthorization = async ({ user, merchant }) => {
        // Simulation ignores the sequence number, so the sponsor account needs no lookup
        const tx = buildInner(new Account(sponsor.publicKey(), '0'), user, merchant, []);
        const sim = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(sim)) {
            throw new RelayerError('simulation_failed', 422, `Pull cannot be executed: ${sim.error}`);
        }

        const entry = (sim.result?.auth ?? []).find((candidate) => inspectAuthEntry(candidate).address === merchant);
        if (!entry) throw new RelayerError('simulation_failed', 422, 'Simulation did not request a merchant authorization');

        return {
            authEntryXdr: entry.toXdr('base64'),
            validUntilLedger: sim.latestLedger + opts.authValidityLedgers,
        };
    };

    // Parses a signed authorization entry and checks it authorizes exactly this pull for this merchant
    const verifyPullAuthorization = async ({ entryXdr, user, merchant }) => {
        let entry;
        try {
            entry = xdr.SorobanAuthorizationEntry.fromXdr(entryXdr, 'base64');
        } catch {
            throw new RelayerError('invalid_authorization', 400, 'signed_auth_entry_xdr is not a valid Soroban authorization entry');
        }

        const info = inspectAuthEntry(entry);
        const expected = pullInvocation(contractId, user, merchant);
        if (!ADDRESS_CREDENTIAL_TYPES.includes(info.credentialType) || info.address !== merchant
            || entry.rootInvocation.toXdr('base64') !== expected.toXdr('base64')) {
            throw new RelayerError('invalid_authorization', 400, "Authorization does not match this subscription's pull");
        }

        const { sequence: latestLedger } = await server.getLatestLedger();
        if (info.signatureExpirationLedger <= latestLedger) {
            throw new RelayerError('authorization_expired', 400, 'Authorization has expired, prepare the pull again');
        }

        const payload = hash(buildAuthorizationEntryPreimage(entry, info.signatureExpirationLedger, networkPassphrase).toXdr());
        const merchantKey = Keypair.fromPublicKey(merchant);
        const signed = info.signers.some((signer) => (signer.signatures ?? []).some(({ publicKey, signature }) =>
            publicKey === merchant && merchantKey.verify(payload, signature)));
        if (!signed) {
            throw new RelayerError('invalid_signature', 401, 'A valid merchant wallet signature is required');
        }
        return entry;
    };

    const adjustBudget = async (merchantId, reservation, feeDelta, txDelta) => {
        try {
            await budget.adjust(merchantId, reservation.usageDate, feeDelta, txDelta);
        } catch (err) {
            // Not fatal: the booking stays at the reserved maximum, which errs on the safe side
            logger.error('Error adjusting relayer fee budget:', err);
        }
    };

    // Submits the pull as a sponsored fee bump and waits for confirmation via `confirm(server, hash)`
    const relayPull = async ({ merchantId, entry, user, merchant, confirm }) => {
        const channel = await pool.acquire();
        let reservation = null;
        let submitted = null;

        try {
            for (let attempt = 1; ; attempt += 1) {
                const account = await sequences.account(channel.publicKey());
                let prepared;
                try {
                    prepared = await server.prepareTransaction(buildInner(account, user, merchant, [entry]));
                } catch (err) {
                    throw new RelayerError('simulation_failed', 422, `Pull cannot be executed: ${err.message}`);
                }
                prepared.sign(channel);

                const feeBump = TransactionBuilder.buildFeeBumpTransaction(sponsor, String(opts.baseFee), prepared, networkPassphrase);
                feeBump.sign(sponsor);
                const fee = Number(feeBump.fee);
                if (fee > opts.maxFeeStroops) {
                    throw new RelayerError('fee_cap_exceeded', 422, `Pull fee of ${fee} stroops exceeds the relayer cap of ${opts.maxFeeStroops}`);
                }

                // Book the fee before spending it; a retry whose fee grew books the difference
                const shortfall = fee - (reservation?.amount ?? 0);
                if (shortfall > 0) {
                    const usageDate = await budget.reserve(merchantId, shortfall);
                    if (!usageDate) {
                        throw new RelayerError('daily_budget_exceeded', 429, 'Daily gas sponsorship budget exceeded for this merchant', { retryAfter: 3600 });
                    }
                    reservation = { usageDate: reservation?.usageDate ?? usageDate, amount: fee };
                }

                let response;
                try {
                    response = await server.sendTransaction(feeBump);
                } catch (err) {
                    // Unknown whether it was accepted: re-read the sequence next time and keep the booking
                    sequences.invalidate(channel.publicKey());
                    reservation = null;
                    throw err;
                }

                if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
                    sequences.commit(channel.publicKey(), prepared.sequence);
                    submitted = { hash: response.hash, attempts: attempt };
                    break;
                }

                const code = response.status === 'ERROR' ? resultCode(response.errorResult) : null;
                if (response.status !== 'TRY_AGAIN_LATER' && code !== 'txBadSeq') {
                    throw new RelayerError('submission_rejected', 502, `Relayer submission rejected: ${code ?? response.status}`);
                }
                if (code === 'txBadSeq') sequences.invalidate(channel.publicKey());
                logger.warn(`Relayer retrying pull after ${code ?? response.status} (attempt ${attempt}/${opts.maxAttempts})`);

                if (attempt >= opts.maxAttempts) {
                    throw new RelayerError('relayer_busy', 503, 'Relayer could not submit the pull, please retry later', { retryAfter: 5 });
                }
                await sleep(opts.retryDelayMs * attempt);
            }

            const confirmation = await confirm(server, submitted.hash);
            const charged = confirmation.resultXdr?.feeCharged;
            const feeCharged = charged === undefined || charged === null ? null : Number(charged);
            // Settle the booking to the actual fee; an unconfirmed transaction keeps the maximum
            await adjustBudget(merchantId, reservation, feeCharged === null ? 0 : feeCharged - reservation.amount, 1);

            return { status: confirmation.status, txHash: submitted.hash, feeCharged, attempts: submitted.attempts };
        } catch (err) {
            if (reservation && !submitted) await adjustBudget(merchantId, reservation, -reservation.amount, 0);
            throw err;
        } finally {
            pool.release(channel);
        }
    };

    const budgetStatus = async (merchantId) => {
        const { usageDate, feeStroops, txCount } = await budget.usage(merchantId);
        return {
            usage_date: usageDate,
            daily_limit_stroops: budget.dailyLimitStroops,
            used_stroops: feeStroops,
            remaining_stroops: Math.max(0, budget.dailyLimitStroops - feeStroops),
            sponsored_transactions: txCount,
        };
    };

    const sponsorTransaction = async ({ txXdr, passphrase = networkPassphrase }) => {
        const innerTx = TransactionBuilder.fromXDR(txXdr, passphrase);
        const feeBump = TransactionBuilder.buildFeeBumpTransaction(sponsor, String(opts.baseFee * 2), innerTx, passphrase);
        feeBump.sign(sponsor);
        const submission = await server.sendTransaction(feeBump);
        return {
            txHash: submission.hash,
            status: submission.status,
            sponsored: true,
            sponsorAddress: sponsor.publicKey(),
        };
    };

    return {
        sponsorAddress: sponsor.publicKey(),
        sponsorKeypair: sponsor,
        pool,
        sequences,
        preparePullAuthorization,
        verifyPullAuthorization,
        relayPull,
        budgetStatus,
        sponsorTransaction,
    };
};

// Builds the relayer from RELAYER_* env vars; returns null when no relayer key is configured
const createRelayerFromEnv = ({ server, getSupabase, env = process.env }) => {
    if (!env.RELAYER_SECRET_KEY || !env.ORBIT_CONTRACT_ID) return null;

    const envNumber = (name) => (env[name] ? Number(env[name]) : undefined);
    const options = Object.fromEntries(Object.entries({
        baseFee: envNumber('RELAYER_BASE_FEE'),
        maxFeeStroops: envNumber('RELAYER_MAX_FEE_STROOPS'),
        maxAttempts: envNumber('RELAYER_MAX_ATTEMPTS'),
        queueTimeoutMs: envNumber('RELAYER_QUEUE_TIMEOUT_MS'),
        authValidityLedgers: envNumber('RELAYER_AUTH_VALIDITY_LEDGERS'),
    }).filter(([, value]) => value !== undefined));

    const sponsor = Keypair.fromSecret(env.RELAYER_SECRET_KEY);
    const channelSecrets = (env.RELAYER_CHANNEL_SECRET_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);

    return createRelayer({
        server,
        sponsor,
        channels: channelSecrets.length > 0 ? channelSecrets.map((s) => Keypair.fromSecret(s)) : [sponsor],
        contractId: env.ORBIT_CONTRACT_ID,
        networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
        budget: createSupabaseFeeBudget(getSupabase, {
            dailyLimitStroops: envNumber('RELAYER_DAILY_FEE_LIMIT_STROOPS') ?? DEFAULTS.dailyFeeLimitStroops,
        }),
        options,
    });
};

module.exports = {
    RelayerError,
    isRelayerError,
    SequenceManager,
    ChannelPool,
    createRelayer,
    createRelayerFromEnv,
    createSupabaseFeeBudget,
    pullInvocation,
    resultCode,
};
