import { signTransaction } from "@stellar/freighter-api";
import { Address, BASE_FEE, Contract, Networks, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";

export const CHECKOUT_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
export const CHECKOUT_RPC = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

async function submit(server: rpc.Server, transaction: ReturnType<TransactionBuilder["build"]>, address: string) {
  const prepared = await server.prepareTransaction(transaction);
  const signed = await signTransaction(prepared.toXDR(), { address, networkPassphrase: CHECKOUT_NETWORK });
  if (!signed.signedTxXdr) throw new Error(signed.error?.message || "Freighter did not sign the transaction.");
  const response = await server.sendTransaction(TransactionBuilder.fromXDR(signed.signedTxXdr, CHECKOUT_NETWORK));
  if (!["PENDING", "SUCCESS"].includes(response.status)) throw new Error(`Transaction rejected (${response.status}).`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await server.getTransaction(response.hash);
    if (result.status === "SUCCESS") return response.hash;
    if (result.status === "FAILED") throw new Error("Transaction failed on-chain.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Transaction confirmation timed out.");
}

export async function createCheckoutVault(input: { address: string; merchant: string; amount: number; interval: number; cycles?: number }) {
  const orbitId = process.env.NEXT_PUBLIC_ORBIT_CONTRACT_ID;
  const tokenId = process.env.NEXT_PUBLIC_USDC_CONTRACT_ID;
  if (!orbitId || !tokenId) throw new Error("Checkout contracts are not configured.");
  const server = new rpc.Server(CHECKOUT_RPC);
  const account = await server.getAccount(input.address);
  const latest = await server.getLatestLedger();
  const cycles = input.cycles ?? 12;
  const liveUntil = Number(latest.sequence) + Math.max(120960, Math.ceil(input.interval / 5) * cycles + 120960);
  const approve = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: CHECKOUT_NETWORK })
    .addOperation(new Contract(tokenId).call("approve", Address.fromString(input.address).toScVal(), Address.fromString(orbitId).toScVal(), nativeToScVal(BigInt(input.amount) * BigInt(cycles), { type: "i128" }), nativeToScVal(liveUntil, { type: "u32" })))
    .setTimeout(60).build();
  const approvalHash = await submit(server, approve, input.address);
  const refreshed = await server.getAccount(input.address);
  const vault = new TransactionBuilder(refreshed, { fee: BASE_FEE, networkPassphrase: CHECKOUT_NETWORK })
    .addOperation(new Contract(orbitId).call("create_vault", Address.fromString(input.address).toScVal(), Address.fromString(input.merchant).toScVal(), Address.fromString(tokenId).toScVal(), nativeToScVal(BigInt(input.amount), { type: "i128" }), nativeToScVal(BigInt(input.interval), { type: "u64" })))
    .setTimeout(60).build();
  const vaultHash = await submit(server, vault, input.address);
  return { approvalHash, vaultHash };
}
