const { executeIdempotently, withBillingLock, sendResult } = require('./idempotency');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failureDiagnostic(message = '') {
    const text = String(message);
    let code = 'unknown';
    if (/insufficient.*balance|balance.*insufficient|balance too low/i.test(text)) code = 'insufficient_balance';
    else if (/allowance.*expir|expir.*allowance/i.test(text)) code = 'expired_allowance';
    else if (/insufficient.*allowance|allowance.*insufficient/i.test(text)) code = 'insufficient_allowance';
    else if (/timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed|NOT_FOUND/i.test(text)) code = 'rpc_timeout';
    return { code, message: text || 'The last attempt did not include a specific on-chain failure reason.' };
}

async function recordPullFailure(supabase, id, message, transactionHash = null) {
    if (!supabase) return;
    const failure = { ...failureDiagnostic(message), occurred_at: new Date().toISOString(), transaction_hash: transactionHash };
    const { error } = await supabase.from('subscriptions').update({ last_failure: failure }).eq('id', id);
    if (error) console.error('Failed to persist pull diagnostics:', error.message);
}

function registerBillingResolutionRoutes(app, getSupabase, authenticateMerchant, loadPullContext, getSorobanServer) {
    app.get('/subscriptions/:id/diagnostics', authenticateMerchant, async (req, res) => {
        try {
            if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'Invalid subscription id' });
            const supabase = getSupabase();
            if (!supabase) return res.status(503).json({ error: 'Supabase client not initialized' });
            const context = await loadPullContext(supabase, req.params.id, req.merchant);
            if (context.error) return res.status(context.status).json({ error: context.error });
            res.json({ failure: context.sub.last_failure || failureDiagnostic(), next_billing_date: context.sub.next_billing_date });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    app.post('/subscriptions/:id/check-pull', authenticateMerchant, async (req, res) => {
        try {
            if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'Invalid subscription id' });
            const supabase = getSupabase();
            if (!supabase) return res.status(503).json({ error: 'Supabase client not initialized' });
            const context = await loadPullContext(supabase, req.params.id, req.merchant);
            if (context.error) return res.status(context.status).json({ error: context.error });
            const failure = context.sub.last_failure;
            if (failure?.code !== 'rpc_timeout' || !failure.transaction_hash) return res.status(409).json({ error: 'No pending transaction is recorded; refresh this subscription.' });
            const server = getSorobanServer(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org');
            const confirmation = await server.getTransaction(failure.transaction_hash);
            if (!['SUCCESS', 'FAILED'].includes(confirmation.status)) return res.status(202).json({ status: 'NOT_FOUND', txHash: failure.transaction_hash });
            const { data, error } = await supabase.rpc('resolve_pending_pull', {
                p_subscription_id: context.sub.id, p_merchant_id: req.merchant.id,
                p_transaction_hash: failure.transaction_hash, p_succeeded: confirmation.status === 'SUCCESS',
                p_settled_at: new Date((confirmation.createdAt || Date.now() / 1000) * 1000).toISOString(),
            });
            if (error) throw error;
            if (!data) return res.status(409).json({ error: 'Pending state changed; refresh this subscription.' });
            res.json({ status: confirmation.status, txHash: failure.transaction_hash, subscription: data });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    app.post('/subscriptions/:id/waive', authenticateMerchant, async (req, res) => {
        try {
            if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'Invalid subscription id' });
            const supabase = getSupabase();
            if (!supabase) return res.status(503).json({ error: 'Supabase client not initialized' });
            const context = await loadPullContext(supabase, req.params.id, req.merchant);
            if (context.error) return res.status(context.status).json({ error: context.error });
            const result = await executeIdempotently({ supabase, req, label: 'waiving interval',
                resolveMerchant: () => ({ merchantId: req.merchant.id }) }, () => withBillingLock({
                supabase, subscriptionId: req.params.id, ttlSeconds: 60,
            }, async () => {
                const { data, error } = await supabase.rpc('waive_subscription_interval', {
                    p_subscription_id: req.params.id, p_merchant_id: req.merchant.id,
                    p_actor_address: req.merchant.wallet_address,
                });
                if (error) throw error;
                if (!data) return { status: 409, body: { error: 'Only a past-due interval without an unconfirmed charge can be waived' } };
                return { status: 200, body: { subscription: data, message: 'Interval waived; no funds were transferred.' } };
            }));
            sendResult(res, result);
        } catch (error) { res.status(500).json({ error: error.message }); }
    });
}

module.exports = { failureDiagnostic, recordPullFailure, registerBillingResolutionRoutes };
