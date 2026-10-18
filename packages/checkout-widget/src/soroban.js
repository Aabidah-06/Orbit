import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';

const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

export class PendingTransactionError extends Error {
  constructor(hash) {
    super('The transaction is still pending on Stellar.');
    this.name = 'PendingTransactionError';
    this.hash = hash;
  }
}

export const pollTransaction = async (server, hash, { onProgress, timeoutMs = 60000 } = {}) => {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const result = await server.getTransaction(hash);
    if (result.status === 'SUCCESS') return result;
    if (result.status === 'FAILED') throw new Error('Stellar rejected this transaction. Check the transaction details and try again.');
    const elapsed = Math.min(timeoutMs, Date.now() - startedAt);
    onProgress?.({ elapsedMs: elapsed, remainingMs: Math.max(0, timeoutMs - elapsed), attempt });
    await sleep(Math.min(attempt + 1, 3) * 1000);
    attempt += 1;
  }
  throw new PendingTransactionError(hash);
};

const signAndSubmit = async ({ server, transaction, wallet, address, networkPassphrase, stage, onSubmitted, onProgress }) => {
  const prepared = await server.prepareTransaction(transaction);
  const { signedTxXdr } = await wallet.signTransaction(prepared.toXDR(), {
    address,
    networkPassphrase,
  });
  const signed = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);
  const submission = await server.sendTransaction(signed);
  if (!['PENDING', 'SUCCESS'].includes(submission.status)) {
    throw new Error(`Transaction submission was rejected (${submission.status}).`);
  }
  onSubmitted?.({ stage, hash: submission.hash });
  if (submission.status !== 'SUCCESS') await pollTransaction(server, submission.hash, { onProgress });
  return submission.hash;
};

const makeBalanceTransaction = (account, tokenContractId, address, networkPassphrase) => new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
  .addOperation(new Contract(tokenContractId).call('balance', Address.fromString(address).toScVal()))
  .setTimeout(60)
  .build();

const simulate = async (server, transaction) => {
  const result = await server.simulateTransaction(transaction);
  if (result.error) throw new Error(result.error);
  if (result.result?.retval === undefined) throw new Error('The network could not simulate this transaction.');
  return result;
};

const buildPlanTransactions = ({ account, address, merchantAddress, amount, intervalSeconds, orbitContractId, tokenContractId, networkPassphrase, ledgerSequence, billingCycles }) => {
  const allowance = BigInt(amount) * BigInt(billingCycles);
  const ledgersPerCycle = Math.ceil(Number(intervalSeconds) / 5);
  const liveUntilLedger = Number(ledgerSequence) + Math.max(120960, ledgersPerCycle * billingCycles + 120960);
  const token = new Contract(tokenContractId);
  const approve = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(token.call('approve', Address.fromString(address).toScVal(), Address.fromString(orbitContractId).toScVal(), nativeToScVal(allowance, { type: 'i128' }), nativeToScVal(liveUntilLedger, { type: 'u32' })))
    .setTimeout(60)
    .build();
  const createVault = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(orbitContractId).call('create_vault', Address.fromString(address).toScVal(), Address.fromString(merchantAddress).toScVal(), Address.fromString(tokenContractId).toScVal(), nativeToScVal(BigInt(amount), { type: 'i128' }), nativeToScVal(BigInt(intervalSeconds), { type: 'u64' })))
    .setTimeout(60)
    .build();
  return { approve, createVault };
};

/**
 * Builds an atomic batch transaction bundling token trustline (if needed), allowance approval,
 * and vault creation into a single transaction invocation (#169).
 */
export const buildAtomicPlanTransaction = ({
  account,
  address,
  merchantAddress,
  amount,
  intervalSeconds,
  orbitContractId,
  tokenContractId,
  networkPassphrase,
  ledgerSequence,
  billingCycles = 12,
  includeTrustline = false,
  assetCode = 'USDC',
  assetIssuer = null,
}) => {
  const allowance = BigInt(amount) * BigInt(billingCycles);
  const ledgersPerCycle = Math.ceil(Number(intervalSeconds) / 5);
  const liveUntilLedger = Number(ledgerSequence) + Math.max(120960, ledgersPerCycle * billingCycles + 120960);

  const token = new Contract(tokenContractId);
  const orbit = new Contract(orbitContractId);

  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase });

  // 1. Optional token trustline creation for classic/SAC asset
  if (includeTrustline && assetIssuer) {
    builder.addOperation(
      Operation.changeTrust({
        asset: new Asset(assetCode, assetIssuer),
        limit: '922337203685.4775807',
      })
    );
  }

  // 2. Token allowance approval
  builder.addOperation(
    token.call(
      'approve',
      Address.fromString(address).toScVal(),
      Address.fromString(orbitContractId).toScVal(),
      nativeToScVal(allowance, { type: 'i128' }),
      nativeToScVal(liveUntilLedger, { type: 'u32' })
    )
  );

  // 3. Vault creation invocation
  builder.addOperation(
    orbit.call(
      'create_vault',
      Address.fromString(address).toScVal(),
      Address.fromString(merchantAddress).toScVal(),
      Address.fromString(tokenContractId).toScVal(),
      nativeToScVal(BigInt(amount), { type: 'i128' }),
      nativeToScVal(BigInt(intervalSeconds), { type: 'u64' })
    )
  );

  return builder.setTimeout(60).build();
};

/**
 * Submits a transaction through the backend gas relayer for fee sponsorship (#169).
 */
export async function submitSponsoredTransaction({
  server,
  transaction,
  apiUrl,
  networkPassphrase,
}) {
  if (apiUrl) {
    try {
      const res = await fetch(`${apiUrl}/relay/sponsor-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx_xdr: transaction.toXDR(),
          network_passphrase: networkPassphrase,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const txHash = data.txHash || data.tx_hash || data.hash;
        if (txHash) {
          return { hash: txHash, sponsored: true };
        }
      }
    } catch (e) {
      console.warn('Relayer sponsorship service unavailable, falling back to direct RPC submission:', e);
    }
  }

  // Fallback to direct RPC submission if relayer is unavailable
  const submission = await server.sendTransaction(transaction);
  if (!['PENDING', 'SUCCESS'].includes(submission.status)) {
    throw new Error(`Transaction submission was rejected (${submission.status}).`);
  }
  return { hash: submission.hash, sponsored: false };
}

export async function preflightPlan({ address, merchantAddress, amount, intervalSeconds, orbitContractId, tokenContractId, rpcUrl, networkPassphrase, billingCycles = 12, minimumXlmBalanceStroops = 1_000_000 }) {
  if (!orbitContractId || !tokenContractId) throw new Error('Missing Orbit or token contract configuration.');
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(address);
  const ledger = await server.getLatestLedger();
  const transactions = buildPlanTransactions({ account, address, merchantAddress, amount, intervalSeconds, orbitContractId, tokenContractId, networkPassphrase, ledgerSequence: ledger.sequence, billingCycles });
  const [balanceResult, approveSimulation, vaultSimulation] = await Promise.all([simulate(server, makeBalanceTransaction(account, tokenContractId, address, networkPassphrase)), simulate(server, transactions.approve), simulate(server, transactions.createVault)]);
  const usdcBalance = BigInt(scValToNative(balanceResult.result.retval));
  const xlmBalance = BigInt(account.balance || 0);
  const approveFee = BigInt(approveSimulation.minResourceFee || approveSimulation.result?.minResourceFee || BASE_FEE);
  const vaultFee = BigInt(vaultSimulation.minResourceFee || vaultSimulation.result?.minResourceFee || BASE_FEE);
  const estimatedFeeStroops = approveFee + vaultFee;
  if (usdcBalance < BigInt(amount)) throw new Error(`Insufficient USDC balance. You need ${(Number(amount) / 10_000_000).toFixed(2)} USDC plus network fees. Top up this wallet and try again.`);
  if (xlmBalance < estimatedFeeStroops + BigInt(minimumXlmBalanceStroops)) throw new Error(`Insufficient XLM for network fees. Keep at least ${(Number(estimatedFeeStroops + BigInt(minimumXlmBalanceStroops)) / 10_000_000).toFixed(4)} XLM in this wallet, then try again.`);
  return { server, account, transactions, usdcBalance, xlmBalance, estimatedFeeStroops, minimumXlmBalanceStroops };
}

/**
 * Authorizes a plan atomically in a single transaction with relayer gas sponsorship support (#169).
 */
export async function authorizePlanAtomic({
  wallet,
  address,
  merchantAddress,
  amount,
  intervalSeconds,
  orbitContractId,
  tokenContractId,
  rpcUrl,
  networkPassphrase,
  billingCycles = 12,
  apiUrl = null,
  sponsorFees = true,
  includeTrustline = false,
  assetCode = 'USDC',
  assetIssuer = null,
  onSubmitted,
  onProgress,
}) {
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(address);
  const ledger = await server.getLatestLedger();

  const atomicTx = buildAtomicPlanTransaction({
    account,
    address,
    merchantAddress,
    amount,
    intervalSeconds,
    orbitContractId,
    tokenContractId,
    networkPassphrase,
    ledgerSequence: ledger.sequence,
    billingCycles,
    includeTrustline,
    assetCode,
    assetIssuer,
  });

  const prepared = await server.prepareTransaction(atomicTx);
  const { signedTxXdr } = await wallet.signTransaction(prepared.toXDR(), {
    address,
    networkPassphrase,
  });

  const signed = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);

  let txHash;
  let isSponsored = false;
  if (sponsorFees && apiUrl) {
    const result = await submitSponsoredTransaction({
      server,
      transaction: signed,
      apiUrl,
      networkPassphrase,
    });
    txHash = result.hash;
    isSponsored = result.sponsored;
  } else {
    const submission = await server.sendTransaction(signed);
    if (!['PENDING', 'SUCCESS'].includes(submission.status)) {
      throw new Error(`Transaction submission was rejected (${submission.status}).`);
    }
    txHash = submission.hash;
  }

  onSubmitted?.({ stage: 'atomic_checkout', hash: txHash, sponsored: isSponsored });
  await pollTransaction(server, txHash, { onProgress });
  return { vaultHash: txHash, approvalHash: txHash, atomic: true, sponsored: isSponsored };
}

export async function authorizePlan({
  wallet,
  address,
  merchantAddress,
  amount,
  intervalSeconds,
  orbitContractId,
  tokenContractId,
  rpcUrl,
  networkPassphrase,
  billingCycles = 12,
  preflight,
  onSubmitted,
  onProgress,
}) {
  const details = preflight || await preflightPlan({ address, merchantAddress, amount, intervalSeconds, orbitContractId, tokenContractId, rpcUrl, networkPassphrase, billingCycles });
  const { server, transactions } = details;
  const approvalHash = await signAndSubmit({ server, transaction: transactions.approve, wallet, address, networkPassphrase, stage: 'approval', onSubmitted, onProgress });

  const refreshedAccount = await server.getAccount(address);
  const refreshedTransactions = buildPlanTransactions({ account: refreshedAccount, address, merchantAddress, amount, intervalSeconds, orbitContractId, tokenContractId, networkPassphrase, ledgerSequence: (await server.getLatestLedger()).sequence, billingCycles });
  const vaultHash = await signAndSubmit({ server, transaction: refreshedTransactions.createVault, wallet, address, networkPassphrase, stage: 'vault', onSubmitted, onProgress });
  return { approvalHash, vaultHash };
}

