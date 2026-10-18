'use strict';

const crypto = require('node:crypto');

// Stripe fiat billing bridge (#131): receives Stripe subscription webhooks,
// mirrors them into fiat_subscriptions / fiat_payments under the Orbit
// merchant, and reports MRR and subscriber counts across fiat and USDC rails.

const SIGNATURE_TOLERANCE_SECONDS = 300;
const HANDLED_EVENTS = new Set([
    'customer.subscription.created',
    'invoice.paid',
    'customer.subscription.deleted',
]);
// Fiat subscriptions in these Stripe states count as paying subscribers
const FIAT_ACTIVE_STATUSES = ['active', 'trialing'];
// Average Gregorian month, used to normalize every billing interval to MRR
const SECONDS_PER_MONTH = (365.2425 * 86400) / 12;
const MONTHS_PER_INTERVAL = { day: 12 / 365.2425, week: 12 / 52.1775, month: 1, year: 12 };
const USDC_UNITS_PER_DOLLAR = 10_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class StripeSignatureError extends Error {}

const webhookSecrets = (configured) => String(configured || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Verifies a `Stripe-Signature` header (`t=<unix>,v1=<hex hmac>,...`) against
 * the raw request body, as Stripe documents: HMAC-SHA256 of `${t}.${body}`
 * keyed by the endpoint secret, compared in constant time, with a timestamp
 * tolerance against replays. Any matching secret is accepted so secrets can be
 * rotated. Returns the parsed event.
 */
function verifyStripeSignature({ payload, header, secrets, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS, now = Date.now() }) {
    const candidates = Array.isArray(secrets) ? secrets : webhookSecrets(secrets);
    if (!candidates.length) throw new StripeSignatureError('Stripe webhook secret is not configured');
    if (typeof header !== 'string' || !header) throw new StripeSignatureError('Missing Stripe-Signature header');
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');

    let timestamp = null;
    const signatures = [];
    for (const part of header.split(',')) {
        const [key, value] = part.split('=', 2).map((s) => s?.trim());
        if (key === 't' && /^\d+$/.test(value || '')) timestamp = Number(value);
        if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value || '')) signatures.push(Buffer.from(value, 'hex'));
    }
    if (timestamp === null || !signatures.length) throw new StripeSignatureError('Malformed Stripe-Signature header');
    if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) {
        throw new StripeSignatureError('Stripe-Signature timestamp is outside the tolerance window');
    }

    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
    const valid = candidates.some((secret) => {
        const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest();
        return signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(sig, expected));
    });
    if (!valid) throw new StripeSignatureError('No valid Stripe signature found');

    let event;
    try { event = JSON.parse(body.toString('utf8')); }
    catch { throw new StripeSignatureError('Stripe payload is not valid JSON'); }
    if (typeof event?.id !== 'string' || typeof event?.type !== 'string') {
        throw new StripeSignatureError('Stripe payload is not an event');
    }
    return event;
}

// Builds a header the way Stripe does; used by tests and local tooling
function signStripePayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    return `t=${timestamp},v1=${signature}`;
}

// Monthly recurring revenue of a Stripe subscription, in the price's minor units
function stripeSubscriptionMrr(subscription) {
    const items = subscription?.items?.data || [];
    let currency = null;
    let mrr = 0;
    for (const item of items) {
        const price = item.price || item.plan || {};
        const recurring = price.recurring || { interval: price.interval, interval_count: price.interval_count };
        const months = MONTHS_PER_INTERVAL[recurring.interval];
        const unitAmount = Number(price.unit_amount ?? price.amount ?? 0);
        if (!months || !Number.isFinite(unitAmount)) continue;
        const count = Number(recurring.interval_count) || 1;
        mrr += (unitAmount * (Number(item.quantity) || 1)) / (months * count);
        currency ||= price.currency;
    }
    return { mrr_minor: Math.round(mrr), currency: (currency || subscription?.currency || 'usd').toLowerCase() };
}

const toIso = (unixSeconds) => (Number.isFinite(Number(unixSeconds)) && unixSeconds !== null
    ? new Date(Number(unixSeconds) * 1000).toISOString()
    : null);

const idOf = (value) => (typeof value === 'string' ? value : value?.id ?? null);

// Stripe moved invoice.subscription under parent.subscription_details in 2025 API versions
const invoiceSubscriptionId = (invoice) => idOf(invoice.subscription)
    ?? idOf(invoice.parent?.subscription_details?.subscription);

const invoiceMetadata = (invoice) => ({
    ...(invoice.subscription_details?.metadata || {}),
    ...(invoice.parent?.subscription_details?.metadata || {}),
    ...(invoice.metadata || {}),
});

/**
 * Resolves which Orbit merchant a Stripe event belongs to: a Stripe Connect
 * account linked through merchants.stripe_account_id, else an
 * `orbit_merchant_id` metadata key the merchant sets on the subscription, else
 * the merchant of a subscription we already mirror.
 */
async function resolveMerchantId(supabase, event, { metadata, stripeSubscriptionId }) {
    if (typeof event.account === 'string') {
        const { data, error } = await supabase.from('merchants').select('id')
            .eq('stripe_account_id', event.account).maybeSingle();
        if (error) throw error;
        if (data) return data.id;
    }
    const metadataId = metadata?.orbit_merchant_id;
    if (typeof metadataId === 'string' && UUID_RE.test(metadataId)) {
        const { data, error } = await supabase.from('merchants').select('id').eq('id', metadataId).maybeSingle();
        if (error) throw error;
        if (data) return data.id;
    }
    if (stripeSubscriptionId) {
        const { data, error } = await supabase.from('fiat_subscriptions').select('merchant_id')
            .eq('stripe_subscription_id', stripeSubscriptionId).maybeSingle();
        if (error) throw error;
        if (data) return data.merchant_id;
    }
    return null;
}

async function loadFiatSubscription(supabase, stripeSubscriptionId) {
    const { data, error } = await supabase.from('fiat_subscriptions').select('*')
        .eq('stripe_subscription_id', stripeSubscriptionId).maybeSingle();
    if (error) throw error;
    return data;
}

// Events can arrive out of order; never let an older event overwrite newer state
const isStale = (row, event) => row && Number(row.last_event_created) > Number(event.created);

async function syncSubscription(supabase, event, merchantId) {
    const subscription = event.data.object;
    const existing = await loadFiatSubscription(supabase, subscription.id);
    if (isStale(existing, event)) return 'stale';

    const { mrr_minor, currency } = stripeSubscriptionMrr(subscription);
    const deleted = event.type === 'customer.subscription.deleted';
    const now = new Date().toISOString();
    const row = {
        merchant_id: merchantId,
        stripe_subscription_id: subscription.id,
        stripe_customer_id: idOf(subscription.customer),
        status: deleted ? 'canceled' : String(subscription.status || 'active'),
        currency,
        mrr_minor,
        current_period_end: toIso(subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end),
        canceled_at: deleted ? (toIso(subscription.canceled_at ?? subscription.ended_at) || now) : null,
        last_event_created: Number(event.created) || 0,
        updated_at: now,
    };
    const { error } = await supabase.from('fiat_subscriptions').upsert(row, { onConflict: 'stripe_subscription_id' });
    if (error) throw error;
    return deleted ? 'subscription_canceled' : 'subscription_synced';
}

async function recordInvoicePaid(supabase, event, merchantId) {
    const invoice = event.data.object;
    const stripeSubscriptionId = invoiceSubscriptionId(invoice);
    const { error } = await supabase.from('fiat_payments').insert([{
        merchant_id: merchantId,
        stripe_invoice_id: invoice.id,
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: idOf(invoice.customer),
        amount_minor: Number(invoice.amount_paid) || 0,
        currency: String(invoice.currency || 'usd').toLowerCase(),
        paid_at: toIso(invoice.status_transitions?.paid_at ?? invoice.created) || new Date().toISOString(),
    }]);
    // The invoice was already recorded (e.g. Stripe sent two events for it)
    if (error && error.code !== '23505') throw error;

    if (stripeSubscriptionId) {
        const existing = await loadFiatSubscription(supabase, stripeSubscriptionId);
        if (existing && !isStale(existing, event) && existing.status !== 'canceled') {
            const { error: updateError } = await supabase.from('fiat_subscriptions')
                .update({ status: 'active', last_event_created: Number(event.created) || 0, updated_at: new Date().toISOString() })
                .eq('stripe_subscription_id', stripeSubscriptionId);
            if (updateError) throw updateError;
        }
    }
    return 'payment_recorded';
}

/**
 * Applies one verified Stripe event. Idempotent on the event id: the id is
 * claimed in stripe_webhook_events first, so a replay or a concurrent duplicate
 * delivery is acknowledged without recording anything twice. A failed event
 * releases its claim so Stripe's retry can process it again.
 */
async function processStripeEvent(supabase, event) {
    if (!HANDLED_EVENTS.has(event.type)) return { status: 'ignored', reason: 'unhandled_event_type' };

    const { error: claimError } = await supabase.from('stripe_webhook_events').insert([{
        event_id: event.id,
        event_type: event.type,
        status: 'processing',
        received_at: new Date().toISOString(),
    }]);
    if (claimError?.code === '23505') return { status: 'duplicate' };
    if (claimError) throw claimError;

    try {
        const object = event.data?.object || {};
        const isInvoice = event.type === 'invoice.paid';
        const stripeSubscriptionId = isInvoice ? invoiceSubscriptionId(object) : object.id;
        const merchantId = await resolveMerchantId(supabase, event, {
            metadata: isInvoice ? invoiceMetadata(object) : object.metadata,
            stripeSubscriptionId,
        });

        let outcome;
        if (!merchantId) outcome = 'unmapped_merchant';
        else if (isInvoice) outcome = await recordInvoicePaid(supabase, event, merchantId);
        else outcome = await syncSubscription(supabase, event, merchantId);

        const { error } = await supabase.from('stripe_webhook_events')
            .update({
                merchant_id: merchantId,
                status: merchantId ? 'processed' : 'ignored',
                outcome,
                processed_at: new Date().toISOString(),
            })
            .eq('event_id', event.id);
        if (error) throw error;
        return { status: merchantId ? 'processed' : 'ignored', outcome, merchant_id: merchantId };
    } catch (err) {
        await supabase.from('stripe_webhook_events').delete().eq('event_id', event.id);
        throw err;
    }
}

const formatUnits = (minor, decimals) => (Number(minor) / 10 ** decimals).toFixed(2);

// Unified MRR and subscriber counts for one merchant across USDC (Orbit) and fiat (Stripe)
async function unifiedBillingSummary(supabase, merchantId) {
    const [crypto, fiat] = await Promise.all([
        supabase.from('subscriptions')
            .select('id, status, plans!inner(merchant_id, usdc_amount, interval_seconds)')
            .eq('plans.merchant_id', merchantId)
            .eq('status', 'active'),
        supabase.from('fiat_subscriptions')
            .select('stripe_subscription_id, status, currency, mrr_minor')
            .eq('merchant_id', merchantId)
            .in('status', FIAT_ACTIVE_STATUSES),
    ]);
    if (crypto.error) throw crypto.error;
    if (fiat.error) throw fiat.error;

    let cryptoMrrUnits = 0;
    for (const sub of crypto.data || []) {
        const interval = Number(sub.plans?.interval_seconds);
        const amount = Number(sub.plans?.usdc_amount);
        if (interval > 0 && Number.isFinite(amount)) cryptoMrrUnits += (amount * SECONDS_PER_MONTH) / interval;
    }

    const fiatByCurrency = {};
    for (const sub of fiat.data || []) {
        const currency = String(sub.currency || 'usd').toLowerCase();
        fiatByCurrency[currency] = (fiatByCurrency[currency] || 0) + (Number(sub.mrr_minor) || 0);
    }

    const cryptoMrrUsd = cryptoMrrUnits / USDC_UNITS_PER_DOLLAR;
    const fiatMrrUsd = (fiatByCurrency.usd || 0) / 100;
    const cryptoCount = (crypto.data || []).length;
    const fiatCount = (fiat.data || []).length;
    return {
        merchant_id: merchantId,
        crypto: {
            active_subscribers: cryptoCount,
            mrr_usdc_units: String(Math.round(cryptoMrrUnits)),
            mrr_usd: cryptoMrrUsd.toFixed(2),
        },
        fiat: {
            active_subscribers: fiatCount,
            mrr_minor_by_currency: Object.fromEntries(Object.entries(fiatByCurrency).map(([c, v]) => [c, String(v)])),
            mrr_usd: fiatMrrUsd.toFixed(2),
        },
        total: {
            active_subscribers: cryptoCount + fiatCount,
            // USDC is counted 1:1 with USD; non-USD fiat MRR is reported per
            // currency above and left out of this total rather than guessed.
            mrr_usd: formatUnits(Math.round((cryptoMrrUsd + fiatMrrUsd) * 100), 2),
            unconverted_currencies: Object.keys(fiatByCurrency).filter((c) => c !== 'usd'),
        },
    };
}

// express.json() `verify` hook: keep the exact bytes Stripe signed for this route only
function captureStripeRawBody(req, _res, buf) {
    if (req.originalUrl?.split('?')[0] === '/webhooks/stripe') req.rawBody = Buffer.from(buf);
}

function registerStripeBillingRoutes(app, getSupabase, authenticateMerchant) {
    const secrets = () => webhookSecrets(app.locals.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET);

    app.post('/webhooks/stripe', async (req, res) => {
        if (!secrets().length) return res.status(503).json({ error: 'Stripe webhooks are not configured' });

        let event;
        try {
            event = verifyStripeSignature({
                payload: req.rawBody ?? Buffer.alloc(0),
                header: req.get('stripe-signature'),
                secrets: secrets(),
            });
        } catch (err) {
            if (err instanceof StripeSignatureError) return res.status(400).json({ error: err.message });
            throw err;
        }

        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            const result = await processStripeEvent(supabase, event);
            return res.status(200).json({ received: true, ...result });
        } catch (err) {
            console.error('Error processing Stripe webhook:', event.id, err);
            // Non-2xx makes Stripe retry the delivery
            return res.status(500).json({ error: 'Failed to process Stripe event' });
        }
    });

    app.get('/billing/unified-summary', authenticateMerchant, async (req, res) => {
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
        try {
            return res.json(await unifiedBillingSummary(supabase, req.merchant.id));
        } catch (err) {
            console.error('Error building unified billing summary:', err);
            return res.status(500).json({ error: 'Failed to build billing summary' });
        }
    });
}

module.exports = {
    HANDLED_EVENTS,
    StripeSignatureError,
    captureStripeRawBody,
    processStripeEvent,
    registerStripeBillingRoutes,
    signStripePayload,
    stripeSubscriptionMrr,
    unifiedBillingSummary,
    verifyStripeSignature,
};
