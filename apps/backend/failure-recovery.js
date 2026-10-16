function registerFailureRecoveryRoutes(app, getSupabase, authenticateMerchant) {
    app.get('/admin/failures', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const { data, error } = await supabase.from('webhook_deliveries').select('*, webhooks(url)').eq('merchant_id', req.merchant.id).eq('status', 'failed').order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ failures: data || [] });
    });
    app.post('/admin/failures/:id/retry', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const { data, error } = await supabase.from('webhook_deliveries').update({ status: 'queued', next_retry_at: new Date().toISOString() }).eq('id', req.params.id).eq('merchant_id', req.merchant.id).select().single();
        if (error || !data) return res.status(404).json({ error: 'Failure not found' });
        res.json({ message: 'Failure queued for retry', delivery: data });
    });
}

module.exports = { registerFailureRecoveryRoutes };

