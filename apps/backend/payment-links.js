const { z } = require('zod');
const createSchema = z.object({
  plan_id: z.string().uuid(),
  title: z.string().trim().min(1).max(140),
  cta_text: z.string().trim().min(1).max(80).default('Pay with USDC'),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#111827'),
  redirect_url: z.string().url().refine(value => value.startsWith('https://'), 'HTTPS redirect required').optional().nullable(),
  collect_email: z.boolean().default(false),
  collect_discord: z.boolean().default(false),
}).strict();

function registerPaymentLinkRoutes(app, getSupabase, authenticateMerchant) {
  app.get('/payment-links', authenticateMerchant, async (req, res) => {
    const db = getSupabase();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });
    const { data, error } = await db.from('payment_links').select('*, plans!inner(id,name,usdc_amount,interval_seconds,currency)').eq('merchant_id', req.merchant.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Unable to retrieve payment links' });
    res.json({ links: data });
  });

  app.get('/payment-links/plans', authenticateMerchant, async (req, res) => {
    const db = getSupabase();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });
    const { data, error } = await db.from('plans').select('id,name,usdc_amount,interval_seconds,currency').eq('merchant_id', req.merchant.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Could not list plans' });
    res.json({ plans: data });
  });

  app.post('/payment-links', authenticateMerchant, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payment link options', details: parsed.error.flatten() });
    const db = getSupabase();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });
    const { data: plan, error: planError } = await db.from('plans').select('id,merchant_id').eq('id', parsed.data.plan_id).eq('merchant_id', req.merchant.id).single();
    if (planError || !plan) return res.status(404).json({ error: 'Plan not found for this merchant' });
    const { data, error } = await db.from('payment_links').insert({ ...parsed.data, merchant_id: req.merchant.id }).select().single();
    if (error) return res.status(500).json({ error: 'Could not save the payment link' });
    return res.status(201).json({ link: data });
  });

  app.get('/payment-links/:id', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Payment link not found' });
    const db = getSupabase();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });
    const { data, error } = await db.from('payment_links').select('id,plan_id,title,cta_text,accent_color,redirect_url,collect_email,collect_discord,active,plans!inner(id,name,usdc_amount,interval_seconds,currency,active,merchants(name,wallet_address,active))').eq('id', req.params.id).eq('active', true).single();
    if (error || !data) return res.status(404).json({ error: 'Payment link not found' });
    res.json({ link: data });
  });
}
module.exports = { registerPaymentLinkRoutes, createSchema };
