// Merchant payout split engine (#160)
//
// Incoming subscription settlements are automatically routed between multiple
// partner treasury wallets (e.g. 70% primary merchant, 30% revenue-share
// partner) instead of being reconciled by hand each month.
//
// Wiring:
//   1. A merchant registers recipients in `merchant_payout_splits`
//      (recipient_wallet + percentage_basis_points + label).
//   2. When a `payment.settled` event lands, `createPayoutSplitDispatcher`
//      loads the active splits, converts the settled amount into per-recipient
//      distributions and submits a forward transfer for each one via the
//      merchant treasury (directly or through the Orbit relayer).
//   3. Every forward transfer is recorded in `payout_distributions`, linking the
//      primary pull transaction hash to the secondary split transfer hash so the
//      ledger can be reconciled end-to-end.
//
// The primary merchant keeps whatever the splits do not allocate, so a 3000 bps
// partner split leaves the remaining 7000 bps with the merchant treasury.
const crypto = require('crypto');
const { z } = require('zod');
const { dispatchWebhookEvent } = require('./webhooks');
const { writeAuditLog } = require('./audit');

const BASIS_POINTS_DENOMINATOR = 10000n;
const BASIS_POINTS_TOTAL = 10000;
// Cap on active recipients per merchant, keeping a settlement bounded.
const MAX_ACTIVE_PAYOUT_SPLITS = 20;

const createPayoutSplitSchema = z.object({
    recipient_wallet: z.string().trim().min(1, 'recipient_wallet is required'),
    percentage_basis_points: z.coerce
        .number()
        .int('percentage_basis_points must be an integer')
        .positive('percentage_basis_points must be greater than 0')
        .max(BASIS_POINTS_TOTAL, `percentage_basis_points must not exceed ${BASIS_POINTS_TOTAL}`),
    label: z.string().trim().max(255).optional(),
    is_active: z.boolean().optional().default(true),
});

const updatePayoutSplitSchema = z.object({
    percentage_basis_points: z.coerce
        .number()
        .int('percentage_basis_points must be an integer')
        .positive('percentage_basis_points must be greater than 0')
        .max(BASIS_POINTS_TOTAL, `percentage_basis_points must not exceed ${BASIS_POINTS_TOTAL}`)
        .optional(),
    label: z.string().trim().max(255).nullable().optional(),
    is_active: z.boolean().optional(),
}).strict();

const formatZodError = (err) => {
    const issue = err.issues[0];
    const field = issue.path.join('.') || 'input';
    return `Invalid input on ${field}: ${issue.message}`;
};

const toUnits = (value) => {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error('amount must be an integer in raw token units');
        return BigInt(value);
    }
    try {
        return BigInt(String(value));
    } catch {
        throw new Error(`amount is not a valid integer: ${value}`);
    }
};

// A merchant may route up to 100% of a settlement. Anything above that would ask
// a recipient to pay money the platform never collected.
const validatePayoutSplits = (splits) => {
    const active = splits.filter((split) => split.is_active !== false);
    if (active.length > MAX_ACTIVE_PAYOUT_SPLITS) {
        throw new Error(`at most ${MAX_ACTIVE_PAYOUT_SPLITS} active payout splits are allowed`);
    }

    let total = 0;
    const recipients = new Set();
    for (const split of active) {
        const bps = Number(split.percentage_basis_points);
        if (!Number.isInteger(bps) || bps <= 0 || bps > BASIS_POINTS_TOTAL) {
            throw new Error(`percentage_basis_points must be an integer between 1 and ${BASIS_POINTS_TOTAL}`);
        }
        if (recipients.has(split.recipient_wallet)) {
            throw new Error(`duplicate payout recipient: ${split.recipient_wallet}`);
        }
        recipients.add(split.recipient_wallet);
        total += bps;
    }

    if (total > BASIS_POINTS_TOTAL) {
        throw new Error(`active payout splits allocate ${total} basis points, which exceeds ${BASIS_POINTS_TOTAL}`);
    }

    return active;
};

// Splits `amountUnits` between the active recipients using basis points. Integer
// division can leave a rounding remainder; it is awarded to the largest share so
// the sum of the distributions always equals the settled amount.
const allocatePayoutSplits = (amountUnits, splits) => {
    const total = toUnits(amountUnits);
    if (total <= 0n) throw new Error('amount must be greater than 0');

    const active = validatePayoutSplits(splits);
    if (active.length === 0) return [];

    let distributed = 0n;
    const allocations = active.map((split) => {
        const share = (total * BigInt(split.percentage_basis_points)) / BASIS_POINTS_DENOMINATOR;
        distributed += share;
        return { ...split, amount_units: share };
    });

    const remainder = total - distributed;
    if (remainder > 0n) {
        let target = 0;
        for (let i = 1; i < allocations.length; i += 1) {
            if (allocations[i].percentage_basis_points > allocations[target].percentage_basis_points) target = i;
        }
        allocations[target].amount_units += remainder;
    }

    return allocations.filter((allocation) => allocation.amount_units > 0n);
};

// ==========================================
// STELLAR FORWARDER
// ==========================================
// Submits a Soroban SAC `transfer` from the merchant treasury to a split
// recipient. The treasury (or the split relayer) signs and pays for the forward
// transfer. `server` is a Soroban RPC server from @stellar/stellar-sdk.
const createStellarSplitForwarder = ({
    server,
    sourceKeypair,
    tokenContractId,
    networkPassphrase,
    pollTimeoutMs = 30000,
    pollIntervalMs = 1000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
    const {
        Contract, Address, TransactionBuilder, Networks, nativeToScVal,
    } = require('@stellar/stellar-sdk');
    const passphrase = networkPassphrase || Networks.TESTNET;

    const transfer = async ({ from, to, amountUnits }) => {
        if (!server || !sourceKeypair || !tokenContractId) {
            throw new Error('Split forwarder is not configured with an RPC server, treasury key and token contract');
        }
        const account = await server.getAccount(sourceKeypair.publicKey());
        const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: passphrase })
            .addOperation(new Contract(tokenContractId).call(
                'transfer',
                Address.fromString(from).toScVal(),
                Address.fromString(to).toScVal(),
                nativeToScVal(BigInt(toUnits(amountUnits)), { type: 'i128' }),
            ))
            .setTimeout(60)
            .build();

        const prepared = await server.prepareTransaction(tx);
        prepared.sign(sourceKeypair);
        const response = await server.sendTransaction(prepared);
        if (response.status !== 'PENDING' && response.status !== 'SUCCESS' && response.status !== 'DUPLICATE') {
            throw new Error(`Split transfer rejected (${response.status})`);
        }

        const deadline = Date.now() + pollTimeoutMs;
        let confirmation = await server.getTransaction(response.hash);
        while (confirmation.status === 'NOT_FOUND' && Date.now() < deadline) {
            await sleep(pollIntervalMs);
            confirmation = await server.getTransaction(response.hash);
        }
        if (confirmation.status === 'FAILED') throw new Error('Split transfer failed on-chain');

        return { txHash: response.hash, status: confirmation.status };
    };

    const status = async (txHash) => {
        const confirmation = await server.getTransaction(txHash);
        return confirmation.status;
    };

    const treasuryAddress = sourceKeypair.publicKey();
    return { transfer, status, treasuryAddress };
};

// ==========================================
// SETTLEMENT SPLIT DISPATCHER
// ==========================================
const createPayoutSplitDispatcher = ({
    supabase,
    forwarder = null,
    logger = console,
    now = () => new Date(),
    getTreasuryWallet = null,
} = {}) => {
    // Creates (or re-uses) the distribution row that links a primary pull hash to
    // one recipient's forward transfer. The unique (primary_tx_hash,
    // recipient_wallet) index makes redelivered settlements safe.
    const claimDistribution = async ({ merchantId, subscriptionId, primaryTxHash, allocation, settledAt }) => {
        const record = {
            merchant_id: merchantId,
            subscription_id: subscriptionId,
            primary_tx_hash: primaryTxHash,
            recipient_wallet: allocation.recipient_wallet,
            split_id: allocation.id ?? null,
            label: allocation.label ?? null,
            percentage_basis_points: allocation.percentage_basis_points,
            amount_usdc_units: allocation.amount_units.toString(),
            status: 'pending',
            settled_at: settledAt,
            updated_at: now().toISOString(),
        };

        const { data, error } = await supabase
            .from('payout_distributions')
            .upsert([record], { onConflict: 'primary_tx_hash,recipient_wallet', ignoreDuplicates: true })
            .select();

        if (error) throw error;
        // Duplicate: an earlier run already created this distribution.
        if (Array.isArray(data) && data.length > 0) return { distribution: data[0], created: true };

        const { data: existing, error: lookupError } = await supabase
            .from('payout_distributions')
            .select('*')
            .eq('primary_tx_hash', primaryTxHash)
            .eq('recipient_wallet', allocation.recipient_wallet)
            .maybeSingle();
        if (lookupError) throw lookupError;
        return { distribution: existing, created: false };
    };

    const distributeOne = async (context, allocation) => {
        const { distribution, created } = await claimDistribution({ ...context, allocation });
        if (!created) {
            // Already submitted or settled by a prior delivery of this settlement.
            return { recipient_wallet: allocation.recipient_wallet, status: distribution?.status ?? 'existing', tx_hash: distribution?.split_tx_hash ?? null, amount_units: allocation.amount_units.toString(), replayed: true };
        }

        if (!forwarder) {
            return { recipient_wallet: allocation.recipient_wallet, status: 'pending', tx_hash: null, amount_units: allocation.amount_units.toString() };
        }

        try {
            const treasuryWallet = context.treasuryWallet
                || (typeof getTreasuryWallet === 'function' ? await getTreasuryWallet(context.merchantId) : null);
            if (!treasuryWallet) throw new Error('Merchant treasury wallet is unknown; cannot forward split');

            const result = await forwarder.transfer({
                from: treasuryWallet,
                to: allocation.recipient_wallet,
                amountUnits: allocation.amount_units,
                primaryTxHash: context.primaryTxHash,
            });
            const settled = result.status === 'SUCCESS';

            await supabase
                .from('payout_distributions')
                .update({
                    status: settled ? 'settled' : 'submitted',
                    split_tx_hash: result.txHash,
                    error: null,
                    updated_at: now().toISOString(),
                })
                .eq('id', distribution.id);

            // Audit log links the primary pull transaction hash to the secondary
            // split transfer hash for ledger reconciliation.
            await writeAuditLog(supabase, {
                merchantId: context.merchantId,
                actorAddress: treasuryWallet,
                action: 'payout.split.forward',
                resourceType: 'payout_distribution',
                resourceId: distribution.id,
                changesBefore: null,
                changesAfter: {
                    primary_tx_hash: context.primaryTxHash,
                    split_tx_hash: result.txHash,
                    subscription_id: context.subscriptionId,
                    recipient_wallet: allocation.recipient_wallet,
                    amount_usdc_units: allocation.amount_units.toString(),
                    percentage_basis_points: allocation.percentage_basis_points,
                    status: settled ? 'settled' : 'submitted',
                },
            });

            return {
                recipient_wallet: allocation.recipient_wallet,
                status: settled ? 'settled' : 'submitted',
                tx_hash: result.txHash,
                amount_units: allocation.amount_units.toString(),
            };
        } catch (err) {
            logger.error?.('payout split forward failed', { primary_tx_hash: context.primaryTxHash, recipient: allocation.recipient_wallet, error: err.message });
            await supabase
                .from('payout_distributions')
                .update({ status: 'failed', error: err.message, updated_at: now().toISOString() })
                .eq('id', distribution.id);
            return { recipient_wallet: allocation.recipient_wallet, status: 'failed', tx_hash: null, error: err.message, amount_units: allocation.amount_units.toString() };
        }
    };

    // Entry point for the `payment.settled` event. Returns { skipped } when the
    // merchant has no active splits configured.
    const handlePaymentSettled = async ({
        merchantId,
        subscriptionId = null,
        primaryTxHash,
        amountUnits,
        treasuryWallet = null,
        settledAt = null,
        fetchImpl = globalThis.fetch,
    }) => {
        if (!supabase || !merchantId || !primaryTxHash) return { skipped: true, distributions: [] };

        const { data: splits, error } = await supabase
            .from('merchant_payout_splits')
            .select('*')
            .eq('merchant_id', merchantId)
            .eq('is_active', true);
        if (error) throw error;
        if (!splits || splits.length === 0) return { skipped: true, distributions: [] };

        let allocations;
        try {
            allocations = allocatePayoutSplits(amountUnits, splits);
        } catch (err) {
            logger.error?.('payout split configuration is invalid', { merchant_id: merchantId, error: err.message });
            return { skipped: true, distributions: [], error: err.message };
        }
        if (allocations.length === 0) return { skipped: true, distributions: [] };

        const context = {
            merchantId,
            subscriptionId,
            primaryTxHash,
            treasuryWallet,
            settledAt: settledAt || now().toISOString(),
        };

        const distributions = [];
        for (const allocation of allocations) {
            distributions.push(await distributeOne(context, allocation));
        }

        const forwarded = distributions.filter((d) => d.status === 'settled' || d.status === 'submitted');
        if (forwarded.length > 0) {
            await dispatchWebhookEvent(supabase, {
                merchantId,
                eventType: 'payout.split.settled',
                payload: {
                    event: 'payout.split.settled',
                    primary_tx_hash: primaryTxHash,
                    subscription_id: subscriptionId,
                    amount_usdc_units: toUnits(amountUnits).toString(),
                    distributions: forwarded,
                },
                fetchImpl,
            });
        }

        return { skipped: false, primary_tx_hash: primaryTxHash, distributions };
    };

    // Re-checks in-flight split transfers and marks them settled/failed so the
    // link between the primary pull and the secondary transfer is authoritative.
    const reconcileDistributions = async ({ merchantId = null, limit = 100 } = {}) => {
        if (!supabase || !forwarder) return { checked: 0, updated: 0 };

        let query = supabase
            .from('payout_distributions')
            .select('*')
            .in('status', ['pending', 'submitted'])
            .order('created_at', { ascending: true })
            .limit(limit);
        if (merchantId) query = query.eq('merchant_id', merchantId);

        const { data: rows, error } = await query;
        if (error) throw error;

        let updated = 0;
        for (const row of rows ?? []) {
            if (!row.split_tx_hash) continue;
            const status = await forwarder.status(row.split_tx_hash);
            if (status === 'SUCCESS') {
                await supabase.from('payout_distributions').update({ status: 'settled', error: null, updated_at: now().toISOString() }).eq('id', row.id);
                updated += 1;
            } else if (status === 'FAILED') {
                await supabase.from('payout_distributions').update({ status: 'failed', error: 'Split transfer failed on-chain', updated_at: now().toISOString() }).eq('id', row.id);
                updated += 1;
            }
        }

        return { checked: (rows ?? []).length, updated };
    };

    return { handlePaymentSettled, reconcileDistributions, allocate: allocatePayoutSplits };
};

// ==========================================
// ROUTES
// ==========================================
const registerPayoutSplitRoutes = (app, getSupabase, authenticateMerchant, { dispatcher = null, resolveDispatcher = null } = {}) => {
    // Prefer a caller-supplied accessor so routes reuse the process-wide dispatcher
    // (including its configured Stellar forwarder). Falls back to a Supabase-only
    // dispatcher, whose reconcile pass is a no-op without a forwarder.
    const getDispatcher = resolveDispatcher || ((supabase) => dispatcher || createPayoutSplitDispatcher({ supabase }));

    app.get('/payout-splits', authenticateMerchant, async (req, res) => {
        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

            const { data, error } = await supabase
                .from('merchant_payout_splits')
                .select('*')
                .eq('merchant_id', req.merchant.id)
                .order('created_at', { ascending: true });
            if (error) throw error;
            res.status(200).json({ payout_splits: data ?? [] });
        } catch (err) {
            console.error('Error listing payout splits:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/payout-splits', authenticateMerchant, async (req, res) => {
        const parseResult = createPayoutSplitSchema.safeParse(req.body);
        if (!parseResult.success) return res.status(400).json({ error: formatZodError(parseResult.error) });

        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

            const { data: existing, error: existingError } = await supabase
                .from('merchant_payout_splits')
                .select('recipient_wallet, percentage_basis_points, is_active')
                .eq('merchant_id', req.merchant.id);
            if (existingError) throw existingError;

            const candidate = { ...parseResult.data, id: crypto.randomUUID() };
            try {
                validatePayoutSplits([...(existing ?? []), candidate]);
            } catch (err) {
                return res.status(422).json({ error: err.message });
            }

            const { data, error } = await supabase
                .from('merchant_payout_splits')
                .insert([{ ...parseResult.data, merchant_id: req.merchant.id }])
                .select()
                .single();
            if (error?.code === '23505') return res.status(409).json({ error: 'This recipient already has a payout split' });
            if (error) throw error;

            await writeAuditLog(supabase, {
                merchantId: req.merchant.id,
                action: 'payout_split.create',
                resourceType: 'payout_split',
                resourceId: data.id,
                changesBefore: null,
                changesAfter: data,
            });

            res.status(201).json({ message: 'Payout split created', payout_split: data });
        } catch (err) {
            console.error('Error creating payout split:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.patch('/payout-splits/:id', authenticateMerchant, async (req, res) => {
        const parseResult = updatePayoutSplitSchema.safeParse(req.body);
        if (!parseResult.success) return res.status(400).json({ error: formatZodError(parseResult.error) });

        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

            const { data: existing, error: existingError } = await supabase
                .from('merchant_payout_splits')
                .select('*')
                .eq('id', req.params.id)
                .eq('merchant_id', req.merchant.id)
                .maybeSingle();
            if (existingError) throw existingError;
            if (!existing) return res.status(404).json({ error: 'Payout split not found' });

            const { data: siblings, error: siblingsError } = await supabase
                .from('merchant_payout_splits')
                .select('recipient_wallet, percentage_basis_points, is_active')
                .eq('merchant_id', req.merchant.id);
            if (siblingsError) throw siblingsError;

            const updated = { ...existing, ...parseResult.data };
            try {
                validatePayoutSplits([...(siblings ?? []).filter((s) => s.recipient_wallet !== existing.recipient_wallet), updated]);
            } catch (err) {
                return res.status(422).json({ error: err.message });
            }

            const { data, error } = await supabase
                .from('merchant_payout_splits')
                .update({ ...parseResult.data, updated_at: new Date().toISOString() })
                .eq('id', existing.id)
                .select()
                .single();
            if (error) throw error;

            await writeAuditLog(supabase, {
                merchantId: req.merchant.id,
                action: 'payout_split.update',
                resourceType: 'payout_split',
                resourceId: data.id,
                changesBefore: existing,
                changesAfter: data,
            });

            res.status(200).json({ message: 'Payout split updated', payout_split: data });
        } catch (err) {
            console.error('Error updating payout split:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/payout-splits/:id', authenticateMerchant, async (req, res) => {
        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

            const { data, error } = await supabase
                .from('merchant_payout_splits')
                .update({ is_active: false, updated_at: new Date().toISOString() })
                .eq('id', req.params.id)
                .eq('merchant_id', req.merchant.id)
                .eq('is_active', true)
                .select()
                .maybeSingle();
            if (error) throw error;
            if (!data) return res.status(404).json({ error: 'Payout split not found or already inactive' });

            await writeAuditLog(supabase, {
                merchantId: req.merchant.id,
                action: 'payout_split.deactivate',
                resourceType: 'payout_split',
                resourceId: data.id,
                changesBefore: data,
                changesAfter: { ...data, is_active: false },
            });

            res.status(200).json({ message: 'Payout split deactivated', payout_split: data });
        } catch (err) {
            console.error('Error deactivating payout split:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/payout-distributions', authenticateMerchant, async (req, res) => {
        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

            const { data, error } = await supabase
                .from('payout_distributions')
                .select('*')
                .eq('merchant_id', req.merchant.id)
                .order('created_at', { ascending: false })
                .limit(Math.min(Number(req.query.limit) || 100, 500));
            if (error) throw error;
            res.status(200).json({ payout_distributions: data ?? [] });
        } catch (err) {
            console.error('Error listing payout distributions:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/payout-distributions/reconcile', authenticateMerchant, async (req, res) => {
        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
            const summary = await getDispatcher(supabase).reconcileDistributions({ merchantId: req.merchant.id });
            res.status(200).json(summary);
        } catch (err) {
            console.error('Error reconciling payout distributions:', err);
            res.status(500).json({ error: err.message });
        }
    });
};

module.exports = {
    BASIS_POINTS_DENOMINATOR,
    BASIS_POINTS_TOTAL,
    MAX_ACTIVE_PAYOUT_SPLITS,
    createPayoutSplitSchema,
    updatePayoutSplitSchema,
    validatePayoutSplits,
    allocatePayoutSplits,
    createStellarSplitForwarder,
    createPayoutSplitDispatcher,
    registerPayoutSplitRoutes,
};
