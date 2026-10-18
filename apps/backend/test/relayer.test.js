import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import app from '../index.js';
import { makeApiKey } from './helpers.js';
import {
  RelayerError,
  SequenceManager,
  ChannelPool,
  createRelayer,
  createSupabaseFeeBudget,
  pullInvocation,
  resultCode,
} from '../relayer.js';

// relayer.js loads the SDK's CommonJS build; XDR values from its ESM build are different
// classes and fail its type checks, so the tests must share the same copy
const { Keypair, StrKey, Account, Networks, FeeBumpTransaction, authorizeInvocation, Asset, Operation, TransactionBuilder, BASE_FEE } = createRequire(import.meta.url)('@stellar/stellar-sdk');

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 3));
const LATEST_LEDGER = 500;

const signPull = (signer, { user, merchant, validUntil = LATEST_LEDGER + 100, invocationMerchant = merchant } = {}) =>
  authorizeInvocation({
    signer,
    validUntilLedgerSeq: validUntil,
    invocation: pullInvocation(CONTRACT_ID, user, invocationMerchant),
    networkPassphrase: Networks.TESTNET,
  });

// In-memory fee budget with the same contract as the Supabase one
const createMemoryBudget = (dailyLimitStroops = 1_000_000) => {
  const budget = {
    dailyLimitStroops,
    used: 0,
    txCount: 0,
    reserve: vi.fn(async (merchantId, amount) => {
      if (budget.used + amount > dailyLimitStroops) return null;
      budget.used += amount;
      return '2026-10-16';
    }),
    adjust: vi.fn(async (merchantId, usageDate, feeDelta, txDelta) => {
      budget.used = Math.max(0, budget.used + feeDelta);
      budget.txCount += txDelta;
    }),
    usage: vi.fn(async () => ({ usageDate: '2026-10-16', feeStroops: budget.used, txCount: budget.txCount })),
  };
  return budget;
};

// Mock Soroban RPC: accounts start at sequence 100 and getTransaction confirms SUCCESS
const createMockServer = () => ({
  getAccount: vi.fn(async (publicKey) => new Account(publicKey, '100')),
  getLatestLedger: vi.fn().mockResolvedValue({ sequence: LATEST_LEDGER }),
  prepareTransaction: vi.fn(async (tx) => tx),
  simulateTransaction: vi.fn(),
  sendTransaction: vi.fn(async (tx) => ({ status: 'PENDING', hash: `hash-${tx.innerTransaction.sequence}` })),
  getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', resultXdr: { feeCharged: 150n } }),
});

const badSeq = { status: 'ERROR', errorResult: { result: { type: 'txFeeBumpInnerFailed', innerResultPair: { result: { result: { type: 'txBadSeq' } } } } } };

const confirmWith = (server) => async (srv, hash) => server.getTransaction(hash);

describe('Fee-bump relayer', () => {
  let server;
  let budget;
  let sponsor;
  let merchant;
  let user;
  const logger = { warn: vi.fn(), error: vi.fn() };

  const build = ({ channels, options } = {}) => createRelayer({
    server,
    sponsor,
    channels: channels ?? [sponsor],
    contractId: CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    budget,
    logger,
    sleep: async () => {},
    options: { retryDelayMs: 0, ...options },
  });

  beforeEach(() => {
    server = createMockServer();
    budget = createMemoryBudget();
    sponsor = Keypair.random();
    merchant = Keypair.random();
    user = Keypair.random();
  });

  const relay = async (relayer, entry) => relayer.relayPull({
    merchantId: 'merchant-1',
    entry: entry ?? await signPull(merchant, { user: user.publicKey(), merchant: merchant.publicKey() }),
    user: user.publicKey(),
    merchant: merchant.publicKey(),
    confirm: confirmWith(server),
  });

  describe('fee bump wrapping', () => {
    it('submits the pull as a fee bump paid by the relayer, never sourced from the merchant', async () => {
      const channel = Keypair.random();
      const outcome = await relay(build({ channels: [channel] }));

      expect(outcome).toMatchObject({ status: 'SUCCESS', feeCharged: 150, attempts: 1 });
      const feeBump = server.sendTransaction.mock.calls[0][0];
      expect(feeBump).toBeInstanceOf(FeeBumpTransaction);
      expect(feeBump.feeSource).toBe(sponsor.publicKey());
      expect(sponsor.verify(feeBump.hash(), feeBump.signatures[0].signature)).toBe(true);

      const inner = feeBump.innerTransaction;
      expect(inner.source).toBe(channel.publicKey());
      expect(inner.source).not.toBe(merchant.publicKey());
      expect(channel.verify(inner.hash(), inner.signatures[0].signature)).toBe(true);
      expect(server.getAccount).not.toHaveBeenCalledWith(merchant.publicKey());
    });

    it("carries the merchant's signed authorization entry unchanged", async () => {
      const entry = await signPull(merchant, { user: user.publicKey(), merchant: merchant.publicKey() });
      await relay(build(), entry);

      const op = server.sendTransaction.mock.calls[0][0].innerTransaction.operations[0];
      expect(op.auth).toHaveLength(1);
      expect(op.auth[0].toXdr('base64')).toBe(entry.toXdr('base64'));
    });

    it('defaults to the sponsor as its own channel account', async () => {
      await relay(build());
      expect(server.sendTransaction.mock.calls[0][0].innerTransaction.source).toBe(sponsor.publicKey());
    });
  });

  describe('sequence management', () => {
    it('hands consecutive sequence numbers to back-to-back relays from one ledger read', async () => {
      const relayer = build();
      await relay(relayer);
      await relay(relayer);

      const sequences = server.sendTransaction.mock.calls.map(([tx]) => tx.innerTransaction.sequence);
      expect(sequences).toEqual(['101', '102']);
      expect(server.getAccount).toHaveBeenCalledTimes(1);
    });

    it('never lets concurrent relays share a source account and sequence number', async () => {
      const channels = [Keypair.random(), Keypair.random()];
      const relayer = build({ channels });
      await Promise.all([relay(relayer), relay(relayer), relay(relayer), relay(relayer)]);

      const used = server.sendTransaction.mock.calls.map(([tx]) => `${tx.innerTransaction.source}:${tx.innerTransaction.sequence}`);
      expect(new Set(used).size).toBe(4);
      expect(new Set(server.sendTransaction.mock.calls.map(([tx]) => tx.innerTransaction.source)))
        .toEqual(new Set(channels.map((c) => c.publicKey())));
    });

    it('resyncs from the ledger and retries after a txBadSeq collision', async () => {
      server.sendTransaction.mockResolvedValueOnce(badSeq);
      server.getAccount
        .mockResolvedValueOnce(new Account(sponsor.publicKey(), '100'))
        // Something else used sequence 101 in the meantime
        .mockResolvedValueOnce(new Account(sponsor.publicKey(), '101'));

      const outcome = await relay(build());

      expect(outcome.attempts).toBe(2);
      expect(server.getAccount).toHaveBeenCalledTimes(2);
      expect(server.sendTransaction.mock.calls.map(([tx]) => tx.innerTransaction.sequence)).toEqual(['101', '102']);
    });

    it('retries TRY_AGAIN_LATER with the same sequence number', async () => {
      server.sendTransaction.mockResolvedValueOnce({ status: 'TRY_AGAIN_LATER', hash: 'x' });

      const outcome = await relay(build());

      expect(outcome.attempts).toBe(2);
      expect(server.sendTransaction.mock.calls.map(([tx]) => tx.innerTransaction.sequence)).toEqual(['101', '101']);
    });

    it('gives up with relayer_busy and refunds the budget once retries are exhausted', async () => {
      server.sendTransaction.mockResolvedValue({ status: 'TRY_AGAIN_LATER', hash: 'x' });

      await expect(relay(build({ options: { maxAttempts: 3 } }))).rejects.toMatchObject({ code: 'relayer_busy', status: 503 });
      expect(server.sendTransaction).toHaveBeenCalledTimes(3);
      expect(budget.used).toBe(0);
    });

    it('does not retry other submission errors', async () => {
      server.sendTransaction.mockResolvedValue({ status: 'ERROR', errorResult: { result: { type: 'txInsufficientFee' } } });

      await expect(relay(build())).rejects.toMatchObject({ code: 'submission_rejected', status: 502 });
      expect(server.sendTransaction).toHaveBeenCalledTimes(1);
      expect(budget.used).toBe(0);
    });

    it('releases the channel after a failure so later relays still run', async () => {
      const relayer = build();
      server.prepareTransaction.mockRejectedValueOnce(new Error('HostError: Too early to pull funds'));

      await expect(relay(relayer)).rejects.toMatchObject({ code: 'simulation_failed', status: 422 });
      await expect(relay(relayer)).resolves.toMatchObject({ status: 'SUCCESS' });
    });
  });

  describe('budget and fee guard', () => {
    it('books the fee bump fee, then settles it to the fee actually charged', async () => {
      await relay(build());

      // 1 op + fee bump at the 100 stroop base fee = 200 reserved, 150 charged
      expect(budget.reserve).toHaveBeenCalledWith('merchant-1', 200);
      expect(budget.adjust).toHaveBeenCalledWith('merchant-1', '2026-10-16', -50, 1);
      expect(budget.used).toBe(150);
    });

    it('refuses to sponsor once the daily budget is used up', async () => {
      budget = createMemoryBudget(199);

      await expect(relay(build())).rejects.toMatchObject({ code: 'daily_budget_exceeded', status: 429 });
      expect(server.sendTransaction).not.toHaveBeenCalled();
    });

    it('refuses a pull whose fee exceeds the per-transaction cap', async () => {
      await expect(relay(build({ options: { maxFeeStroops: 150 } }))).rejects.toMatchObject({ code: 'fee_cap_exceeded' });
      expect(budget.reserve).not.toHaveBeenCalled();
    });

    it('keeps the full reservation while confirmation is still pending', async () => {
      server.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

      const outcome = await relay(build());

      expect(outcome).toMatchObject({ status: 'NOT_FOUND', feeCharged: null });
      expect(budget.used).toBe(200);
      expect(budget.txCount).toBe(1);
    });
  });

  describe('merchant authorization', () => {
    const verify = (relayer, entry, parties = {}) => relayer.verifyPullAuthorization({
      entryXdr: typeof entry === 'string' ? entry : entry.toXdr('base64'),
      user: user.publicKey(),
      merchant: merchant.publicKey(),
      ...parties,
    });

    it('accepts an entry the merchant signed for this exact pull', async () => {
      const entry = await signPull(merchant, { user: user.publicKey(), merchant: merchant.publicKey() });
      await expect(verify(build(), entry)).resolves.toBeDefined();
    });

    it('rejects an entry signed by a key other than the merchant', async () => {
      const impostor = Keypair.random();
      const entry = await signPull(impostor, { user: user.publicKey(), merchant: impostor.publicKey() });
      await expect(verify(build(), entry)).rejects.toMatchObject({ code: 'invalid_authorization', status: 400 });
    });

    it('rejects an authorization for a different subscriber', async () => {
      const entry = await signPull(merchant, { user: Keypair.random().publicKey(), merchant: merchant.publicKey() });
      await expect(verify(build(), entry)).rejects.toMatchObject({ code: 'invalid_authorization' });
    });

    it('rejects an expired authorization', async () => {
      const entry = await signPull(merchant, { user: user.publicKey(), merchant: merchant.publicKey(), validUntil: LATEST_LEDGER });
      await expect(verify(build(), entry)).rejects.toMatchObject({ code: 'authorization_expired' });
    });

    it('rejects a merchant signature that does not cover this network', async () => {
      // Structurally valid and signed by the merchant, but over the mainnet passphrase, so
      // the signature cannot be replayed onto testnet (or vice versa)
      const wrongNetwork = await authorizeInvocation({
        signer: merchant,
        validUntilLedgerSeq: LATEST_LEDGER + 100,
        invocation: pullInvocation(CONTRACT_ID, user.publicKey(), merchant.publicKey()),
        networkPassphrase: Networks.PUBLIC,
      });
      await expect(verify(build(), wrongNetwork)).rejects.toMatchObject({ code: 'invalid_signature', status: 401 });
    });

    it('rejects input that is not an authorization entry', async () => {
      await expect(verify(build(), 'not-xdr')).rejects.toMatchObject({ code: 'invalid_authorization' });
    });

    it('returns the unsigned merchant entry from simulation', async () => {
      const unsigned = await signPull(merchant, { user: user.publicKey(), merchant: merchant.publicKey() });
      const otherEntry = await signPull(user, { user: user.publicKey(), merchant: user.publicKey() });
      server.simulateTransaction.mockResolvedValue({
        transactionData: {}, latestLedger: LATEST_LEDGER, result: { auth: [otherEntry, unsigned], retval: null },
      });

      const prepared = await build().preparePullAuthorization({ user: user.publicKey(), merchant: merchant.publicKey() });

      expect(prepared).toEqual({ authEntryXdr: unsigned.toXdr('base64'), validUntilLedger: LATEST_LEDGER + 100 });
      const simulated = server.simulateTransaction.mock.calls[0][0];
      expect(simulated.source).toBe(sponsor.publicKey());
    });

    it('surfaces simulation errors such as pulling too early', async () => {
      server.simulateTransaction.mockResolvedValue({ error: 'HostError: Too early to pull funds' });
      await expect(build().preparePullAuthorization({ user: user.publicKey(), merchant: merchant.publicKey() }))
        .rejects.toMatchObject({ code: 'simulation_failed', status: 422 });
    });
  });
});

describe('Relayer building blocks', () => {
  it('unwraps the inner result code of a fee bump', () => {
    expect(resultCode(badSeq.errorResult)).toBe('txBadSeq');
    expect(resultCode({ result: { type: 'txBadSeq' } })).toBe('txBadSeq');
    expect(resultCode(undefined)).toBeNull();
  });

  it('SequenceManager reads the ledger once, then advances locally until invalidated', async () => {
    const pk = Keypair.random().publicKey();
    const server = { getAccount: vi.fn(async () => new Account(pk, '7')) };
    const sequences = new SequenceManager(server);

    expect((await sequences.account(pk)).sequenceNumber()).toBe('7');
    sequences.commit(pk, '8');
    expect((await sequences.account(pk)).sequenceNumber()).toBe('8');
    expect(server.getAccount).toHaveBeenCalledTimes(1);

    sequences.invalidate(pk);
    await sequences.account(pk);
    expect(server.getAccount).toHaveBeenCalledTimes(2);
  });

  it('ChannelPool queues callers in order and times out with relayer_busy', async () => {
    const a = Keypair.random();
    const pool = new ChannelPool([a], { queueTimeoutMs: 20 });

    const first = await pool.acquire();
    const second = pool.acquire();
    const third = pool.acquire();
    expect(pool.queued).toBe(2);

    pool.release(first);
    expect(await second).toBe(a);
    await expect(third).rejects.toBeInstanceOf(RelayerError);
    await expect(third).rejects.toMatchObject({ code: 'relayer_busy', status: 503 });
  });

  it('Supabase fee budget reserves and adjusts through the database functions', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: '2026-10-16', error: null }),
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { fee_stroops: '1200', tx_count: 3 }, error: null }),
    };
    const feeBudget = createSupabaseFeeBudget(() => supabase, { dailyLimitStroops: 5000 });

    expect(await feeBudget.reserve('m1', 200)).toBe('2026-10-16');
    expect(supabase.rpc).toHaveBeenCalledWith('reserve_relayer_fee', { p_merchant_id: 'm1', p_amount: 200, p_daily_limit: 5000 });

    await feeBudget.adjust('m1', '2026-10-16', -50, 1);
    expect(supabase.rpc).toHaveBeenCalledWith('adjust_relayer_fee', {
      p_merchant_id: 'm1', p_usage_date: '2026-10-16', p_fee_delta: -50, p_tx_delta: 1,
    });

    expect(await feeBudget.usage('m1')).toMatchObject({ feeStroops: 1200, txCount: 3 });
    expect(supabase.from).toHaveBeenCalledWith('relayer_fee_usage');
  });
});

describe('Relay routes', () => {
  const validMerchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
  const validSubscriptionId = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';
  const merchant = Keypair.random();
  const user = Keypair.random();

  let mockSupabase;
  let apiKey;
  let server;
  let budget;

  beforeEach(() => {
    mockSupabase = {
      from: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: validSubscriptionId,
          customer_wallet_address: user.publicKey(),
          plans: { merchant_id: validMerchantId, usdc_amount: 290000000, interval_seconds: 2592000 },
        },
        error: null,
      }),
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    };
    apiKey = makeApiKey({ merchantId: validMerchantId, walletAddress: merchant.publicKey() });
    mockSupabase.maybeSingle = vi.fn().mockResolvedValue({ data: apiKey.row, error: null });

    server = createMockServer();
    budget = createMemoryBudget();
    app.locals.supabase = mockSupabase;
    app.locals.relayer = createRelayer({
      server,
      sponsor: Keypair.random(),
      contractId: CONTRACT_ID,
      budget,
      logger: { warn: vi.fn(), error: vi.fn() },
      sleep: async () => {},
      options: { retryDelayMs: 0 },
    });
    app.locals.txPollIntervalMs = 1;
    app.locals.txPollTimeoutMs = 20;
    for (const limiter of Object.values(app.locals.rateLimiters)) limiter.reset();
  });

  afterEach(() => {
    delete app.locals.relayer;
    delete app.locals.txPollIntervalMs;
    delete app.locals.txPollTimeoutMs;
  });

  const submit = async (entry) => request(app)
    .post('/relay/submit-pull')
    .set('Authorization', apiKey.header)
    .send({
      subscription_id: validSubscriptionId,
      signed_auth_entry_xdr: (entry ?? await signPull(merchant, { user: user.publicKey(), merchant: merchant.publicKey() })).toXdr('base64'),
    });

  it('relays a merchant-authorized pull and advances billing without the merchant paying fees', async () => {
    const res = await submit();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      txHash: 'hash-101', sponsored: true, fee_charged_stroops: 150, attempts: 1,
      sponsor_address: app.locals.relayer.sponsorAddress,
    });
    expect(server.getAccount).not.toHaveBeenCalledWith(merchant.publicKey());
    expect(mockSupabase.update).toHaveBeenCalledWith(expect.objectContaining({ next_billing_date: expect.any(String), status: 'active' }));
    expect(mockSupabase.rpc).toHaveBeenCalledWith('acquire_billing_lock', expect.objectContaining({ p_subscription_id: validSubscriptionId }));
  });

  it('marks the subscription past_due when the relayed transaction fails on-chain', async () => {
    server.getTransaction.mockResolvedValue({ status: 'FAILED', resultXdr: { feeCharged: 120n } });

    const res = await submit();

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ sponsored: true, fee_charged_stroops: 120 });
    expect(mockSupabase.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'past_due' }));
  });

  it('rejects an authorization not signed by the merchant before spending anything', async () => {
    const impostor = Keypair.random();
    const res = await submit(await signPull(impostor, { user: user.publicKey(), merchant: impostor.publicKey() }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_authorization');
    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when the daily gas budget is exhausted', async () => {
    budget.used = budget.dailyLimitStroops;

    const res = await submit();

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('daily_budget_exceeded');
    expect(res.headers['retry-after']).toBe('3600');
  });

  it('throttles relay requests per merchant', async () => {
    const send = () => request(app).post('/relay/submit-pull').set('Authorization', apiKey.header)
      .send({ subscription_id: validSubscriptionId, signed_auth_entry_xdr: 'not-xdr' });

    // Default RELAYER_RATE_LIMIT_MAX is 10 per minute
    for (let i = 0; i < 10; i += 1) expect((await send()).status).toBe(400);
    const limited = await send();

    expect(limited.status).toBe(429);
    expect(limited.body.error).toContain('Relay rate limit');
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it('returns the authorization entry the merchant has to sign', async () => {
    const unsigned = await signPull(merchant, { user: user.publicKey(), merchant: merchant.publicKey() });
    server.simulateTransaction.mockResolvedValue({ transactionData: {}, latestLedger: LATEST_LEDGER, result: { auth: [unsigned] } });

    const res = await request(app).post('/relay/prepare-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      auth_entry_xdr: unsigned.toXdr('base64'),
      valid_until_ledger: LATEST_LEDGER + 100,
      merchant_address: merchant.publicKey(),
      sponsor_address: app.locals.relayer.sponsorAddress,
    });
  });

  it("reports the merchant's sponsorship budget", async () => {
    budget.used = 400;
    const res = await request(app).get('/relay/budget').set('Authorization', apiKey.header);

    expect(res.status).toBe(200);
    expect(res.body.budget).toMatchObject({ daily_limit_stroops: 1_000_000, used_stroops: 400, remaining_stroops: 999_600 });
  });

  it('returns 503 when no relayer key is configured', async () => {
    // Without an injected relayer the app builds one from env, which needs RELAYER_SECRET_KEY
    delete app.locals.relayer;
    delete process.env.RELAYER_SECRET_KEY;

    const res = await submit();

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('relayer_unavailable');
  });

  it('sponsors an atomic transaction on behalf of checkout widget (#169)', async () => {
    const dummyKeypair = Keypair.random();
    const sourceAccount = new Account(dummyKeypair.publicKey(), '100');
    const innerTx = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }))
      .setTimeout(60)
      .build();
    innerTx.sign(dummyKeypair);

    const res = await request(app)
      .post('/relay/sponsor-transaction')
      .send({ tx_xdr: innerTx.toXDR(), network_passphrase: Networks.TESTNET });

    expect(res.status).toBe(200);
    expect(res.body.sponsored).toBe(true);
    expect(res.body.sponsorAddress).toBe(app.locals.relayer.sponsorAddress);
  });

  it('rejects sponsorship request with 400 when tx_xdr is missing', async () => {
    const res = await request(app)
      .post('/relay/sponsor-transaction')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('tx_xdr is required');
  });
});
