import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { calculateDiscount, couponIsValid } from '../coupons.js';
import { makeApiKey } from './helpers.js';

const merchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
const planId = 'e0b8e99b-5136-4d1d-9351-91a5db4fb056';
const otherMerchant = '4c4de2b4-7c2b-47ab-95ea-759d88911472';
const wallet = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const original = { id: planId, merchant_id: merchantId, currency: 'USDC', usdc_amount: 290000000 };
const coupon = { id: 'd494d3bd-9655-4e64-8500-8c9dcd903e4f', merchant_id: merchantId,
    code: 'WELCOME20', discount_type: 'percent', discount_value: 20,
    duration_months: 3, active: true, redemptions_count: 0, max_redemptions: 2, expires_at: null };

function chain(final) {
    const query = {};
    for (const name of ['select', 'eq', 'order', 'update', 'insert']) query[name] = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: final, error: null }));
    query.single = vi.fn(async () => ({ data: final, error: null }));
    // Awaited by writeAuditLog: it returns { error } through a thenable Supabase builder.
    query.then = (resolve) => resolve({ data: null, error: null });
    return query;
}

let apiKey;
let couponsQuery;
let plansQuery;
let tables;

beforeEach(() => {
    apiKey = makeApiKey({ merchantId, walletAddress: wallet });
    couponsQuery = chain(coupon);
    plansQuery = chain(original);
    tables = {
        api_keys: chain(apiKey.row),
        coupons: couponsQuery,
        plans: plansQuery,
        audit_logs: chain(null),
    };
    app.locals.supabase = {
        from: vi.fn((table) => tables[table] || chain(null)),
        rpc: vi.fn(async () => ({ data: null, error: null })),
    };
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
});

describe('Coupon pricing (#75)', () => {
    it('computes USDC raw-unit percentage discounts and duration', () => {
        expect(calculateDiscount(original, coupon)).toEqual({
            currency: 'USDC', original_amount: 290000000,
            discounted_amount: 232000000, savings: 58000000, duration_months: 3,
        });
    });
    it('computes fixed discounts and fiat decimals without negative totals', () => {
        expect(calculateDiscount(original, { ...coupon, discount_type: 'amount', discount_value: 10000000 }).discounted_amount).toBe(280000000);
        expect(calculateDiscount({ currency: 'USD', price_amount: 12.99 }, { ...coupon, discount_type: 'percent', discount_value: 20 }).discounted_amount).toBe(10.39);
        expect(() => calculateDiscount(original, { ...coupon, discount_type: 'amount', discount_value: 290000000 })).toThrow();
    });
    it('rejects expired, disabled, and exhausted coupons', () => {
        expect(couponIsValid(coupon)).toBe(true);
        expect(couponIsValid({ ...coupon, active: false })).toBe(false);
        expect(couponIsValid({ ...coupon, redemptions_count: 2 })).toBe(false);
        expect(couponIsValid({ ...coupon, expires_at: '2020-01-01T00:00:00Z' })).toBe(false);
    });
    it('enforces the percentage cap', () => {
        expect(() => calculateDiscount(original, { ...coupon, discount_value: 100 })).toThrow();
    });
});

describe('Coupon merchant management and checkout', () => {
    it('requires merchant authentication to create coupons', async () => {
        const response = await request(app).post('/coupons').send({ code: 'WELCOME20', discount_type: 'percent', discount_value: 20 });
        expect(response.status).toBe(401);
    });
    it('rejects >99% codes even for authorized merchants', async () => {
        const res = await request(app).post('/coupons').set('Authorization', apiKey.header)
            .send({ code: 'FREE', discount_type: 'percent', discount_value: 100 });
        expect(res.status).toBe(400);
        expect(couponsQuery.insert).not.toHaveBeenCalled();
    });
    it('scopes created coupons to authenticated merchant and uppercases codes', async () => {
        const res = await request(app).post('/coupons').set('Authorization', apiKey.header)
            .send({ code: 'welcome20', discount_type: 'percent', discount_value: 20, duration_months: 3 });
        expect(res.status).toBe(201);
        expect(couponsQuery.insert).toHaveBeenCalledWith([expect.objectContaining({ merchant_id: merchantId, code: 'WELCOME20' })]);
    });
    it('returns the validated promotional quote without reserving redemptions', async () => {
        const response = await request(app).post('/coupons/validate').send({ plan_id: planId, code: 'welcome20' });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ valid: true, discounted_amount: 232000000, duration_months: 3 });
        expect(couponsQuery.eq).toHaveBeenCalledWith('merchant_id', merchantId);
        expect(couponsQuery.eq).toHaveBeenCalledWith('code', 'WELCOME20');
        expect(couponsQuery.update).not.toHaveBeenCalled();
    });
    it('rejects coupons belonging to a different merchant', async () => {
        couponsQuery.maybeSingle.mockResolvedValueOnce({ data: { ...coupon, merchant_id: otherMerchant }, error: null });
        // Even an inconsistent fake database row should not be trusted.
        const response = await request(app).post('/coupons/validate').send({ plan_id: planId, code: 'WELCOME20' });
        expect(response.status).toBe(422);
    });
    it('redeems a coupon through the atomic SQL function during subscription creation', async () => {
        const subscription = { id: '6f61a80c-301f-4b63-9474-23f897e35bb1', status: 'pending_promo', promotion_discounted_amount: 232000000 };
        app.locals.supabase.rpc.mockResolvedValueOnce({ data: subscription, error: null });
        plansQuery.single.mockResolvedValueOnce({ data: { merchant_id: null }, error: null });
        const response = await request(app).post('/subscriptions').send({ plan_id: planId,
            customer_wallet_address: wallet, coupon_code: 'welcome20' });
        expect(response.status).toBe(201);
        expect(response.body.subscription).toMatchObject(subscription);
        expect(app.locals.supabase.rpc).toHaveBeenCalledWith('redeem_coupon_subscription', expect.objectContaining({
            p_plan_id: planId, p_code: 'WELCOME20', p_customer_wallet_address: wallet,
        }));
    });
    it('returns 409 if atomic coupon redemption is exhausted', async () => {
        app.locals.supabase.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P7502', message: 'exhausted' } });
        const response = await request(app).post('/subscriptions').send({ plan_id: planId,
            customer_wallet_address: wallet, coupon_code: 'WELCOME20' });
        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/limit/i);
    });
    it('rejects exhausted redemption code', async () => {
        couponsQuery.maybeSingle.mockResolvedValueOnce({ data: { ...coupon, redemptions_count: 2 }, error: null });
        const response = await request(app).post('/coupons/validate').send({ plan_id: planId, code: 'WELCOME20' });
        expect(response.status).toBe(422);
    });
});
