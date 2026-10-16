const crypto = require('crypto');

function registerSigningSessionRoutes(app, getSupabase, authenticateMerchant) {
    app.post('/signing-sessions', authenticateMerchant, async (req, res) => {
        const { xdr, required_signers = 1, expires_in_seconds = 900 } = req.body || {};
        if (typeof xdr !== 'string' || !xdr || !Number.isInteger(required_signers) || required_signers < 1) return res.status(400).json({ error: 'xdr and a positive required_signers are required' });
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const id = crypto.randomUUID();
        const { data, error } = await supabase.from('signing_sessions').insert([{ id, merchant_id: req.merchant.id, xdr, required_signers, signatures: {}, status: 'pending', expires_at: new Date(Date.now() + Math.min(expires_in_seconds, 3600) * 1000).toISOString() }]).select().single();
        if (error) return res.status(500).json({ error: error.message });
        res.status(201).json({ session: data });
    });

    app.post('/signing-sessions/:id/signatures', authenticateMerchant, async (req, res) => {
        const { signer, signed_xdr } = req.body || {};
        if (!signer || !signed_xdr) return res.status(400).json({ error: 'signer and signed_xdr are required' });
        const supabase = getSupabase();
        const { data: session, error } = await supabase.from('signing_sessions').select('*').eq('id', req.params.id).eq('merchant_id', req.merchant.id).single();
        if (error || !session) return res.status(404).json({ error: 'Signing session not found' });
        if (session.status !== 'pending' || new Date(session.expires_at) <= new Date()) return res.status(409).json({ error: 'Signing session is no longer active' });
        const signatures = { ...(session.signatures || {}), [signer]: signed_xdr };
        const status = Object.keys(signatures).length >= session.required_signers ? 'ready' : 'pending';
        const { data, error: updateError } = await supabase.from('signing_sessions').update({ signatures, status }).eq('id', session.id).select().single();
        if (updateError) return res.status(500).json({ error: updateError.message });
        res.json({ session: data });
    });
}

module.exports = { registerSigningSessionRoutes };

