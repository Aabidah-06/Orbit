import { describe, it, expect, vi } from 'vitest';
import {
  generateSigningSecret,
  computeWebhookSignature,
  createWebhookSchema,
  dispatchWebhookEvent,
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
});
