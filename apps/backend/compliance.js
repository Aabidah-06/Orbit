const { z } = require('zod');

const exportQuery = z.object({
    year: z.coerce.number().int().min(2000).max(3000),
    format: z.enum(['json', 'csv']).default('json'),
});

function registerComplianceRoutes(app, getSupabase, authenticateMerchant) {
    app.get('/compliance/tax-export', authenticateMerchant, async (req, res) => {
        const parsed = exportQuery.safeParse(req.query);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const start = `${parsed.data.year}-01-01T00:00:00.000Z`;
            const end = `${parsed.data.year + 1}-01-01T00:00:00.000Z`;
            const { data, error } = await supabase.from('tax_transactions').select('*')
                .eq('merchant_id', req.merchant.id).gte('created_at', start).lt('created_at', end)
                .order('created_at', { ascending: true });
            if (error) throw error;
            if (parsed.data.format === 'csv') {
                const rows = data || [];
                const columns = ['recipient_wallet', 'amount', 'currency', 'tax_type', 'created_at'];
                const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => JSON.stringify(row[key] ?? '')).join(','))].join('\n');
                res.type('text/csv').attachment(`orbit-tax-${parsed.data.year}.csv`).send(csv);
            } else res.json({ year: parsed.data.year, records: data || [] });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
}

module.exports = { registerComplianceRoutes };

