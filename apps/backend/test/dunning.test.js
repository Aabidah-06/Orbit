import { describe, it, expect, vi } from 'vitest';
import {
  DUNNING_INTERVAL_DAYS,
  MAX_DUNNING_RETRIES,
  calculateNextDunningRetry,
  generateRecoveryLink,
  markSubscriptionPastDue,
  processDunningRetries,
} from '../dunning.js';

describe('Dunning Management System', () => {
  const validSubscriptionId = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';

  it('defines the 1, 3, 5, 7 day retry cadence and max retries of 4', () => {
    expect(DUNNING_INTERVAL_DAYS).toEqual([1, 3, 5, 7]);
    expect(MAX_DUNNING_RETRIES).toBe(4);
  });

  it('calculates the next retry timestamp based on current retry count', () => {
    const baseDate = new Date('2026-01-01T00:00:00Z');

    // retry count 0 -> Day 1
    const next0 = calculateNextDunningRetry(0, baseDate);
    expect(next0.toISOString()).toBe('2026-01-02T00:00:00.000Z');

    // retry count 1 -> Day 3
    const next1 = calculateNextDunningRetry(1, baseDate);
    expect(next1.toISOString()).toBe('2026-01-04T00:00:00.000Z');

    // retry count 2 -> Day 5
    const next2 = calculateNextDunningRetry(2, baseDate);
    expect(next2.toISOString()).toBe('2026-01-06T00:00:00.000Z');

    // retry count 3 -> Day 7
    const next3 = calculateNextDunningRetry(3, baseDate);
    expect(next3.toISOString()).toBe('2026-01-08T00:00:00.000Z');

    // retry count 4 -> exhausts retries (null)
    const next4 = calculateNextDunningRetry(4, baseDate);
    expect(next4).toBeNull();
  });

  it('generates recovery link with subscription ID and token', () => {
    const linkObj = generateRecoveryLink(validSubscriptionId, 'https://app.orbitpay.xyz');
    expect(linkObj.recovery_url).toContain(validSubscriptionId);
    expect(linkObj.recovery_url).toContain('token=');
    expect(linkObj.subscription_id).toBe(validSubscriptionId);
  });

  it('marks subscription past_due with dunning status pending and first retry', async () => {
    const mockUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    const mockSub = {
      id: validSubscriptionId,
      status: 'active',
      plans: {
        id: 'e0b8e99b-5136-4d1d-9351-91a5db4fb056',
        merchant_id: '7f8b9a10-b2c3-4d5e-a6f7-112233445566',
      },
    };

    const mockSupabase = {
      from: vi.fn((table) => {
        if (table === 'subscriptions') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: mockSub, error: null }),
              }),
            }),
            update: mockUpdate,
          };
        }
        return {
          insert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      }),
    };

    const res = await markSubscriptionPastDue(mockSupabase, validSubscriptionId, {
      fetchImpl: vi.fn(),
    });

    expect(mockSupabase.from).toHaveBeenCalledWith('subscriptions');
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'past_due',
      dunning_status: 'pending',
      retry_count: 0,
      next_dunning_retry_at: expect.any(String),
    }));
    expect(res.status).toBe('past_due');
    expect(res.recovery_link).toBeDefined();
  });

  it('cancels subscription when dunning retries reach max limit', async () => {
    const expiredSub = {
      id: validSubscriptionId,
      status: 'past_due',
      dunning_status: 'pending',
      retry_count: 3, // next attempt makes it 4 (>= MAX_DUNNING_RETRIES)
      next_dunning_retry_at: '2026-01-01T00:00:00Z',
      customer_wallet_address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      plans: {
        id: 'e0b8e99b-5136-4d1d-9351-91a5db4fb056',
        merchant_id: '7f8b9a10-b2c3-4d5e-a6f7-112233445566',
        usdc_amount: 100000000,
        interval_seconds: 2592000,
      },
    };

    const mockUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    const mockSupabase = {
      from: vi.fn((table) => {
        if (table === 'subscriptions') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [expiredSub], error: null }),
            }),
            update: mockUpdate,
          };
        }
        return {
          insert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      }),
    };

    const result = await processDunningRetries(mockSupabase, {
      now: new Date('2026-01-02T00:00:00Z'),
      fetchImpl: vi.fn(),
    });

    expect(result.processed).toBe(1);
    expect(result.results[0].action).toBe('cancelled');
    expect(result.results[0].status).toBe('cancelled');
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'cancelled',
      dunning_status: 'exhausted',
    }));
  });
});
