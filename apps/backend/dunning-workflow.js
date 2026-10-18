const { z } = require('zod');

// Default cadence matches the original fixed schedule: Day 1 / 3 / 5 / 7.
const STEP_TYPES = ['polite_reminder', 'urgent_notice', 'grace_discount', 'recovery_link', 'final_attempt'];
const MAX_STEPS = 10;
const MAX_DAY = 30;
const MAX_TEMPLATE_LENGTH = 5000;

const PLACEHOLDERS = ['merchant_name', 'plan_name', 'amount', 'customer_wallet', 'recovery_url', 'day', 'discount_pct'];

const DEFAULT_WORKFLOW_STEPS = [
    {
        day: 1, retry_pull: true, step_type: 'polite_reminder',
        email_subject: 'Your {{plan_name}} payment failed',
        email_body: 'Hi, we could not process your payment of {{amount}} for {{plan_name}}. We will retry automatically. You can also pay now: {{recovery_url}}',
    },
    {
        day: 3, retry_pull: true, step_type: 'urgent_notice',
        email_subject: 'Action needed: {{plan_name}} payment still failing',
        email_body: 'Your {{plan_name}} subscription is still past due. Please update your payment method today: {{recovery_url}}',
    },
    {
        day: 5, retry_pull: true, step_type: 'grace_discount', grace_discount_pct: 10,
        email_subject: 'A 10% grace discount on {{plan_name}}',
        email_body: 'Pay within the next two days and receive {{discount_pct}}% off your outstanding balance: {{recovery_url}}',
    },
    {
        day: 7, retry_pull: true, step_type: 'final_attempt',
        email_subject: 'Final notice for {{plan_name}}',
        email_body: 'This is our final attempt to collect your payment. If it fails, your subscription will be cancelled.',
    },
];

const stepSchema = z.object({
    day: z.number().int().min(1).max(MAX_DAY),
    retry_pull: z.boolean(),
    step_type: z.enum(STEP_TYPES),
    grace_discount_pct: z.number().min(0).max(100).optional(),
    email_subject: z.string().min(1).max(200),
    email_body: z.string().min(1).max(MAX_TEMPLATE_LENGTH),
});

const workflowSchema = z.object({
    steps: z.array(stepSchema).min(1, 'at least one step is required').max(MAX_STEPS, `at most ${MAX_STEPS} steps are allowed`),
});

const findUnknownPlaceholders = (text) => {
    const found = [...String(text).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    return [...new Set(found.filter((key) => !PLACEHOLDERS.includes(key)))];
};

/**
 * Returns human-readable problems with a workflow, or an empty array when it is
 * valid. The schema checks shape; this checks the sequence rules.
 */
const validateWorkflowSteps = (steps) => {
    const errors = [];
    steps.forEach((step, i) => {
        if (i > 0 && step.day <= steps[i - 1].day) {
            errors.push(`step ${i + 1} must run after step ${i} (days must strictly increase)`);
        }
        if (step.step_type === 'grace_discount' && step.grace_discount_pct === undefined) {
            errors.push(`step ${i + 1} is a grace discount and needs grace_discount_pct`);
        }
        for (const field of ['email_subject', 'email_body']) {
            const unknown = findUnknownPlaceholders(step[field]);
            if (unknown.length) errors.push(`step ${i + 1} ${field} uses unknown placeholder(s): ${unknown.join(', ')}`);
        }
    });
    const last = steps[steps.length - 1];
    if (last && last.step_type !== 'final_attempt') {
        errors.push('the last step must be a final_attempt, which cancels the subscription if it fails');
    }
    return errors;
};

/** Replaces `{{name}}` placeholders. Unknown placeholders are left as written. */
const renderDunningTemplate = (text, vars = {}) => String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    if (!PLACEHOLDERS.includes(key)) return match;
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
});

const scheduleFromSteps = (steps) => steps.map((step) => step.day);

/** Raw-unit sum that avoids float drift on NUMERIC amounts. */
const sumRawUnits = (values) => values.reduce((total, value) => total + BigInt(String(value ?? 0).split('.')[0] || '0'), 0n);

/**
 * Recovery funnel over subscriptions that entered dunning. Amounts are raw token
 * units, returned as strings. Definitions:
 * - failed: the subscription entered dunning (its payment failed)
 * - recovered: it was paid during dunning
 * - net churn prevented: recovered subscriptions and their volume, the revenue
 *   that would otherwise have churned
 */
const computeRecoveryFunnel = (rows) => {
    const inDunning = rows.filter((r) => r.dunning_status);
    const recovered = inDunning.filter((r) => r.dunning_status === 'recovered');
    const exhausted = inDunning.filter((r) => r.dunning_status === 'exhausted');
    const recoveredVolume = sumRawUnits(recovered.map((r) => r.usdc_amount));
    return {
        failed_invoices: inDunning.length,
        recovered_invoices: recovered.length,
        exhausted_invoices: exhausted.length,
        failed_volume: sumRawUnits(inDunning.map((r) => r.usdc_amount)).toString(),
        recovered_volume: recoveredVolume.toString(),
        net_churn_prevented_count: recovered.length,
        net_churn_prevented_volume: recoveredVolume.toString(),
        recovery_rate: inDunning.length ? recovered.length / inDunning.length : 0,
    };
};

const loadDunningWorkflow = async (supabase, merchantId) => {
    if (!supabase || !merchantId) return null;
    const { data, error } = await supabase
        .from('dunning_workflows')
        .select('steps, updated_at')
        .eq('merchant_id', merchantId)
        .maybeSingle();
    if (error || !data) return null;
    return { steps: data.steps, updated_at: data.updated_at };
};

function registerDunningWorkflowRoutes(app, getSupabase, authenticateMerchant) {
    app.get('/dunning/workflow', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const saved = await loadDunningWorkflow(supabase, req.merchant.id);
            res.json({
                steps: saved ? saved.steps : DEFAULT_WORKFLOW_STEPS,
                is_default: !saved,
                updated_at: saved?.updated_at || null,
                placeholders: PLACEHOLDERS,
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/dunning/workflow', authenticateMerchant, async (req, res) => {
        const parsed = workflowSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
        const problems = validateWorkflowSteps(parsed.data.steps);
        if (problems.length) return res.status(400).json({ error: problems[0], problems });

        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const { data, error } = await supabase
                .from('dunning_workflows')
                .upsert({ merchant_id: req.merchant.id, steps: parsed.data.steps, updated_at: new Date().toISOString() }, { onConflict: 'merchant_id' })
                .select('steps, updated_at')
                .single();
            if (error) throw error;
            res.json({ steps: data.steps, updated_at: data.updated_at, is_default: false });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/dunning/analytics', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const { data, error } = await supabase
                .from('subscriptions')
                .select('status, dunning_status, plans!inner(merchant_id, usdc_amount)')
                .eq('plans.merchant_id', req.merchant.id)
                .not('dunning_status', 'is', null);
            if (error) throw error;
            const rows = (data || []).map((sub) => ({ ...sub, usdc_amount: sub.plans?.usdc_amount }));
            res.json({ funnel: computeRecoveryFunnel(rows) });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
}

module.exports = {
    STEP_TYPES,
    PLACEHOLDERS,
    DEFAULT_WORKFLOW_STEPS,
    workflowSchema,
    validateWorkflowSteps,
    findUnknownPlaceholders,
    renderDunningTemplate,
    scheduleFromSteps,
    computeRecoveryFunnel,
    loadDunningWorkflow,
    registerDunningWorkflowRoutes,
};
