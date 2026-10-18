import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import {
  generateSigningSecret,
  computeWebhookSignature,
  verifyWebhookSignature,
  createWebhookSchema,
  backfillWebhookSchema,
  dispatchWebhookEvent,
  replayWebhookEvents,
} from '../webhooks.js';

describe('Webhook System', () => {
  const validMerchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
  const secret = 'whsec_test_secret_1234567890';

  describe('Signing & Validation', () => {
    it('generates a secret prefixed with whsec_', () => {
      const s = generateSigningSecret();
      expect(s.startsWith('whsec_')).toBe(true);
      expect(s.length).toBeGreaterThan(20);
    });

    it('computes HMAC-SHA256 signature in sha256=... format', () => {
      const payloadString = JSON.stringify({ event: 'subscription.created', id: '123' });
      const sig = computeWebhookSignature(secret, payloadString);
      expect(sig.startsWith('sha256=')).toBe(true);
    });

    it('validates endpoint url and subscribed events', () => {
      const valid = {
        merchant_id: validMerchantId,
        url: 'https://api.example.com/webhooks',
        subscribed_events: ['subscription.created', 'payment.settled'],
      };
      const result = createWebhookSchema.safeParse(valid);
      expect(result.success).toBe(true);

      const invalidUrl = {
        merchant_id: validMerchantId,
        url: 'not-a-valid-url',
      };
      expect(createWebhookSchema.safeParse(invalidUrl).success).toBe(false);
    });
  });

  describe('dispatchWebhookEvent', () => {
    it('dispatches to active webhooks matching the event', async () => {
      const mockWebhook = {
        id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        merchant_id: validMerchantId,
        url: 'https://example.com/webhook',
        signing_secret: secret,
        subscribed_events: ['*'],
        active: true,
      };

      const mockSupabase = {
        from: vi.fn((table) => {
          if (table === 'webhooks') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({ data: [mockWebhook], error: null }),
                }),
              }),
            };
          }
          if (table === 'webhook_deliveries') {
            return {
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      id: 'delivery-uuid-1',
                      webhook_id: mockWebhook.id,
                      response_status: 200,
                      status: 'success',
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
        }),
      };

      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue('OK'),
      });

      const results = await dispatchWebhookEvent(mockSupabase, {
        merchantId: validMerchantId,
        eventType: 'payment.settled',
        payload: { txHash: '0xabc123', amount: 50 },
        fetchImpl: mockFetch,
      });

      expect(results).toHaveLength(1);
      expect(results[0].response_status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        mockWebhook.url,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Orbit-Signature': expect.stringContaining('sha256='),
          }),
        })
      );
    });
  });

  describe('Historical Webhook Replay & Backfill Engine (#170)', () => {
    const webhookId = '11111111-2222-3333-4444-555555555555';
    const mockWebhook = {
      id: webhookId,
      merchant_id: validMerchantId,
      url: 'https://merchant.example.com/webhooks',
      signing_secret: secret,
      events: ['payment.settled', 'subscription.created'],
      active: true,
    };

    const historicalEvents = [
      {
        id: 'ev-1',
        merchant_id: validMerchantId,
        event_type: 'payment.settled',
        payload: { txHash: '0x1', amount: 100, timestamp: '2026-10-10T10:00:00Z' },
        created_at: '2026-10-10T10:00:00Z',
      },
      {
        id: 'ev-2',
        merchant_id: validMerchantId,
        event_type: 'subscription.created',
        payload: { customer: 'GA123', plan: 'pro', timestamp: '2026-10-12T10:00:00Z' },
        created_at: '2026-10-12T10:00:00Z',
      },
      {
        id: 'ev-3',
        merchant_id: validMerchantId,
        event_type: 'payment.settled',
        payload: { txHash: '0x2', amount: 200, timestamp: '2026-10-15T10:00:00Z' },
        created_at: '2026-10-15T10:00:00Z',
      },
    ];

    it('attaches X-Orbit-Replay: true header, valid HMAC signature, and preserves timestamps in metadata', async () => {
      const mockSupabase = {
        from: vi.fn((table) => {
          if (table === 'webhooks') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: mockWebhook, error: null }),
                }),
              }),
            };
          }
          if (table === 'webhook_events') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  in: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue({ data: [historicalEvents[0]], error: null }),
                  }),
                }),
              }),
            };
          }
          if (table === 'webhook_deliveries') {
            return {
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'del-1', status: 'success', response_status: 200 },
                    error: null,
                  }),
                }),
              }),
            };
          }
        }),
      };

      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue('OK'),
      });

      const result = await replayWebhookEvents(mockSupabase, {
        webhookId,
        eventTypes: ['payment.settled'],
        fetchImpl: mockFetch,
        rateLimitPerSecond: 10,
      });

      expect(result.replayed_count).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [callUrl, callOptions] = mockFetch.mock.calls[0];
      expect(callUrl).toBe(mockWebhook.url);
      expect(callOptions.headers['X-Orbit-Replay']).toBe('true');
      expect(callOptions.headers['X-Orbit-Event']).toBe('payment.settled');
      expect(callOptions.headers['X-Orbit-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify HMAC signature validity
      const payloadString = callOptions.body;
      const parsedBody = JSON.parse(payloadString);
      expect(verifyWebhookSignature(callOptions.headers['X-Orbit-Signature'], payloadString, [secret])).toBe(true);

      // Verify original timestamp preserved in payload metadata
      expect(parsedBody.metadata.original_timestamp).toBe('2026-10-10T10:00:00Z');
      expect(parsedBody.metadata.replayed).toBe(true);
      expect(parsedBody.metadata.replayed_at).toBeDefined();
    });

    it('throttles replay delivery to 10 events/second using the rate throttling queue', async () => {
      const mockSupabase = {
        from: vi.fn((table) => {
          if (table === 'webhooks') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: mockWebhook, error: null }),
                }),
              }),
            };
          }
          if (table === 'webhook_events') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockResolvedValue({ data: historicalEvents, error: null }),
                }),
              }),
            };
          }
          if (table === 'webhook_deliveries') {
            return {
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'del', status: 'success' },
                    error: null,
                  }),
                }),
              }),
            };
          }
        }),
      };

      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue('OK'),
      });

      const mockSleep = vi.fn().mockResolvedValue();

      const result = await replayWebhookEvents(mockSupabase, {
        webhookId,
        eventTypes: ['*'],
        fetchImpl: mockFetch,
        sleepImpl: mockSleep,
        rateLimitPerSecond: 10, // 10 events/sec -> 100ms interval
      });

      expect(result.replayed_count).toBe(3);
      // For 3 events, delay should be called twice (before 2nd and 3rd event)
      expect(mockSleep).toHaveBeenCalledTimes(2);
      expect(mockSleep).toHaveBeenCalledWith(100);
    });

    it('POST /webhooks/:id/backfill invokes replay with query parameters', async () => {
      const testWebhook = {
        id: '22222222-2222-2222-2222-222222222222',
        merchant_id: validMerchantId,
        url: 'https://client.example.com/webhook',
        signing_secret: secret,
        events: ['payment.settled'],
        active: true,
      };

      const mockSupabase = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        order: vi.fn(),
        single: vi.fn(),
      };

      mockSupabase.single.mockImplementation(() => {
        const lastFromCall = mockSupabase.from.mock.calls[mockSupabase.from.mock.calls.length - 1]?.[0];
        if (lastFromCall === 'webhooks') {
          return Promise.resolve({ data: testWebhook, error: null });
        }
        return Promise.resolve({ data: { id: 'del-backfill', status: 'success' }, error: null });
      });

      mockSupabase.order.mockResolvedValue({
        data: [historicalEvents[0]],
        error: null,
      });

      app.locals.supabase = mockSupabase;
      app.locals.fetchImpl = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue('{"received":true}'),
      });

      const res = await request(app)
        .post(`/webhooks/${testWebhook.id}/backfill`)
        .send({
          event_types: ['payment.settled'],
          start_date: '2026-10-01',
          end_date: '2026-10-18',
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('backfill completed');
      expect(res.body.replayed_count).toBe(1);
    }, 15000);
  });
});

