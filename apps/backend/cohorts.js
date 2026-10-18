'use strict';

const monthKey = (value) => new Date(value).toISOString().slice(0, 7);
const monthIndex = (value) => { const d = new Date(value); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const endOfMonth = (index) => new Date(Date.UTC(Math.floor(index / 12), index % 12 + 1, 1));

function calculateCohorts(subscriptions, { planId, from, to, months = 12 } = {}) {
    const filtered = subscriptions.filter((s) => (!planId || s.plan_id === planId) && (!from || Date.parse(s.created_at) >= Date.parse(from)) && (!to || Date.parse(s.created_at) < Date.parse(to)));
    const grouped = new Map();
    for (const sub of filtered) {
        const key = monthKey(sub.created_at);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(sub);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cohort, members]) => {
        const acquired = monthIndex(members[0].created_at);
        const cells = [];
        for (let offset = 0; offset < months; offset += 1) {
            const boundary = endOfMonth(acquired + offset);
            if (boundary > new Date()) break;
            const retained = [], churned = [];
            for (const member of members) {
                const events = [...(member.subscription_status_history || member.history || [])].sort((a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at));
                let status = 'active';
                for (const event of events) if (Date.parse(event.changed_at) < boundary.getTime()) status = event.status;
                (status === 'active' || status === 'pending_pull' ? retained : churned).push(member.customer_wallet_address);
            }
            cells.push({ month: offset, retained: retained.length, retention: members.length ? Math.round(retained.length * 10000 / members.length) / 100 : 0, churned_wallets: churned });
        }
        return { cohort, acquired: members.length, cells };
    });
}

function registerCohortRoutes(app, getSupabase, authenticateMerchant) {
    app.get('/analytics/cohorts', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(503).json({ error: 'Database not configured' });
        const { data, error } = await supabase.from('subscriptions').select('id,plan_id,customer_wallet_address,created_at,plans!inner(merchant_id,name),subscription_status_history(status,changed_at)').eq('plans.merchant_id', req.merchant.id);
        if (error) throw error;
        const cohorts = calculateCohorts(data || [], { planId: req.query.plan_id, from: req.query.from, to: req.query.to, months: Math.min(24, Math.max(1, Number(req.query.months) || 12)) });
        res.json({ cohorts });
    });
}
module.exports = { calculateCohorts, registerCohortRoutes };
