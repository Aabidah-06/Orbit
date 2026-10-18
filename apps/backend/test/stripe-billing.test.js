import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import {
    StripeSignatureError,
    signStripePayload,
    stripeSubscriptionMrr,
    verifyStripeSignature,
} from '../stripe-billing.js';
import { createFakeSupabase } from './fakeSupabase.js';
import { makeApiKey } from './helpers.js';

const SECRET = 'whsec_test_secret_for_orbit_131';
const merchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
const connectMerchantId = '4c4de2b4-7c2b-47ab-95ea-759d88911472';
const wallet = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const subscriptionObject = (overrides = {}) => ({
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'active',
    current_period_end: 1_800_000_000,
    metadata: { orbit_merchant_id: merchantId },
    items: { data: [{ quantity: 1, price: { unit_amount: 2900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] },
    ...overrides,
});
const stripeEvent = (id, type, object, extra = {}) => ({ id, type, created: 1_700_000_000, data: { object }, ...extra });

const deliver = (event, { secret = SECRET, header } = {}) => {
    const body = JSON.stringify(event);
    return request(app)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', header ?? signStripePayload(body, secret))
        .send(body);
};

let db;
let apiKey;

beforeEach(() => {
    apiKey = makeApiKey({ merchantId, walletAddress: wallet });
    db = createFakeSupabase({
        api_keys: [apiKey.row],
        merchants: [
            { id: merchantId, wallet_address: wallet, name: 'Acme', stripe_account_id: null },
            { id: connectMerchantId, wallet_address: 'GOTHER', name: 'Connect Co', stripe_account_id: 'acct_connect' },
        ],
        subscriptions: [
            // 10 USDC every 30 days, active
            { id: 'c1', status: 'active', plans: { merchant_id: merchantId, usdc_amount: 100_000_000, interval_seconds: 2_592_000 } },
            { id: 'c2', status: 'cancelled', plans: { merchant_id: merchantId, usdc_amount: 100_000_000, interval_seconds: 2_592_000 } },
        ],
    }, {
        unique: {
            stripe_webhook_events: [['event_id']],
            fiat_payments: [['stripe_invoice_id']],
            fiat_subscriptions: [['stripe_subscription_id']],
        },
    });
    app.locals.supabase = db;
    app.locals.stripeWebhookSecret = SECRET;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
});

afterAll(() => {
    delete app.locals.stripeWebhookSecret;
    delete app.locals.supabase;
});

describe('Stripe signature verification (#131)', () => {
    const body = JSON.stringify(stripeEvent('evt_sig', 'invoice.paid', { id: 'in_1' }));
    const now = 1_700_000_100_000;
    const ts = Math.floor(now / 1000);

    it('accepts a valid v1 signature and returns the parsed event', () => {
        const event = verifyStripeSignature({ payload: body, header: signStripePayload(body, SECRET, ts), secrets: SECRET, now });
        expect(event.id).toBe('evt_sig');
    });

    it('accepts any configured secret so endpoint secrets can be rotated', () => {
        const header = signStripePayload(body, 'whsec_new', ts);
        expect(verifyStripeSignature({ payload: body, header, secrets: `${SECRET},whsec_new`, now }).id).toBe('evt_sig');
    });

    it('rejects a wrong secret, a tampered body, stale timestamps and malformed headers', () => {
        const header = signStripePayload(body, SECRET, ts);
        const verify = (overrides) => () => verifyStripeSignature({ payload: body, header, secrets: SECRET, now, ...overrides });
        expect(verify({ secrets: 'whsec_wrong' })).toThrow(StripeSignatureError);
        expect(verify({ payload: body.replace('in_1', 'in_2') })).toThrow(StripeSignatureError);
        expect(verify({ now: now + 301_000 })).toThrow(/tolerance/);
        expect(verify({ header: `t=${ts}` })).toThrow(/Malformed/);
        expect(verify({ header: undefined })).toThrow(/Missing/);
        expect(verify({ secrets: '' })).toThrow(/not configured/);
    });
});

describe('MRR normalization', () => {
    it('normalizes intervals and quantities to monthly minor units', () => {
        expect(stripeSubscriptionMrr(subscriptionObject())).toEqual({ mrr_minor: 2900, currency: 'usd' });
        const yearly = subscriptionObject({ items: { data: [{ quantity: 2, price: { unit_amount: 12000, currency: 'EUR', recurring: { interval: 'year', interval_count: 1 } } }] } });
        expect(stripeSubscriptionMrr(yearly)).toEqual({ mrr_minor: 2000, currency: 'eur' });
        const quarterly = subscriptionObject({ items: { data: [{ price: { unit_amount: 9000, currency: 'usd', recurring: { interval: 'month', interval_count: 3 } } }] } });
        expect(stripeSubscriptionMrr(quarterly).mrr_minor).toBe(3000);
    });
});

describe('POST /webhooks/stripe', () => {
    it('rejects deliveries with an invalid signature without touching the database', async () => {
        const res = await deliver(stripeEvent('evt_bad', 'customer.subscription.created', subscriptionObject()), { secret: 'whsec_attacker' });
        expect(res.status).toBe(400);
        expect(db.tables.stripe_webhook_events).toBeUndefined();
        expect(db.tables.fiat_subscriptions).toBeUndefined();
    });

    it('rejects deliveries with no signature header', async () => {
        const res = await deliver(stripeEvent('evt_none', 'invoice.paid', {}), { header: '' });
        expect(res.status).toBe(400);
    });

    it('returns 503 when no webhook secret is configured', async () => {
        delete app.locals.stripeWebhookSecret;
        const previous = process.env.STRIPE_WEBHOOK_SECRET;
        delete process.env.STRIPE_WEBHOOK_SECRET;
        const res = await deliver(stripeEvent('evt_cfg', 'invoice.paid', {}));
        if (previous !== undefined) process.env.STRIPE_WEBHOOK_SECRET = previous;
        expect(res.status).toBe(503);
    });

    it('syncs customer.subscription.created to the merchant from metadata', async () => {
        const res = await deliver(stripeEvent('evt_created', 'customer.subscription.created', subscriptionObject()));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ received: true, status: 'processed', outcome: 'subscription_synced', merchant_id: merchantId });

        expect(db.tables.fiat_subscriptions).toHaveLength(1);
        expect(db.tables.fiat_subscriptions[0]).toMatchObject({
            merchant_id: merchantId,
            stripe_subscription_id: 'sub_1',
            stripe_customer_id: 'cus_1',
            status: 'active',
            currency: 'usd',
            mrr_minor: 2900,
        });
        expect(db.tables.stripe_webhook_events[0]).toMatchObject({ event_id: 'evt_created', status: 'processed' });
    });

    it('maps Stripe Connect events through merchants.stripe_account_id', async () => {
        const object = subscriptionObject({ id: 'sub_connect', metadata: {} });
        const res = await deliver(stripeEvent('evt_connect', 'customer.subscription.created', object, { account: 'acct_connect' }));
        expect(res.body.merchant_id).toBe(connectMerchantId);
        expect(db.tables.fiat_subscriptions[0].merchant_id).toBe(connectMerchantId);
    });

    it('records invoice.paid once and marks the subscription active', async () => {
        await deliver(stripeEvent('evt_created', 'customer.subscription.created', subscriptionObject({ status: 'incomplete' })));
        const invoice = { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_paid: 2900, currency: 'usd', status_transitions: { paid_at: 1_700_000_050 } };
        const res = await deliver({ ...stripeEvent('evt_paid', 'invoice.paid', invoice), created: 1_700_000_060 });

        expect(res.body).toMatchObject({ status: 'processed', outcome: 'payment_recorded', merchant_id: merchantId });
        expect(db.tables.fiat_payments).toHaveLength(1);
        expect(db.tables.fiat_payments[0]).toMatchObject({ stripe_invoice_id: 'in_1', amount_minor: 2900, merchant_id: merchantId });
        expect(db.tables.fiat_subscriptions[0].status).toBe('active');
    });

    it('reads the subscription from parent.subscription_details on newer API versions', async () => {
        const invoice = {
            id: 'in_2', customer: 'cus_1', amount_paid: 500, currency: 'usd',
            parent: { subscription_details: { subscription: 'sub_new', metadata: { orbit_merchant_id: merchantId } } },
        };
        const res = await deliver(stripeEvent('evt_paid_new', 'invoice.paid', invoice));
        expect(res.body.merchant_id).toBe(merchantId);
        expect(db.tables.fiat_payments[0].stripe_subscription_id).toBe('sub_new');
    });

    it('marks customer.subscription.deleted as canceled', async () => {
        await deliver(stripeEvent('evt_created', 'customer.subscription.created', subscriptionObject()));
        const res = await deliver({
            ...stripeEvent('evt_deleted', 'customer.subscription.deleted', subscriptionObject({ status: 'canceled', canceled_at: 1_700_000_500 })),
            created: 1_700_000_500,
        });
        expect(res.body.outcome).toBe('subscription_canceled');
        expect(db.tables.fiat_subscriptions[0]).toMatchObject({ status: 'canceled', canceled_at: new Date(1_700_000_500_000).toISOString() });
    });

    it('ignores replayed and duplicate events idempotently', async () => {
        const invoice = { id: 'in_dup', customer: 'cus_1', subscription: 'sub_1', amount_paid: 2900, currency: 'usd', metadata: { orbit_merchant_id: merchantId } };
        const event = stripeEvent('evt_dup', 'invoice.paid', invoice);

        const first = await deliver(event);
        const replay = await deliver(event);
        const [concurrentA, concurrentB] = await Promise.all([
            deliver(stripeEvent('evt_race', 'customer.subscription.created', subscriptionObject({ id: 'sub_race' }))),
            deliver(stripeEvent('evt_race', 'customer.subscription.created', subscriptionObject({ id: 'sub_race' }))),
        ]);

        expect(first.body.status).toBe('processed');
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual({ received: true, status: 'duplicate' });
        expect([concurrentA.body.status, concurrentB.body.status].sort()).toEqual(['duplicate', 'processed']);
        expect(db.tables.fiat_payments).toHaveLength(1);
        expect(db.tables.fiat_subscriptions).toHaveLength(1);
        expect(db.tables.stripe_webhook_events.map((e) => e.event_id).sort()).toEqual(['evt_dup', 'evt_race']);
    });

    it('does not let an older event overwrite newer subscription state', async () => {
        await deliver({ ...stripeEvent('evt_deleted', 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' })), created: 1_700_000_900 });
        const res = await deliver({ ...stripeEvent('evt_created_late', 'customer.subscription.created', subscriptionObject()), created: 1_700_000_000 });
        expect(res.body.outcome).toBe('stale');
        expect(db.tables.fiat_subscriptions[0].status).toBe('canceled');
    });

    it('acknowledges events for unknown merchants and unhandled types without recording them', async () => {
        const unmapped = await deliver(stripeEvent('evt_unmapped', 'customer.subscription.created', subscriptionObject({ metadata: {} })));
        expect(unmapped.body).toMatchObject({ status: 'ignored', outcome: 'unmapped_merchant' });
        expect(db.tables.fiat_subscriptions ?? []).toHaveLength(0);

        const other = await deliver(stripeEvent('evt_other', 'charge.refunded', {}));
        expect(other.body).toMatchObject({ status: 'ignored', reason: 'unhandled_event_type' });
    });

    it('releases the event claim when processing fails so Stripe can retry', async () => {
        const original = db.from;
        db.from = (table) => {
            if (table === 'fiat_subscriptions') {
                const builder = original(table);
                builder.upsert = () => ({ then: (resolve) => resolve({ error: { message: 'connection reset' } }) });
                return builder;
            }
            return original(table);
        };
        const event = stripeEvent('evt_retry', 'customer.subscription.created', subscriptionObject());
        const failed = await deliver(event);
        expect(failed.status).toBe(500);
        expect(db.tables.stripe_webhook_events).toHaveLength(0);

        db.from = original;
        const retried = await deliver(event);
        expect(retried.body.status).toBe('processed');
    });
});

describe('GET /billing/unified-summary', () => {
    it('requires merchant authentication', async () => {
        expect((await request(app).get('/billing/unified-summary')).status).toBe(401);
    });

    it('unifies MRR and subscriber counts across USDC and Stripe rails', async () => {
        await deliver(stripeEvent('evt_a', 'customer.subscription.created', subscriptionObject()));
        await deliver(stripeEvent('evt_b', 'customer.subscription.created', subscriptionObject({
            id: 'sub_eur',
            items: { data: [{ quantity: 1, price: { unit_amount: 1000, currency: 'eur', recurring: { interval: 'month' } } }] },
        })));
        await deliver(stripeEvent('evt_c', 'customer.subscription.created', subscriptionObject({ id: 'sub_gone' })));
        await deliver({ ...stripeEvent('evt_d', 'customer.subscription.deleted', subscriptionObject({ id: 'sub_gone' })), created: 1_700_000_100 });

        const res = await request(app).get('/billing/unified-summary').set('Authorization', apiKey.header);
        expect(res.status).toBe(200);
        // 10 USDC per 30 days ~= 10.15 USDC per average month
        expect(res.body.crypto).toEqual({ active_subscribers: 1, mrr_usdc_units: '101456250', mrr_usd: '10.15' });
        expect(res.body.fiat).toEqual({ active_subscribers: 2, mrr_minor_by_currency: { usd: '2900', eur: '1000' }, mrr_usd: '29.00' });
        expect(res.body.total).toEqual({ active_subscribers: 3, mrr_usd: '39.15', unconverted_currencies: ['eur'] });
    });
});
