import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, StrKey, Address, xdr, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import {
  createReconciler,
  createSupabaseStore,
  startReconciliationWorker,
  parseVaultEvent,
} from '../reconciliation.js';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const MERCHANT = Keypair.random().publicKey();
const USER_A = Keypair.random().publicKey();
const USER_B = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 9));
const INTERVAL = 2592000;
// Fixed clock well after every subscription's created_at so the grace window never applies
const NOW_MS = Date.parse('2026-06-01T00:00:00Z');
const OLD = '2026-01-01T00:00:00.000Z';

const iso = (seconds) => new Date(seconds * 1000).toISOString();

const makeEvent = (name, user, merchant, value = xdr.ScVal.scvVoid(), overrides = {}) => ({
  id: `${overrides.ledger ?? 100}-${name}`,
  type: 'contract',
  ledger: 100,
  ledgerClosedAt: OLD,
  txHash: `hash-${name}-${user.slice(0, 4)}`,
  inSuccessfulContractCall: true,
  topic: [xdr.ScVal.scvSymbol(name), new Address(user).toScVal(), new Address(merchant).toScVal()],
  value,
  ...overrides,
});

const pulledValue = (timestamp) =>
  xdr.ScVal.scvVec([nativeToScVal(290000000n, { type: 'i128' }), nativeToScVal(BigInt(timestamp), { type: 'u64' })]);

const vaultScVal = ({ lastPull, interval = INTERVAL }) => {
  const entry = (key, val) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  return xdr.ScVal.scvMap([
    entry('amount_per_interval', nativeToScVal(290000000n, { type: 'i128' })),
    entry('interval_seconds', nativeToScVal(BigInt(interval), { type: 'u64' })),
    entry('last_pull_timestamp', nativeToScVal(BigInt(lastPull), { type: 'u64' })),
    entry('token', new Address(TOKEN).toScVal()),
  ]);
};

// In-memory stand-in for the Supabase store
const createMemoryStore = (subscriptions) => {
  const rows = subscriptions.map((sub) => ({
    status: 'active',
    created_at: OLD,
    plans: { interval_seconds: INTERVAL, merchants: { wallet_address: MERCHANT } },
    ...sub,
  }));
  const store = {
    rows,
    cursor: null,
    lockedIds: new Set(),
    listSubscriptions: vi.fn(async ({ offset, limit }) =>
      rows.filter((r) => ['active', 'past_due'].includes(r.status)).slice(offset, offset + limit)),
    findSubscriptionsByVault: vi.fn(async (user, merchant) =>
      rows.filter((r) => r.customer_wallet_address === user && r.plans.merchants.wallet_address === merchant)),
    updateSubscription: vi.fn(async (id, fields) => Object.assign(rows.find((r) => r.id === id), fields)),
    withSubscriptionLock: vi.fn(async (id, fn) => {
      if (store.lockedIds.has(id)) return { skipped: true };
      await fn();
      return { skipped: false };
    }),
    loadEventCursor: vi.fn(async () => store.cursor),
    saveEventCursor: vi.fn(async (cursor) => { store.cursor = cursor; }),
  };
  return store;
};

// Mock Soroban RPC: `events` is served by getEvents, `vaults` maps a user address to its get_vault result
const createMockServer = ({ events = [], vaults = {} } = {}) => ({
  getLatestLedger: vi.fn().mockResolvedValue({ sequence: 50000 }),
  getEvents: vi.fn().mockResolvedValue({ events, cursor: 'cursor-1', latestLedger: 50000 }),
  simulateTransaction: vi.fn(async (tx) => {
    const { args } = tx.operations[0].func.invokeContract;
    const user = Address.fromScVal(args[0]).toString();
    const vault = vaults[user];
    if (vault instanceof Error) return { error: vault.message };
    if (vault === 'archived') {
      return { transactionData: {}, result: { retval: xdr.ScVal.scvVoid() }, restorePreamble: { transactionData: {} } };
    }
    return { transactionData: {}, result: { retval: vault ?? xdr.ScVal.scvVoid() } };
  }),
});

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const discrepancies = (logger) =>
  logger.warn.mock.calls.filter(([event]) => event === 'reconciliation.discrepancy').map(([, fields]) => fields);

describe('Subscription reconciliation worker', () => {
  let logger;

  const build = ({ store, server, options }) =>
    createReconciler({ store, server, contractId: CONTRACT_ID, logger, now: () => NOW_MS, options });

  beforeEach(() => {
    logger = silentLogger();
  });

  describe('event parsing', () => {
    it('decodes funds_pulled topics and the ledger timestamp of the pull', () => {
      const parsed = parseVaultEvent(makeEvent('funds_pulled', USER_A, MERCHANT, pulledValue(1767225600)));
      expect(parsed).toMatchObject({
        name: 'funds_pulled', user: USER_A, merchant: MERCHANT, amount: '290000000', pulledAt: 1767225600,
      });
    });

    it('ignores untracked events and events from failed contract calls', () => {
      expect(parseVaultEvent(makeEvent('batch_disbursed', USER_A, MERCHANT))).toBeNull();
      expect(parseVaultEvent(makeEvent('vault_cancelled', USER_A, MERCHANT, undefined, { inSuccessfulContractCall: false }))).toBeNull();
    });
  });

  describe('ledger event ingestion', () => {
    it('queries getEvents for the contract filtered on the three vault topics', async () => {
      const store = createMemoryStore([]);
      const server = createMockServer();
      await build({ store, server }).runOnce();

      const request = server.getEvents.mock.calls[0][0];
      expect(request.startLedger).toBe(50000 - 17280);
      expect(request.filters).toHaveLength(1);
      expect(request.filters[0].contractIds).toEqual([CONTRACT_ID]);
      const topicNames = request.filters[0].topics.map(([name, ...rest]) => {
        expect(rest).toEqual(['*', '*']);
        return scValToNative(xdr.ScVal.fromXDR(name, 'base64'));
      });
      expect(topicNames).toEqual(['vault_created', 'vault_cancelled', 'funds_pulled']);
    });

    it('resumes from the persisted cursor and saves the new one', async () => {
      const store = createMemoryStore([]);
      store.cursor = 'cursor-0';
      const server = createMockServer();
      await build({ store, server }).runOnce();

      expect(server.getEvents.mock.calls[0][0]).toMatchObject({ cursor: 'cursor-0' });
      expect(server.getEvents.mock.calls[0][0].startLedger).toBeUndefined();
      expect(store.saveEventCursor).toHaveBeenCalledWith('cursor-1', 50000);
    });

    it('falls back to the lookback window when the stored cursor is rejected', async () => {
      const store = createMemoryStore([]);
      store.cursor = 'expired';
      const server = createMockServer();
      server.getEvents
        .mockRejectedValueOnce(new Error('cursor is before the oldest ledger'))
        .mockResolvedValueOnce({ events: [], cursor: 'cursor-2', latestLedger: 50000 });

      const metrics = await build({ store, server }).runOnce();

      expect(server.getEvents.mock.calls[1][0]).toMatchObject({ startLedger: 50000 - 17280 });
      expect(store.cursor).toBe('cursor-2');
      expect(metrics.errors).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith('reconciliation.event_cursor_reset', expect.any(Object));
    });

    it('pages through events until a short page is returned', async () => {
      const store = createMemoryStore([]);
      const server = createMockServer();
      server.getEvents
        .mockResolvedValueOnce({ events: [makeEvent('vault_created', USER_A, MERCHANT)], cursor: 'p1', latestLedger: 1 })
        .mockResolvedValueOnce({ events: [], cursor: 'p2', latestLedger: 2 });

      const metrics = await build({ store, server, options: { eventPageLimit: 1 } }).runOnce();

      expect(server.getEvents).toHaveBeenCalledTimes(2);
      expect(server.getEvents.mock.calls[1][0]).toMatchObject({ cursor: 'p1' });
      expect(store.cursor).toBe('p2');
      expect(metrics.events_ingested).toBe(1);
    });

    it('does not advance the cursor when applying events fails', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD }]);
      store.findSubscriptionsByVault.mockRejectedValueOnce(new Error('db down'));
      const server = createMockServer({ events: [makeEvent('vault_cancelled', USER_A, MERCHANT)] });

      const metrics = await build({ store, server }).runOnce();

      expect(store.saveEventCursor).not.toHaveBeenCalled();
      expect(metrics.errors).toBeGreaterThan(0);
    });
  });

  describe('external cancellations', () => {
    it('cancels an active subscription when a vault_cancelled event is ingested', async () => {
      const store = createMemoryStore([
        { id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD },
        { id: 'sub-b', customer_wallet_address: USER_B, next_billing_date: OLD },
      ]);
      const server = createMockServer({
        events: [makeEvent('vault_cancelled', USER_A, MERCHANT)],
        vaults: { [USER_B]: vaultScVal({ lastPull: 0 }) },
      });

      const metrics = await build({ store, server }).runOnce();

      expect(store.rows.find((r) => r.id === 'sub-a').status).toBe('cancelled');
      expect(store.rows.find((r) => r.id === 'sub-b').status).toBe('active');
      expect(metrics.cancelled).toBe(1);
      expect(discrepancies(logger)).toContainEqual(expect.objectContaining({
        type: 'vault_missing_on_chain', subscription_id: 'sub-a', source: 'event', tx_hash: expect.any(String),
      }));
    });

    it('cancels active and past_due subscriptions whose vault is missing on-chain', async () => {
      const store = createMemoryStore([
        { id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD },
        { id: 'sub-b', customer_wallet_address: USER_B, next_billing_date: OLD, status: 'past_due' },
      ]);
      // No events: e.g. the cancellation happened before the RPC's retention window
      const server = createMockServer();

      const metrics = await build({ store, server }).runOnce();

      expect(store.rows.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
      expect(metrics).toMatchObject({ subscriptions_checked: 2, cancelled: 2, errors: 0 });
    });

    it('does not cancel a vault that was cancelled and then re-created', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD }]);
      const server = createMockServer({
        events: [
          makeEvent('vault_cancelled', USER_A, MERCHANT, undefined, { ledger: 100 }),
          makeEvent('vault_created', USER_A, MERCHANT, undefined, { ledger: 101 }),
        ],
        vaults: { [USER_A]: vaultScVal({ lastPull: 0 }) },
      });

      await build({ store, server }).runOnce();

      expect(store.rows[0].status).toBe('active');
    });

    it('never cancels when the get_vault lookup fails', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD }]);
      const server = createMockServer({ vaults: { [USER_A]: new Error('HostError: rpc unavailable') } });

      const metrics = await build({ store, server }).runOnce();

      expect(store.rows[0].status).toBe('active');
      expect(metrics.errors).toBe(1);
      expect(logger.error).toHaveBeenCalledWith('reconciliation.subscription_failed', expect.objectContaining({ subscription_id: 'sub-a' }));
    });

    it('leaves archived vaults alone and reports them', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD }]);
      const server = createMockServer({ vaults: { [USER_A]: 'archived' } });

      await build({ store, server }).runOnce();

      expect(store.rows[0].status).toBe('active');
      expect(discrepancies(logger)).toContainEqual(expect.objectContaining({ type: 'vault_archived' }));
    });

    it('skips subscriptions created inside the grace window', async () => {
      const store = createMemoryStore([{
        id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD, created_at: new Date(NOW_MS - 60000).toISOString(),
      }]);
      const server = createMockServer();

      const metrics = await build({ store, server }).runOnce();

      expect(store.rows[0].status).toBe('active');
      expect(metrics.subscriptions_checked).toBe(0);
      expect(server.simulateTransaction).not.toHaveBeenCalled();
    });
  });

  describe('billing date reconciliation', () => {
    const pulledAt = Date.parse('2026-05-20T10:00:00Z') / 1000;

    it('realigns next_billing_date from a funds_pulled event the backend did not trigger', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: iso(pulledAt) }]);
      const server = createMockServer({
        events: [makeEvent('funds_pulled', USER_A, MERCHANT, pulledValue(pulledAt))],
        vaults: { [USER_A]: vaultScVal({ lastPull: pulledAt }) },
      });

      const metrics = await build({ store, server }).runOnce();

      expect(store.rows[0].next_billing_date).toBe(iso(pulledAt + INTERVAL));
      expect(metrics.billing_dates_updated).toBe(1);
      expect(discrepancies(logger)).toContainEqual(expect.objectContaining({
        type: 'next_billing_date_drift', source: 'event', drift_seconds: -INTERVAL,
      }));
    });

    it('uses the latest pull when several are ingested for the same vault', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD }]);
      const server = createMockServer({
        events: [
          makeEvent('funds_pulled', USER_A, MERCHANT, pulledValue(pulledAt - INTERVAL), { ledger: 10 }),
          makeEvent('funds_pulled', USER_A, MERCHANT, pulledValue(pulledAt), { ledger: 20 }),
        ],
        vaults: { [USER_A]: vaultScVal({ lastPull: pulledAt }) },
      });

      await build({ store, server }).runOnce();

      expect(store.rows[0].next_billing_date).toBe(iso(pulledAt + INTERVAL));
      expect(store.updateSubscription).toHaveBeenCalledTimes(1);
    });

    it('snaps a backend-written wall-clock timestamp to ledger finality', async () => {
      // /submit-pull writes Date.now() + interval, a few seconds after the ledger timestamp
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: iso(pulledAt + INTERVAL + 4) }]);
      const server = createMockServer({ vaults: { [USER_A]: vaultScVal({ lastPull: pulledAt }) } });

      await build({ store, server }).runOnce();

      expect(store.rows[0].next_billing_date).toBe(iso(pulledAt + INTERVAL));
      expect(discrepancies(logger)).toContainEqual(expect.objectContaining({ source: 'ledger_state', drift_seconds: 4 }));
    });

    it('makes no writes when the database already matches the ledger', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: iso(pulledAt + INTERVAL) }]);
      const server = createMockServer({ vaults: { [USER_A]: vaultScVal({ lastPull: pulledAt }) } });

      const metrics = await build({ store, server }).runOnce();

      expect(store.updateSubscription).not.toHaveBeenCalled();
      expect(metrics.discrepancies).toBe(0);
    });

    it('leaves next_billing_date alone for vaults that were never pulled', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD }]);
      const server = createMockServer({ vaults: { [USER_A]: vaultScVal({ lastPull: 0 }) } });

      await build({ store, server }).runOnce();

      expect(store.updateSubscription).not.toHaveBeenCalled();
    });

    it('skips subscriptions whose billing lock is held by an in-flight pull', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD }]);
      store.lockedIds.add('sub-a');
      const server = createMockServer({ vaults: { [USER_A]: vaultScVal({ lastPull: pulledAt }) } });

      const metrics = await build({ store, server }).runOnce();

      expect(store.rows[0].next_billing_date).toBe(OLD);
      expect(metrics).toMatchObject({ skipped_locked: 1, billing_dates_updated: 0 });
    });
  });

  describe('discrepancy reporting', () => {
    it('reports vaults created on-chain with no matching subscription', async () => {
      const store = createMemoryStore([]);
      const server = createMockServer({ events: [makeEvent('vault_created', USER_A, MERCHANT)] });

      await build({ store, server }).runOnce();

      expect(discrepancies(logger)).toContainEqual(expect.objectContaining({
        type: 'untracked_vault', customer_wallet_address: USER_A, merchant_wallet_address: MERCHANT,
      }));
    });

    it('logs a structured metrics summary for every run', async () => {
      const store = createMemoryStore([{ id: 'sub-a', customer_wallet_address: USER_A, next_billing_date: OLD }]);
      const server = createMockServer({ events: [makeEvent('vault_cancelled', USER_A, MERCHANT)] });

      await build({ store, server }).runOnce();

      expect(logger.info).toHaveBeenCalledWith('reconciliation.run_completed', {
        events_ingested: 1,
        subscriptions_checked: 0,
        cancelled: 1,
        billing_dates_updated: 0,
        skipped_locked: 0,
        discrepancies: 1,
        errors: 0,
        duration_ms: 0,
      });
    });
  });

  describe('worker loop', () => {
    it('runs immediately, repeats on the interval and stops cleanly', async () => {
      const reconciler = { runOnce: vi.fn().mockResolvedValue({}) };
      const worker = startReconciliationWorker(reconciler, { intervalMs: 5 });

      await vi.waitFor(() => expect(reconciler.runOnce.mock.calls.length).toBeGreaterThanOrEqual(2));
      await worker.stop();
      const calls = reconciler.runOnce.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reconciler.runOnce).toHaveBeenCalledTimes(calls);
    });
  });
});

describe('Supabase reconciliation store', () => {
  let mockSupabase;

  beforeEach(() => {
    mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data: [{ id: 'sub-a' }], error: null }),
      eq: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: { event_cursor: 'cursor-9' }, error: null }),
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    };
  });

  it('lists only subscriptions that should have a live vault', async () => {
    const store = createSupabaseStore(mockSupabase);
    const rows = await store.listSubscriptions({ offset: 100, limit: 50 });

    expect(rows).toEqual([{ id: 'sub-a' }]);
    expect(mockSupabase.from).toHaveBeenCalledWith('subscriptions');
    expect(mockSupabase.in).toHaveBeenCalledWith('status', ['active', 'past_due']);
    expect(mockSupabase.range).toHaveBeenCalledWith(100, 149);
  });

  it('persists the event cursor in reconciliation_state', async () => {
    const store = createSupabaseStore(mockSupabase);

    expect(await store.loadEventCursor()).toBe('cursor-9');
    await store.saveEventCursor('cursor-10', 1234);

    expect(mockSupabase.from).toHaveBeenCalledWith('reconciliation_state');
    expect(mockSupabase.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'soroban_events', event_cursor: 'cursor-10', last_ledger: 1234,
    }));
  });

  it('writes subscription updates under the billing lock', async () => {
    const store = createSupabaseStore(mockSupabase);
    const result = await store.withSubscriptionLock('sub-a', () => store.updateSubscription('sub-a', { status: 'cancelled' }));

    expect(result).toEqual({ skipped: false });
    expect(mockSupabase.rpc).toHaveBeenCalledWith('acquire_billing_lock', expect.objectContaining({ p_subscription_id: 'sub-a' }));
    expect(mockSupabase.update).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(mockSupabase.rpc).toHaveBeenCalledWith('release_billing_lock', expect.objectContaining({ p_subscription_id: 'sub-a' }));
  });

  it('reports a held billing lock as skipped without writing', async () => {
    mockSupabase.rpc.mockResolvedValueOnce({ data: false, error: null });
    const store = createSupabaseStore(mockSupabase);
    const result = await store.withSubscriptionLock('sub-a', () => store.updateSubscription('sub-a', { status: 'cancelled' }));

    expect(result).toEqual({ skipped: true });
    expect(mockSupabase.update).not.toHaveBeenCalled();
  });
});
