// Reconciliation worker: keeps Supabase subscription state in sync with the Soroban ledger.
//
// Each run has two passes:
//   1. Event ingestion: reads vault_created / vault_cancelled / funds_pulled events from
//      Soroban RPC getEvents, resuming from a cursor persisted in reconciliation_state.
//   2. State sweep: calls get_vault for every active / past_due subscription, so drift is
//      repaired even when the matching events fall outside the RPC's retention window.
// The ledger is the source of truth: a vault missing on-chain cancels the subscription and
// next_billing_date is realigned to last_pull_timestamp + interval_seconds.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const {
    rpc, xdr, Networks, TransactionBuilder, Contract, Address, Account, scValToNative,
} = require('@stellar/stellar-sdk');
const { withBillingLock } = require('./idempotency');

const TRACKED_EVENTS = ['vault_created', 'vault_cancelled', 'funds_pulled'];
// Statuses that imply a live vault exists on-chain
const RECONCILED_STATUSES = ['active', 'past_due'];
const EVENT_CURSOR_ID = 'soroban_events';

const DEFAULTS = {
    intervalMs: 60 * 1000,
    // ~1 day of ledgers at ~5s each; used when no cursor is stored or it fell out of retention
    eventLookbackLedgers: 17280,
    eventPageLimit: 200,
    maxEventPagesPerRun: 10,
    subscriptionPageSize: 100,
    // Subscriptions newer than this may be ahead of the RPC node that serves get_vault
    graceSeconds: 300,
    lockTtlSeconds: 60,
};

const SUBSCRIPTION_COLUMNS = `
    id, status, next_billing_date, customer_wallet_address, created_at,
    plans!inner ( interval_seconds, merchants!inner ( wallet_address ) )
`;

const vaultKey = (user, merchant) => `${user}|${merchant}`;
const toUnixSeconds = (value) => Math.floor(new Date(value).getTime() / 1000);
const unixToIso = (seconds) => new Date(Number(seconds) * 1000).toISOString();

const jsonLogger = {
    info: (event, fields) => console.log(JSON.stringify({ level: 'info', event, ...fields })),
    warn: (event, fields) => console.warn(JSON.stringify({ level: 'warn', event, ...fields })),
    error: (event, fields) => console.error(JSON.stringify({ level: 'error', event, ...fields })),
};

// ==========================================
// SUPABASE STORE
// ==========================================
const createSupabaseStore = (supabase, { lockTtlSeconds = DEFAULTS.lockTtlSeconds } = {}) => ({
    async listSubscriptions({ offset, limit }) {
        const { data, error } = await supabase
            .from('subscriptions')
            .select(SUBSCRIPTION_COLUMNS)
            .in('status', RECONCILED_STATUSES)
            .order('id')
            .range(offset, offset + limit - 1);
        if (error) throw error;
        return data ?? [];
    },

    // One vault (user, merchant) backs every subscription the wallet holds with that merchant
    async findSubscriptionsByVault(user, merchant) {
        const { data, error } = await supabase
            .from('subscriptions')
            .select(SUBSCRIPTION_COLUMNS)
            .eq('customer_wallet_address', user)
            .eq('plans.merchants.wallet_address', merchant);
        if (error) throw error;
        return data ?? [];
    },

    async updateSubscription(id, fields) {
        const { error } = await supabase.from('subscriptions').update(fields).eq('id', id);
        if (error) throw error;
    },

    // Runs fn under the subscription's billing lease; returns { skipped: true } if a pull holds it
    async withSubscriptionLock(subscriptionId, fn) {
        const result = await withBillingLock({ supabase, subscriptionId, ttlSeconds: lockTtlSeconds }, async () => {
            await fn();
            return { status: 200 };
        });
        return { skipped: result.status === 409 };
    },

    async loadEventCursor() {
        const { data, error } = await supabase
            .from('reconciliation_state')
            .select('event_cursor')
            .eq('id', EVENT_CURSOR_ID)
            .maybeSingle();
        if (error) throw error;
        return data?.event_cursor ?? null;
    },

    async saveEventCursor(cursor, latestLedger) {
        const { error } = await supabase
            .from('reconciliation_state')
            .upsert({
                id: EVENT_CURSOR_ID,
                event_cursor: cursor,
                last_ledger: latestLedger,
                updated_at: new Date().toISOString(),
            });
        if (error) throw error;
    },
});

// ==========================================
// SOROBAN LEDGER ACCESS
// ==========================================
const eventTopicFilters = () =>
    TRACKED_EVENTS.map((name) => [xdr.ScVal.scvSymbol(name).toXDR('base64'), '*', '*']);

// Decodes a raw contract event into { name, user, merchant, ... }, or null if it is not tracked
const parseVaultEvent = (event) => {
    if (event.inSuccessfulContractCall === false || !event.topic || event.topic.length < 3) return null;
    const name = scValToNative(event.topic[0]);
    if (!TRACKED_EVENTS.includes(name)) return null;

    const parsed = {
        name,
        user: scValToNative(event.topic[1]),
        merchant: scValToNative(event.topic[2]),
        ledger: event.ledger,
        txHash: event.txHash,
    };
    if (name === 'funds_pulled') {
        // Event value is (amount_per_interval, ledger timestamp of the pull)
        const [amount, pulledAt] = scValToNative(event.value);
        parsed.amount = amount.toString();
        parsed.pulledAt = Number(pulledAt);
    }
    return parsed;
};

// Reads get_vault through simulation. Returns { state: 'found', vault } | { state: 'missing' } | { state: 'archived' }
const fetchVault = async (server, { contractId, networkPassphrase }, user, merchant) => {
    // Simulation does not check the sequence number, so no getAccount round trip is needed
    const tx = new TransactionBuilder(new Account(merchant, '0'), { fee: '100', networkPassphrase })
        .addOperation(new Contract(contractId).call('get_vault',
            Address.fromString(user).toScVal(),
            Address.fromString(merchant).toScVal(),
        ))
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`get_vault simulation failed: ${sim.error}`);
    if (rpc.Api.isSimulationRestore(sim)) return { state: 'archived' };

    const vault = sim.result?.retval ? scValToNative(sim.result.retval) : null;
    if (!vault) return { state: 'missing' };
    return {
        state: 'found',
        vault: {
            intervalSeconds: Number(vault.interval_seconds),
            lastPullTimestamp: Number(vault.last_pull_timestamp),
        },
    };
};

// ==========================================
// RECONCILER
// ==========================================
const createReconciler = ({
    store,
    server,
    contractId,
    networkPassphrase = Networks.TESTNET,
    logger = jsonLogger,
    now = () => Date.now(),
    options = {},
}) => {
    const opts = { ...DEFAULTS, ...options };

    const newMetrics = () => ({
        events_ingested: 0,
        subscriptions_checked: 0,
        cancelled: 0,
        billing_dates_updated: 0,
        skipped_locked: 0,
        discrepancies: 0,
        errors: 0,
    });

    const discrepancy = (metrics, type, fields) => {
        metrics.discrepancies += 1;
        logger.warn('reconciliation.discrepancy', { type, ...fields });
    };

    // Applies a write under the billing lease so it never races an in-flight /submit-pull
    const lockedUpdate = async (metrics, sub, fields) => {
        const { skipped } = await store.withSubscriptionLock(sub.id, () => store.updateSubscription(sub.id, fields));
        if (skipped) {
            metrics.skipped_locked += 1;
            logger.info('reconciliation.skipped_locked', { subscription_id: sub.id });
        }
        return !skipped;
    };

    const cancelSubscription = async (metrics, sub, source, extra = {}) => {
        if (!RECONCILED_STATUSES.includes(sub.status)) return;
        discrepancy(metrics, 'vault_missing_on_chain', {
            subscription_id: sub.id, source, previous_status: sub.status, ...extra,
        });
        if (await lockedUpdate(metrics, sub, { status: 'cancelled' })) metrics.cancelled += 1;
    };

    const alignBillingDate = async (metrics, sub, lastPullSeconds, intervalSeconds, source, extra = {}) => {
        if (sub.status === 'cancelled') return;
        const expectedSeconds = lastPullSeconds + intervalSeconds;
        const storedSeconds = toUnixSeconds(sub.next_billing_date);
        if (storedSeconds === expectedSeconds) return;

        const expected = unixToIso(expectedSeconds);
        discrepancy(metrics, 'next_billing_date_drift', {
            subscription_id: sub.id,
            source,
            stored_next_billing_date: sub.next_billing_date,
            ledger_next_billing_date: expected,
            drift_seconds: storedSeconds - expectedSeconds,
            ...extra,
        });
        if (await lockedUpdate(metrics, sub, { next_billing_date: expected })) metrics.billing_dates_updated += 1;
    };

    // Fetches new events from the stored cursor, falling back to a lookback window when the
    // cursor is missing or no longer inside the RPC's retention window
    const fetchNewEvents = async () => {
        const filters = [{ type: 'contract', contractIds: [contractId], topics: eventTopicFilters() }];
        let cursor = await store.loadEventCursor();
        let request;
        const startFromLookback = async () => {
            const { sequence } = await server.getLatestLedger();
            return { startLedger: Math.max(1, sequence - opts.eventLookbackLedgers) };
        };

        if (cursor) {
            request = { cursor };
        } else {
            request = await startFromLookback();
        }

        const events = [];
        let latestLedger = null;
        for (let page = 0; page < opts.maxEventPagesPerRun; page += 1) {
            let response;
            try {
                response = await server.getEvents({ ...request, filters, limit: opts.eventPageLimit });
            } catch (err) {
                if (!request.cursor || page > 0) throw err;
                logger.warn('reconciliation.event_cursor_reset', { cursor, reason: err.message });
                request = await startFromLookback();
                response = await server.getEvents({ ...request, filters, limit: opts.eventPageLimit });
            }

            events.push(...response.events);
            cursor = response.cursor;
            latestLedger = response.latestLedger;
            if (response.events.length < opts.eventPageLimit) break;
            request = { cursor };
        }
        return { events, cursor, latestLedger };
    };

    const ingestEvents = async (metrics) => {
        const { events, cursor, latestLedger } = await fetchNewEvents();

        // Collapse events to the final ledger state per vault, in ledger order
        const vaults = new Map();
        for (const raw of events) {
            const event = parseVaultEvent(raw);
            if (!event) continue;
            metrics.events_ingested += 1;

            const key = vaultKey(event.user, event.merchant);
            const state = vaults.get(key) ?? { user: event.user, merchant: event.merchant };
            if (event.name === 'vault_created') {
                Object.assign(state, { lifecycle: 'created', lastPull: null, ledger: event.ledger, txHash: event.txHash });
            } else if (event.name === 'vault_cancelled') {
                Object.assign(state, { lifecycle: 'cancelled', lastPull: null, ledger: event.ledger, txHash: event.txHash });
            } else {
                state.lastPull = { pulledAt: event.pulledAt, ledger: event.ledger, txHash: event.txHash };
            }
            vaults.set(key, state);
        }

        for (const state of vaults.values()) {
            const subs = await store.findSubscriptionsByVault(state.user, state.merchant);
            if (subs.length === 0) {
                if (state.lifecycle === 'created') {
                    discrepancy(metrics, 'untracked_vault', {
                        customer_wallet_address: state.user,
                        merchant_wallet_address: state.merchant,
                        ledger: state.ledger,
                        tx_hash: state.txHash,
                    });
                }
                continue;
            }

            for (const sub of subs) {
                if (state.lifecycle === 'cancelled') {
                    await cancelSubscription(metrics, sub, 'event', { ledger: state.ledger, tx_hash: state.txHash });
                } else if (state.lastPull) {
                    await alignBillingDate(metrics, sub, state.lastPull.pulledAt, Number(sub.plans.interval_seconds), 'event', {
                        ledger: state.lastPull.ledger,
                        tx_hash: state.lastPull.txHash,
                    });
                }
            }
        }

        // Saved only after every event was applied, so a failed run re-reads the same events
        if (cursor) await store.saveEventCursor(cursor, latestLedger);
    };

    const sweepSubscriptions = async (metrics) => {
        const cutoffSeconds = Math.floor(now() / 1000) - opts.graceSeconds;
        const vaultCache = new Map();
        const lookup = (user, merchant) => {
            const key = vaultKey(user, merchant);
            if (!vaultCache.has(key)) {
                vaultCache.set(key, fetchVault(server, { contractId, networkPassphrase }, user, merchant));
            }
            return vaultCache.get(key);
        };

        // Collect first: cancelling rows while paging by offset would shift later pages
        const subs = [];
        for (let offset = 0; ; offset += opts.subscriptionPageSize) {
            const page = await store.listSubscriptions({ offset, limit: opts.subscriptionPageSize });
            subs.push(...page);
            if (page.length < opts.subscriptionPageSize) break;
        }

        for (const sub of subs) {
            if (sub.created_at && toUnixSeconds(sub.created_at) > cutoffSeconds) continue;
            metrics.subscriptions_checked += 1;
            const merchant = sub.plans?.merchants?.wallet_address;

            try {
                const result = await lookup(sub.customer_wallet_address, merchant);
                if (result.state === 'missing') {
                    await cancelSubscription(metrics, sub, 'ledger_state');
                } else if (result.state === 'archived') {
                    discrepancy(metrics, 'vault_archived', { subscription_id: sub.id });
                } else if (result.vault.lastPullTimestamp !== 0) {
                    await alignBillingDate(metrics, sub, result.vault.lastPullTimestamp, result.vault.intervalSeconds, 'ledger_state');
                }
            } catch (err) {
                // Never cancel on a failed lookup: an RPC outage must not look like a cancellation
                metrics.errors += 1;
                logger.error('reconciliation.subscription_failed', { subscription_id: sub.id, error: err.message });
            }
        }
    };

    const runOnce = async () => {
        const startedAt = now();
        const metrics = newMetrics();

        try {
            await ingestEvents(metrics);
        } catch (err) {
            metrics.errors += 1;
            logger.error('reconciliation.event_ingestion_failed', { error: err.message });
        }

        try {
            await sweepSubscriptions(metrics);
        } catch (err) {
            metrics.errors += 1;
            logger.error('reconciliation.sweep_failed', { error: err.message });
        }

        logger.info('reconciliation.run_completed', { ...metrics, duration_ms: now() - startedAt });
        return metrics;
    };

    return { runOnce };
};

// Runs the reconciler on a fixed delay; runs never overlap
const startReconciliationWorker = (reconciler, { intervalMs = DEFAULTS.intervalMs } = {}) => {
    let stopped = false;
    let timer = null;
    let current = null;

    const tick = async () => {
        current = reconciler.runOnce();
        await current;
        current = null;
        if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    tick();

    return {
        async stop() {
            stopped = true;
            clearTimeout(timer);
            await current;
        },
    };
};

const reconcilerFromEnv = () => {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ORBIT_CONTRACT_ID } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    if (!ORBIT_CONTRACT_ID) throw new Error('ORBIT_CONTRACT_ID must be set');

    const envNumber = (name) => (process.env[name] ? Number(process.env[name]) : undefined);
    const options = Object.fromEntries(Object.entries({
        eventLookbackLedgers: envNumber('RECONCILE_EVENT_LOOKBACK_LEDGERS'),
        graceSeconds: envNumber('RECONCILE_GRACE_SECONDS'),
    }).filter(([, value]) => value !== undefined));

    return createReconciler({
        store: createSupabaseStore(createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)),
        server: new rpc.Server(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'),
        contractId: ORBIT_CONTRACT_ID,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
        options,
    });
};

if (require.main === module) {
    const reconciler = reconcilerFromEnv();
    if (process.argv.includes('--once')) {
        reconciler.runOnce().then((metrics) => process.exit(metrics.errors > 0 ? 1 : 0));
    } else {
        const worker = startReconciliationWorker(reconciler, {
            intervalMs: Number(process.env.RECONCILE_INTERVAL_MS) || DEFAULTS.intervalMs,
        });
        const shutdown = () => worker.stop().then(() => process.exit(0));
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }
}

module.exports = {
    createReconciler,
    createSupabaseStore,
    startReconciliationWorker,
    parseVaultEvent,
    fetchVault,
    TRACKED_EVENTS,
};
