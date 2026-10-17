'use strict';

const { z } = require('zod');

const codeSchema = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/, 'code must contain only letters, digits, underscores or hyphens');
const uuidSchema = z.string().uuid();
const couponCreateSchema = z.object({
    code: codeSchema,
    discount_type: z.enum(['percent', 'amount']),
    discount_value: z.number().finite().positive(),
    duration_months: z.number().int().min(1).max(120).default(1),
    max_redemptions: z.number().int().min(1).nullable().optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().superRefine((data, ctx) => {
    if (data.discount_type === 'percent' && data.discount_value > 99) {
        ctx.addIssue({ code: 'custom', path: ['discount_value'], message: 'percent discount must not exceed 99%' });
    }
    if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
        ctx.addIssue({ code: 'custom', path: ['expires_at'], message: 'expires_at must be in the future' });
    }
});
const couponUpdateSchema = z.object({
    active: z.boolean().optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
    max_redemptions: z.number().int().positive().nullable().optional(),
}).strict().refine(x => Object.keys(x).length > 0, 'at least one field is required');
const validationSchema = z.object({ plan_id: uuidSchema, code: codeSchema }).strict();

function normalizeCode(code) { return code.trim().toUpperCase(); }
function errorMessage(error) {
    const first = error.issues[0];
    return `Invalid input on ${first.path.join('.') || 'input'}: ${first.message}`;
}
function couponIsValid(coupon, now = Date.now()) {
    return Boolean(coupon && coupon.active !== false &&
        (!coupon.expires_at || Date.parse(coupon.expires_at) > now) &&
        (coupon.max_redemptions == null || Number(coupon.redemptions_count) < Number(coupon.max_redemptions)));
}
function baseAmount(plan) {
    const currency = plan.currency || 'USDC';
    const original = Number(currency === 'USDC' ? plan.usdc_amount : plan.price_amount);
    if (!Number.isFinite(original) || original <= 0 || (currency === 'USDC' && !Number.isSafeInteger(original))) {
        throw new RangeError('plan has no valid price');
    }
    return { original, currency };
}
function calculateDiscount(plan, coupon) {
    const { original, currency } = baseAmount(plan);
    const precision = currency === 'USDC' ? 1 : 100;
    if (currency !== 'USDC' && !['USD', 'EUR'].includes(currency)) throw new RangeError('unsupported plan currency');
    const value = Number(coupon.discount_value);
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('invalid coupon value');
    if (coupon.discount_type !== 'percent' && coupon.discount_type !== 'amount') throw new RangeError('invalid coupon type');
    if (coupon.discount_type === 'percent' && value > 99) throw new RangeError('percentage cap exceeded');
    // Monetary calculations are truncated to the smallest representable unit;
    // USDC plans already store raw 7-decimal token units, fiat uses cents.
    const discounted = coupon.discount_type === 'percent'
        ? Math.floor((original * (100 - value) / 100) * precision + 1e-7) / precision
        : Math.floor((original - value) * precision + 1e-7) / precision;
    if (!Number.isFinite(discounted) || discounted <= 0 || discounted >= original) {
        throw new RangeError('coupon must produce a positive discounted price below the plan price');
    }
    return {
        currency,
        original_amount: original,
        discounted_amount: discounted,
        savings: Number((original - discounted).toFixed(currency === 'USDC' ? 0 : 2)),
        duration_months: Number(coupon.duration_months),
    };
}

// Called from index.js with its existing merchant API-key authentication middleware.
function registerCouponRoutes(app, getSupabase, authenticateMerchant) {
    app.post('/coupons', authenticateMerchant, async (req, res) => {
        const parsed = couponCreateSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: errorMessage(parsed.error) });
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        const row = { ...parsed.data, merchant_id: req.merchant.id, code: normalizeCode(parsed.data.code) };
        try {
            const { data, error } = await supabase.from('coupons').insert([row]).select().single();
            if (error?.code === '23505') return res.status(409).json({ error: 'Coupon code already exists for this merchant' });
            if (error) throw error;
            return res.status(201).json({ coupon: data });
        } catch (err) {
            console.error('Error creating coupon:', err);
            return res.status(500).json({ error: 'Failed to create coupon' });
        }
    });

    app.get('/coupons', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const { data, error } = await supabase.from('coupons').select('*').eq('merchant_id', req.merchant.id).order('created_at', { ascending: false });
            if (error) throw error;
            return res.json({ coupons: data ?? [] });
        } catch (err) {
            console.error('Error listing coupons:', err);
            return res.status(500).json({ error: 'Failed to list coupons' });
        }
    });

    app.patch('/coupons/:id', authenticateMerchant, async (req, res) => {
        const id = uuidSchema.safeParse(req.params.id);
        const parsed = couponUpdateSchema.safeParse(req.body);
        if (!id.success || !parsed.success) return res.status(400).json({ error: 'Invalid coupon identifier or update' });
        if (parsed.data.expires_at && new Date(parsed.data.expires_at).getTime() <= Date.now()) {
            return res.status(400).json({ error: 'expires_at must be in the future; use active:false to disable a coupon' });
        }
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const { data, error } = await supabase.from('coupons').update(parsed.data)
                .eq('id', id.data).eq('merchant_id', req.merchant.id).select().maybeSingle();
            if (error?.code === '23514') return res.status(409).json({ error: 'max_redemptions cannot be below the number already redeemed' });
            if (error) throw error;
            if (!data) return res.status(404).json({ error: 'Coupon not found' });
            return res.json({ coupon: data });
        } catch (err) {
            console.error('Error updating coupon:', err);
            return res.status(500).json({ error: 'Failed to update coupon' });
        }
    });

    app.post('/coupons/validate', async (req, res) => {
        const parsed = validationSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: errorMessage(parsed.error) });
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const { data: plan, error: planError } = await supabase.from('plans')
                .select('id, merchant_id, currency, usdc_amount, price_amount').eq('id', parsed.data.plan_id).maybeSingle();
            if (planError) throw planError;
            if (!plan) return res.status(404).json({ error: 'Plan not found' });
            const { data: coupon, error } = await supabase.from('coupons')
                .select('*').eq('merchant_id', plan.merchant_id).eq('code', normalizeCode(parsed.data.code)).maybeSingle();
            if (error) throw error;
            if (!couponIsValid(coupon) || coupon.merchant_id !== plan.merchant_id) return res.status(422).json({ valid: false, error: 'Coupon is invalid or unavailable' });
            let quote;
            try { quote = calculateDiscount(plan, coupon); }
            catch { return res.status(422).json({ valid: false, error: 'Coupon is not valid for this plan' }); }
            return res.json({ valid: true, code: coupon.code, ...quote, expires_at: coupon.expires_at || null,
                // Checkout price quote only; a Stellar vault must be authorized
                // with corresponding promo terms to enforce this on-chain.
                onchain_enforcement: 'requires-compatible-vault' });
        } catch (err) {
            console.error('Error validating coupon:', err);
            return res.status(500).json({ error: 'Failed to validate coupon' });
        }
    });
}

module.exports = { registerCouponRoutes, calculateDiscount, couponIsValid, normalizeCode };
