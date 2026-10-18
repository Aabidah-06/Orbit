import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const { calculateFeeBid, createFeeEstimator } = createRequire(import.meta.url)('../fee-estimator.js');
const fee_charged = { p50: '100', p75: '250', p95: '900' };
describe('Stellar network fee estimator', () => {
  it('uses p75 for standard and p95 for high priority', () => {
    expect(calculateFeeBid({ fee_charged })).toBe(250);
    expect(calculateFeeBid({ fee_charged }, { priority: 'high' })).toBe(900);
  });
  it('escalates bids after two pending ledgers while enforcing the cap', () => {
    expect(calculateFeeBid({ fee_charged }, { pendingLedgers: 2 })).toBe(500);
    expect(calculateFeeBid({ fee_charged }, { pendingLedgers: 3 })).toBe(1000);
    expect(calculateFeeBid({ fee_charged }, { pendingLedgers: 10, maxFee: 1200 })).toBe(1200);
  });
  it('rejects invalid priority and preserves minimum network bid', () => {
    expect(calculateFeeBid({ fee_charged: { p75: '1' } })).toBe(100);
    expect(() => calculateFeeBid({}, { priority: 'urgent' })).toThrow();
    expect(() => calculateFeeBid({}, { pendingLedgers: -1 })).toThrow();
  });
  it('caches network stats and falls back safely on errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fee_charged }) });
    const estimator = createFeeEstimator({ fetchImpl });
    expect(await estimator.estimate()).toBe(250);
    expect(await estimator.estimate({ priority: 'high' })).toBe(900);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const offline = createFeeEstimator({ fetchImpl: async () => { throw new Error('offline'); } });
    expect(await offline.estimate()).toBe(100);
  });
});
