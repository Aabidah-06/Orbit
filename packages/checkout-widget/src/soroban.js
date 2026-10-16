import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';

const waitForTransaction = async (server, hash) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await server.getTransaction(hash);
    if (result.status === 'SUCCESS') return result;
    if (result.status === 'FAILED') throw new Error('The Soroban transaction failed on-chain.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Transaction confirmation timed out. Check the transaction in Stellar Expert.');
};

const signAndSubmit = async ({ server, transaction, wallet, address, networkPassphrase }) => {
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
  await waitForTransaction(server, submission.hash);
  return submission.hash;
};

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
}) {
  if (!orbitContractId || !tokenContractId) throw new Error('Missing Orbit or token contract configuration.');
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(address);
  const ledger = await server.getLatestLedger();
  const allowance = BigInt(amount) * BigInt(billingCycles);
  const ledgersPerCycle = Math.ceil(Number(intervalSeconds) / 5);
  const liveUntilLedger = Number(ledger.sequence) + Math.max(120960, ledgersPerCycle * billingCycles + 120960);
  const token = new Contract(tokenContractId);
  const approve = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(token.call(
      'approve',
      Address.fromString(address).toScVal(),
      Address.fromString(orbitContractId).toScVal(),
      nativeToScVal(allowance, { type: 'i128' }),
      nativeToScVal(liveUntilLedger, { type: 'u32' }),
    ))
    .setTimeout(60)
    .build();
  const approvalHash = await signAndSubmit({ server, transaction: approve, wallet, address, networkPassphrase });

  const refreshedAccount = await server.getAccount(address);
  const orbit = new Contract(orbitContractId);
  const createVault = new TransactionBuilder(refreshedAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(orbit.call(
      'create_vault',
      Address.fromString(address).toScVal(),
      Address.fromString(merchantAddress).toScVal(),
      Address.fromString(tokenContractId).toScVal(),
      nativeToScVal(BigInt(amount), { type: 'i128' }),
      nativeToScVal(BigInt(intervalSeconds), { type: 'u64' }),
    ))
    .setTimeout(60)
    .build();
  const vaultHash = await signAndSubmit({ server, transaction: createVault, wallet, address, networkPassphrase });
  return { approvalHash, vaultHash };
}
