// Automated recurring plan price indexation & inflation adjustment (#164)
//
// Long-term B2B retainer plans frequently carry scheduled price adjustments
// (annual cost-of-living or indexation increases). This pipeline:
//   1. stores the intent to change a plan's price in `plan_price_schedules`
//      (effective_date, new_usdc_amount, status, advance_notice_days);
//   2. notifies affected subscribers once the change enters the advance-notice
//      window (default 30 days) so nobody is surprised by a new charge;
//   3. applies the new price to the plan on the effective date; and
//   4. hands every subscriber a one-click re-authorization link to approve the
//      updated allowance terms before the change takes effect.
const crypto = require('crypto');
const { z } = require('zod');
const { dispatchWebhookEvent } = require('./webhooks');
const { writeAuditLog } = require('./audit');

const DEFAULT_ADVANCE_NOTICE_DAYS = 30;
const MAX_ADVANCE_NOTICE_DAYS = 365;
const DEFAULT_REAUTHORIZATION_TTL_DAYS = 60;
const DEFAULT_WORKER_INTERVAL_MS = 15 * 60 * 1000;
const NOTIFIABLE_STATUSES = ['scheduled'];
const APPLICABLE_STATUSES = ['scheduled', 'notified'];

const createPriceScheduleSchema = z.object({
    effective_date: z.coerce.date({ message: 'effective_date must be a valid date' }),
    new_usdc_amount: z.coerce
        .number()
        .int('new_usdc_amount must be an integer in raw token units')
        .positive('new_usdc_amount must be greater than 0'),
    new_price_amount: z.coerce.number().positive('new_price_amount must be greater than 0').optional(),
    advance_notice_days: z.coerce
        .number()
        .int()
        .min(0)
        .max(MAX_ADVANCE_NOTICE_DAYS)
        .optional()
        .default(DEFAULT_ADVANCE_NOTICE_DAYS),
});

const formatZodError = (err) => {
    const issue = err.issues[0];
    const field = issue.path.join('.') || 'input';
    return `Invalid input on ${field}: ${issue.message}`;
};

const toDate = (value) => (value instanceof Date ? value : new Date(value));
const isoOrNull = (value) => (value ? toDate(value).toISOString() : null);

// Whole days between now and the effective date (negative once it has passed).
const daysUntil = (effectiveDate, now = new Date()) =>
    Math.ceil((toDate(effectiveDate).getTime() - toDate(now).getTime()) / (24 * 60 * 60 * 1000));

// True while a still-scheduled change sits inside its advance-notice window.
const isWithinNoticeWindow = (schedule, now = new Date()) => {
    if (schedule.status !== 'scheduled') return false;
    const noticeDays = Number.isFinite(Number(schedule.advance_notice_days))
        ? Number(schedule.advance_notice_days)
        : DEFAULT_ADVANCE_NOTICE_DAYS;
    const remaining = daysUntil(schedule.effective_date, now);
    return remaining <= noticeDays && remaining >= 0;
};

const buildReauthorizationUrl = (subscriptionId, token, { frontendUrl, planId } = {}) => {
    const baseUrl = frontendUrl || process.env.FRONTEND_URL || 'https://useorbit.xyz';
    const plan = planId ? `/pay/${planId}` : '';
    return `${baseUrl}${plan}?reauth=true&subscription_id=${subscriptionId}&token=${token}`;
};

// ==========================================
// WORKER
// ==========================================
const createPriceIndexationWorker = ({
    supabase,
    logger = console,
    now = () => new Date(),
    fetchImpl,
    frontendUrl,
    reauthorizationTtlDays = DEFAULT_REAUTHORIZATION_TTL_DAYS,
} = {}) => {
    const notifySchedule = async (schedule) => {
        const { data: plan, error: planError } = await supabase
            .from('plans')
            .select('*, merchants(id, name, wallet_address)')
            .eq('id', schedule.plan_id)
            .single();
        if (planError) throw planError;
        if (!plan) return { schedule_id: schedule.id, notified: 0 };

        const { data: subscriptions, error: subsError } = await supabase
            .from('subscriptions')
            .select('id, customer_wallet_address, status')
            .eq('plan_id', schedule.plan_id)
            .in('status', ['active', 'past_due']);
        if (subsError) throw subsError;

        const noticeDays = schedule.advance_notice_days ?? DEFAULT_ADVANCE_NOTICE_DAYS;
        const notices = [];

        for (const subscription of subscriptions ?? []) {
            const token = crypto.randomBytes(24).toString('hex');
            const expiresAt = new Date(toDate(now()).getTime() + reauthorizationTtlDays * 24 * 60 * 60 * 1000).toISOString();

            // One re-authorization request per (schedule, subscription); a rerun
            // of the worker reuses the existing row instead of minting a new token.
            const { data: existing } = await supabase
                .from('plan_price_reauthorizations')
                .select('*')
                .eq('schedule_id', schedule.id)
                .eq('subscription_id', subscription.id)
                .maybeSingle();

            if (existing?.status === 'authorized') continue;

            const reauth = existing
                ? (await supabase.from('plan_price_reauthorizations').update({ expires_at: expiresAt }).eq('id', existing.id).select().single()).data
                : (await supabase.from('plan_price_reauthorizations').insert([{
                    schedule_id: schedule.id,
                    subscription_id: subscription.id,
                    token,
                    status: 'pending',
                    expires_at: expiresAt,
                }]).select().single()).data;

            const reauthorizationUrl = buildReauthorizationUrl(subscription.id, reauth?.token ?? token, {
                frontendUrl,
                planId: schedule.plan_id,
            });

            await writeAuditLog(supabase, {
                merchantId: plan.merchant_id,
                actorAddress: subscription.customer_wallet_address,
                action: 'subscription.price_change_notice',
                resourceType: 'subscription',
                resourceId: subscription.id,
                changesBefore: { usdc_amount: plan.usdc_amount },
                changesAfter: {
                    schedule_id: schedule.id,
                    new_usdc_amount: String(schedule.new_usdc_amount),
                    effective_date: isoOrNull(schedule.effective_date),
                    advance_notice_days: noticeDays,
                    reauthorization_url: reauthorizationUrl,
                },
            });

            notices.push({
                subscription_id: subscription.id,
                customer_wallet_address: subscription.customer_wallet_address,
                reauthorization_url: reauthorizationUrl,
            });
        }

        await supabase
            .from('plan_price_schedules')
            .update({ status: 'notified', notified_at: now().toISOString(), updated_at: now().toISOString() })
            .eq('id', schedule.id);

        await writeAuditLog(supabase, {
            merchantId: plan.merchant_id,
            action: 'plan.price_change_notified',
            resourceType: 'plan_price_schedule',
            resourceId: schedule.id,
            changesBefore: { status: schedule.status },
            changesAfter: {
                status: 'notified',
                plan_id: schedule.plan_id,
                new_usdc_amount: String(schedule.new_usdc_amount),
                effective_date: isoOrNull(schedule.effective_date),
                affected_subscriptions: notices.length,
            },
        });

        await dispatchWebhookEvent(supabase, {
            merchantId: plan.merchant_id,
            eventType: 'plan.price_change_upcoming',
            payload: {
                event: 'plan.price_change_upcoming',
                plan_id: schedule.plan_id,
                schedule_id: schedule.id,
                usdc_amount: plan.usdc_amount,
                new_usdc_amount: schedule.new_usdc_amount,
                effective_date: isoOrNull(schedule.effective_date),
                advance_notice_days: noticeDays,
                days_until_effective: daysUntil(schedule.effective_date, now()),
                subscribers: notices,
            },
            fetchImpl,
        });

        return { schedule_id: schedule.id, notified: notices.length };
    };

    const applySchedule = async (schedule) => {
        const { data: plan, error: planError } = await supabase
            .from('plans')
            .select('*')
            .eq('id', schedule.plan_id)
            .single();
        if (planError) throw planError;
        if (!plan) return { schedule_id: schedule.id, applied: false };

        const update = {
            usdc_amount: schedule.new_usdc_amount,
            updated_at: now().toISOString(),
        };
        if (schedule.new_price_amount !== null && schedule.new_price_amount !== undefined) {
            update.price_amount = schedule.new_price_amount;
        }

        const { error: updateError } = await supabase.from('plans').update(update).eq('id', schedule.plan_id);
        if (updateError) throw updateError;

        await supabase
            .from('plan_price_schedules')
            .update({ status: 'applied', applied_at: now().toISOString(), updated_at: now().toISOString() })
            .eq('id', schedule.id);

        await writeAuditLog(supabase, {
            merchantId: plan.merchant_id,
            action: 'plan.price_change_applied',
            resourceType: 'plan_price_schedule',
            resourceId: schedule.id,
            changesBefore: { usdc_amount: plan.usdc_amount, price_amount: plan.price_amount },
            changesAfter: { usdc_amount: schedule.new_usdc_amount, price_amount: update.price_amount ?? plan.price_amount, effective_date: isoOrNull(schedule.effective_date) },
        });

        await dispatchWebhookEvent(supabase, {
            merchantId: plan.merchant_id,
            eventType: 'plan.price_changed',
            payload: {
                event: 'plan.price_changed',
                plan_id: schedule.plan_id,
                schedule_id: schedule.id,
                previous_usdc_amount: plan.usdc_amount,
                new_usdc_amount: schedule.new_usdc_amount,
                effective_date: isoOrNull(schedule.effective_date),
            },
            fetchImpl,
        });

        return { schedule_id: schedule.id, applied: true, previous_usdc_amount: String(plan.usdc_amount), new_usdc_amount: String(schedule.new_usdc_amount) };
    };

    // Dispatches notices for schedules inside the notice window, then applies
    // schedules whose effective date has arrived. Notices run first so a schedule
    // can never be applied without ever having been announced.
    const runOnce = async () => {
        if (!supabase) return { notified: 0, applied: 0, errors: 0 };

        const metrics = { notified: 0, applied: 0, errors: 0 };

        const { data: pending, error: pendingError } = await supabase
            .from('plan_price_schedules')
            .select('*')
            .in('status', NOTIFIABLE_STATUSES);
        if (pendingError) throw pendingError;

        for (const schedule of pending ?? []) {
            if (!isWithinNoticeWindow(schedule, now())) continue;
            try {
                const result = await notifySchedule(schedule);
                metrics.notified += result.notified;
            } catch (err) {
                metrics.errors += 1;
                logger.error?.('price indexation notification failed', { schedule_id: schedule.id, error: err.message });
            }
        }

        const { data: due, error: dueError } = await supabase
            .from('plan_price_schedules')
            .select('*')
            .in('status', APPLICABLE_STATUSES)
            .lte('effective_date', now().toISOString());
        if (dueError) throw dueError;

        for (const schedule of due ?? []) {
            try {
                await applySchedule(schedule);
                metrics.applied += 1;
            } catch (err) {
                metrics.errors += 1;
                logger.error?.('price indexation apply failed', { schedule_id: schedule.id, error: err.message });
            }
        }

        return metrics;
    };

    const start = (intervalMs = DEFAULT_WORKER_INTERVAL_MS) => {
        let stopped = false;
        let current = null;
        const tick = async () => {
            current = runOnce().catch((err) => {
                logger.error?.('price indexation worker run failed', { error: err.message });
                return { notified: 0, applied: 0, errors: 1 };
            });
            await current;
            current = null;
            if (!stopped) timer = setTimeout(tick, intervalMs);
        };
        let timer = setTimeout(tick, 0);
        if (typeof timer.unref === 'function') timer.unref();

        return {
            async stop() {
                stopped = true;
                clearTimeout(timer);
                await current;
            },
            runOnce,
        };
    };

    return { runOnce, start, notifySchedule, applySchedule };
};

// ==========================================
// SUBSCRIBER RE-AUTHORIZATION
// ==========================================
// Consumes a one-click re-authorization token and confirms the subscriber accepts
// the updated allowance terms. The action is idempotent and refuses expired links.
const authorizePriceChange = async (supabase, token, { now = () => new Date() } = {}) => {
    if (!supabase || !token) return { status: 400, body: { error: 'token is required' } };

    const { data: reauth, error } = await supabase
        .from('plan_price_reauthorizations')
        .select('*, plan_price_schedules(*)')
        .eq('token', token)
        .maybeSingle();
    if (error) throw error;
    if (!reauth) return { status: 404, body: { error: 'Re-authorization link not found' } };
    if (reauth.status === 'authorized') {
        return { status: 200, body: { message: 'Terms already accepted', subscription_id: reauth.subscription_id } };
    }
    if (toDate(reauth.expires_at) <= toDate(now())) {
        return { status: 410, body: { error: 'Re-authorization link has expired' } };
    }

    const authorizedAt = now().toISOString();
    const { error: updateError } = await supabase
        .from('plan_price_reauthorizations')
        .update({ status: 'authorized', authorized_at: authorizedAt })
        .eq('id', reauth.id);
    if (updateError) throw updateError;

    const schedule = reauth.plan_price_schedules;
    const { data: plan } = await supabase.from('plans').select('id, merchant_id, currency, interval_seconds').eq('id', schedule?.plan_id).maybeSingle();

    await writeAuditLog(supabase, {
        merchantId: plan?.merchant_id ?? null,
        action: 'subscription.price_change_reauthorized',
        resourceType: 'subscription',
        resourceId: reauth.subscription_id,
        changesBefore: { status: 'pending' },
        changesAfter: {
            status: 'authorized',
            schedule_id: reauth.schedule_id,
            new_usdc_amount: schedule ? String(schedule.new_usdc_amount) : null,
            effective_date: isoOrNull(schedule?.effective_date),
            authorized_at: authorizedAt,
        },
    });

    // Terms the subscriber must now authorize on-chain (new allowance amount).
    return {
        status: 200,
        body: {
            message: 'Updated terms accepted',
            subscription_id: reauth.subscription_id,
            plan_id: plan?.id ?? schedule?.plan_id ?? null,
            new_usdc_amount: schedule?.new_usdc_amount ?? null,
            effective_date: isoOrNull(schedule?.effective_date),
            authorized_at: authorizedAt,
        },
    };
};

// ==========================================
// ROUTES
// ==========================================
const registerPriceIndexationRoutes = (app, getSupabase, authenticateMerchant, { worker = null } = {}) => {
    const resolveWorker = (supabase) => worker || createPriceIndexationWorker({ supabase });

    app.get('/plans/:id/price-schedules', authenticateMerchant, async (req, res) => {
        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

            const { data: plan, error: planError } = await supabase
                .from('plans')
                .select('id, merchant_id')
                .eq('id', req.params.id)
                .maybeSingle();
            if (planError) throw planError;
            if (!plan || plan.merchant_id !== req.merchant.id) return res.status(404).json({ error: 'Plan not found' });

            const { data, error } = await supabase
                .from('plan_price_schedules')
                .select('*')
                .eq('plan_id', req.params.id)
                .order('effective_date', { ascending: true });
            if (error) throw error;
            res.status(200).json({ price_schedules: data ?? [] });
        } catch (err) {
            console.error('Error listing price schedules:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/plans/:id/price-schedules', authenticateMerchant, async (req, res) => {
        const parseResult = createPriceScheduleSchema.safeParse(req.body);
        if (!parseResult.success) return res.status(400).json({ error: formatZodError(parseResult.error) });

        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

            const { data: plan, error: planError } = await supabase
                .from('plans')
                .select('id, merchant_id, usdc_amount')
                .eq('id', req.params.id)
                .maybeSingle();
            if (planError) throw planError;
            if (!plan || plan.merchant_id !== req.merchant.id) return res.status(404).json({ error: 'Plan not found' });

            const opts = parseResult.data;
            const { data, error } = await supabase
                .from('plan_price_schedules')
                .insert([{
                    plan_id: plan.id,
                    merchant_id: plan.merchant_id,
                    effective_date: toDate(opts.effective_date).toISOString(),
                    new_usdc_amount: opts.new_usdc_amount,
                    new_price_amount: opts.new_price_amount ?? null,
                    advance_notice_days: opts.advance_notice_days,
                    status: 'scheduled',
                }])
                .select()
                .single();
            if (error?.code === '23505') return res.status(409).json({ error: 'A price change is already scheduled for that effective date' });
            if (error) throw error;

            await writeAuditLog(supabase, {
                merchantId: req.merchant.id,
                action: 'plan.price_change_scheduled',
                resourceType: 'plan_price_schedule',
                resourceId: data.id,
                changesBefore: { usdc_amount: plan.usdc_amount },
                changesAfter: data,
            });

            res.status(201).json({ message: 'Price change scheduled', price_schedule: data });
        } catch (err) {
            console.error('Error scheduling price change:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/price-schedules/:id', authenticateMerchant, async (req, res) => {
        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

            const { data, error } = await supabase
                .from('plan_price_schedules')
                .update({ status: 'cancelled', updated_at: new Date().toISOString() })
                .eq('id', req.params.id)
                .eq('merchant_id', req.merchant.id)
                .in('status', ['scheduled', 'notified'])
                .select()
                .maybeSingle();
            if (error) throw error;
            if (!data) return res.status(404).json({ error: 'Price schedule not found or already finalised' });

            await writeAuditLog(supabase, {
                merchantId: req.merchant.id,
                action: 'plan.price_change_cancelled',
                resourceType: 'plan_price_schedule',
                resourceId: data.id,
                changesBefore: data,
                changesAfter: { ...data, status: 'cancelled' },
            });

            res.status(200).json({ message: 'Price schedule cancelled', price_schedule: data });
        } catch (err) {
            console.error('Error cancelling price schedule:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/price-schedules/process', authenticateMerchant, async (req, res) => {
        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
            const metrics = await resolveWorker(supabase).runOnce();
            res.status(200).json(metrics);
        } catch (err) {
            console.error('Error processing price schedules:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Public: a subscriber accepts the updated allowance terms from the emailed link.
    app.post('/price-reauthorizations/:token/authorize', async (req, res) => {
        try {
            const supabase = getSupabase();
            if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
            const result = await authorizePriceChange(supabase, req.params.token);
            res.status(result.status).json(result.body);
        } catch (err) {
            console.error('Error authorizing price change:', err);
            res.status(500).json({ error: err.message });
        }
    });
};

module.exports = {
    DEFAULT_ADVANCE_NOTICE_DAYS,
    MAX_ADVANCE_NOTICE_DAYS,
    DEFAULT_REAUTHORIZATION_TTL_DAYS,
    createPriceScheduleSchema,
    daysUntil,
    isWithinNoticeWindow,
    buildReauthorizationUrl,
    createPriceIndexationWorker,
    authorizePriceChange,
    registerPriceIndexationRoutes,
};
