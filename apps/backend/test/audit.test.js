import { describe, it, expect, vi } from 'vitest';
import { getAuditLogsQuerySchema, getClientIp, getActorAddress, writeAuditLog } from '../audit.js';

describe('Audit Logging System', () => {
  const validMerchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';

  describe('Validation & Helpers', () => {
    it('validates correct audit logs query parameters', () => {
      const validQuery = {
        merchant_id: validMerchantId,
        action: 'pull.settled',
        limit: '25',
        offset: '0',
      };
      const result = getAuditLogsQuerySchema.safeParse(validQuery);
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(25);
    });

    it('rejects query without valid merchant_id UUID', () => {
      const invalidQuery = { merchant_id: 'not-a-uuid' };
      const result = getAuditLogsQuerySchema.safeParse(invalidQuery);
      expect(result.success).toBe(false);
    });

    it('extracts client IP from x-forwarded-for header', () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
      };
      expect(getClientIp(req)).toBe('203.0.113.195');
    });

    it('extracts actor address from headers or body', () => {
      const reqWithHeader = {
        headers: { 'x-actor-address': 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      };
      expect(getActorAddress(reqWithHeader)).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

      const reqWithBody = {
        headers: {},
        body: { customer_wallet_address: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFQD2WVMQ6QXRXRGNU7' },
      };
      expect(getActorAddress(reqWithBody)).toBe('GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFQD2WVMQ6QXRXRGNU7');
    });
  });

  describe('writeAuditLog', () => {
    it('appends record to audit_logs table', async () => {
      const mockInsert = vi.fn().mockResolvedValue({ error: null });
      const mockSupabase = {
        from: vi.fn().mockReturnValue({ insert: mockInsert }),
      };

      const result = await writeAuditLog(mockSupabase, {
        merchantId: validMerchantId,
        actorAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        action: 'plan.create',
        resourceType: 'plan',
        resourceId: 'e0b8e99b-5136-4d1d-9351-91a5db4fb056',
        ipAddress: '127.0.0.1',
        changesAfter: { name: 'Pro Plan', usdc_amount: 100 },
      });

      expect(result).not.toBeNull();
      expect(mockSupabase.from).toHaveBeenCalledWith('audit_logs');
      expect(mockInsert).toHaveBeenCalledWith([expect.objectContaining({
        merchant_id: validMerchantId,
        action: 'plan.create',
        resource_type: 'plan',
      })]);
    });
  });
});
