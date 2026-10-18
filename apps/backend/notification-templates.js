'use strict';

const TEMPLATE_TYPES = ['payment_receipt', 'subscription_activated', 'payment_failed', 'subscription_cancelled'];
const VARIABLES = ['customer_wallet', 'amount', 'tx_hash', 'portal_link'];
const defaults = Object.fromEntries(TEMPLATE_TYPES.map((type) => [type, { type, subject: type.replaceAll('_', ' '), markdown: 'Hello **{{customer_wallet}}**,\n\nYour subscription update is ready.' }]));
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderMarkdown(markdown, variables = {}) {
    let safe = escapeHtml(markdown).replace(/\{\{([a-z_]+)\}\}/g, (_, name) => escapeHtml(Object.hasOwn(variables, name) ? variables[name] : `{{${name}}}`));
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>').replace(/\n/g, '<br>');
    return `<div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#18181b">${safe}</div>`;
}
async function sendWithResend({ fetchImpl, apiKey, from, to, subject, html }) {
    const response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, html }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `Mail provider HTTP ${response.status}`);
    return body.id;
}
function registerNotificationTemplateRoutes(app, getSupabase, authenticateMerchant) {
    app.get('/notification-templates', authenticateMerchant, async (req, res) => {
        const { data, error } = await getSupabase().from('notification_templates').select('type,subject,markdown,updated_at').eq('merchant_id', req.merchant.id);
        if (error) throw error;
        const saved = Object.fromEntries((data || []).map((t) => [t.type, t]));
        res.json({ templates: TEMPLATE_TYPES.map((type) => saved[type] || defaults[type]), variables: VARIABLES });
    });
    app.put('/notification-templates/:type', authenticateMerchant, async (req, res) => {
        const type = req.params.type, { subject, markdown } = req.body || {};
        if (!TEMPLATE_TYPES.includes(type) || typeof subject !== 'string' || !subject.trim() || subject.length > 200 || typeof markdown !== 'string' || !markdown.trim() || markdown.length > 20000) return res.status(400).json({ error: 'Invalid notification template' });
        const unknown = [...`${subject}\n${markdown}`.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]).filter((v) => !VARIABLES.includes(v));
        if (unknown.length) return res.status(400).json({ error: `Unknown template variable: ${unknown[0]}` });
        const row = { merchant_id: req.merchant.id, type, subject: subject.trim(), markdown, updated_at: new Date().toISOString() };
        const { data, error } = await getSupabase().from('notification_templates').upsert(row, { onConflict: 'merchant_id,type' }).select('type,subject,markdown,updated_at').single();
        if (error) throw error; res.json({ template: data });
    });
    app.post('/notification-templates/:type/test', authenticateMerchant, async (req, res) => {
        const type = req.params.type;
        if (!TEMPLATE_TYPES.includes(type)) return res.status(404).json({ error: 'Template not found' });
        if (!process.env.RESEND_API_KEY || !process.env.NOTIFICATION_FROM_EMAIL) return res.status(503).json({ error: 'Email delivery is not configured' });
        const supabase = getSupabase();
        const [{ data: merchant, error: merchantError }, { data: template, error: templateError }] = await Promise.all([
            supabase.from('merchants').select('notification_email').eq('id', req.merchant.id).single(),
            supabase.from('notification_templates').select('subject,markdown').eq('merchant_id', req.merchant.id).eq('type', type).maybeSingle(),
        ]);
        if (merchantError || templateError) throw merchantError || templateError;
        if (!merchant?.notification_email) return res.status(409).json({ error: 'Set a verified merchant notification email before sending tests' });
        const selected = template || defaults[type];
        const variables = { customer_wallet: req.merchant.wallet_address, amount: '29.00 USDC', tx_hash: 'test-transaction', portal_link: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard` };
        const subject = selected.subject.replace(/\{\{([a-z_]+)\}\}/g, (_, name) => String(variables[name] || `{{${name}}}`));
        const id = await sendWithResend({ fetchImpl: app.locals.fetchImpl || globalThis.fetch, apiKey: process.env.RESEND_API_KEY, from: process.env.NOTIFICATION_FROM_EMAIL, to: merchant.notification_email, subject, html: renderMarkdown(selected.markdown, variables) });
        res.status(202).json({ message: 'Test email accepted by provider', provider_message_id: id, recipient: merchant.notification_email });
    });
}
module.exports = { TEMPLATE_TYPES, VARIABLES, renderMarkdown, sendWithResend, registerNotificationTemplateRoutes };
