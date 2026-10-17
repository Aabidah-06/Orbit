import { describe, it, expect, vi } from 'vitest';
import { Contract, nativeToScVal, StrKey } from '@stellar/stellar-sdk';
import { createLedgerIndexer } from '../ledger-indexer.js';

const contractId = StrKey.encodeContract(new Uint8Array(32).fill(1));
const event = (id, ledger) => ({ id, ledger, txHash: `tx-${id}`, contractId: new Contract(contractId),
  topic: [nativeToScVal('funds_pulled', { type: 'symbol' }), nativeToScVal('subscriber'), nativeToScVal('merchant')],
  value: nativeToScVal([1234567890123456789n, 12n]), ledgerClosedAt: '2026-10-01T00:00:00Z' });

function fixture() {
  let saved = null, crash = false;
  const persisted = new Map();
  const supabase = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: saved === null ? null : { last_processed_ledger_sequence: saved } }) }) }) }),
    rpc: vi.fn(async (_, args) => {
      if (crash) return { error: new Error('transaction rolled back') };
      if (saved !== null && saved !== args.p_expected_sequence) return { error: new Error('Checkpoint changed') };
      for (const item of args.p_events) persisted.set(item.id, item);
      saved = args.p_last_sequence;
      return { error: null };
    }),
  };
  const server = { getLatestLedger: vi.fn(async () => ({ sequence: 15 })),
    getEvents: vi.fn(async () => ({ events: [event('a', 11)], latestLedger: 15, oldestLedger: 1, cursor: 'a' })) };
  const logger = { error: vi.fn() };
  const make = (options = {}) => createLedgerIndexer({ supabase, server, logger, contractId, startLedger: 11, ...options });
  return { supabase, server, logger, make, persisted, saved: () => saved, crash: (value) => { crash = value; } };
}

describe('Persistent ledger event indexing', () => {
  it('persists decoded large amounts without precision loss and advances through empty ledgers', async () => {
    const f = fixture(); await f.make().ingest();
    expect(f.saved()).toBe(15);
    expect(f.persisted.get('a').value[0]).toBe('1234567890123456789');
    expect(f.supabase.rpc).toHaveBeenCalledWith('commit_ledger_batch', expect.objectContaining({ p_expected_sequence: 10, p_last_sequence: 15 }));
  });

  it('restarts from the exact uncommitted ledger range after a crash', async () => {
    const f = fixture(); f.crash(true);
    await expect(f.make().ingest()).rejects.toThrow('rolled back');
    expect(f.saved()).toBeNull(); expect(f.persisted.size).toBe(0);
    f.crash(false); await f.make().ingest();
    f.server.getLatestLedger.mockResolvedValue({ sequence: 18 });
    f.server.getEvents.mockResolvedValue({ events: [], latestLedger: 18, oldestLedger: 1 });
    await f.make().ingest();
    expect(f.server.getEvents.mock.calls.at(-1)[0]).toMatchObject({ startLedger: 16, endLedger: 19 });
    expect(f.persisted.size).toBe(1); expect(f.saved()).toBe(18);
  });

  it('drains all pages of a ledger before checkpointing and deduplicates repeated events', async () => {
    const f = fixture();
    f.server.getEvents.mockResolvedValueOnce({ events: [event('a', 11), event('b', 11)], cursor: 'page-1', latestLedger: 15 })
      .mockResolvedValueOnce({ events: [event('b', 11), event('c', 15)], cursor: 'page-2', latestLedger: 15 })
      .mockResolvedValueOnce({ events: [event('future', 16)], cursor: 'page-3', latestLedger: 16 });
    await f.make({ pageSize: 2 }).ingest();
    expect(f.server.getEvents.mock.calls[1][0]).toEqual({ cursor: 'page-1', filters: [{ type: 'contract', contractIds: [contractId] }], limit: 2 });
    expect([...f.persisted.keys()]).toEqual(['a', 'b', 'c']);
    expect(f.supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not advance on a pagination failure or repeat cursor', async () => {
    const f = fixture(); f.server.getEvents.mockResolvedValue({ events: [event('a', 11)], cursor: 'stuck', latestLedger: 15 });
    await expect(f.make({ pageSize: 1 }).ingest()).rejects.toThrow('did not advance');
    expect(f.supabase.rpc).not.toHaveBeenCalled();
  });

  it('resumes correctly when the commit succeeded but its response was lost', async () => {
    const f = fixture();
    const commit = f.supabase.rpc.getMockImplementation();
    f.supabase.rpc.mockImplementationOnce(async (...args) => {
      await commit(...args); return { error: new Error('connection lost after commit') };
    });
    await expect(f.make().ingest()).rejects.toThrow('connection lost');
    expect(f.saved()).toBe(15);
    await f.make().ingest();
    expect(f.server.getEvents).toHaveBeenCalledTimes(1);
    expect(f.persisted.size).toBe(1);
  });

  it('reports high-severity lag and does not silently skip data outside RPC retention', async () => {
    const f = fixture(); f.server.getLatestLedger.mockResolvedValue({ sequence: 50 });
    const indexer = f.make();
    expect(await indexer.health()).toMatchObject({ ready: false, ledger_lag: 40 });
    expect(f.logger.error).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical', ledger_lag: 40 }));
    f.server.getEvents.mockResolvedValue({ events: [], oldestLedger: 20, latestLedger: 50 });
    await expect(indexer.ingest()).rejects.toThrow('archival backfill');
    expect(f.saved()).toBeNull();
  });

  it('marks readiness healthy after catch-up and unhealthy on RPC failure', async () => {
    const f = fixture(); const indexer = f.make(); await indexer.ingest();
    expect(await indexer.health()).toMatchObject({ ready: true, ledger_lag: 0 });
    f.server.getLatestLedger.mockRejectedValue(new Error('RPC unavailable'));
    expect(await indexer.health()).toMatchObject({ ready: false, warning: 'RPC unavailable' });
  });
});
