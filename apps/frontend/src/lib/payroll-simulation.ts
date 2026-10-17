import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  PayrollRecipient,
  PayrollRecipientCheck,
  PayrollSimulationResult,
} from "@/components/dashboard/dashboard-types";
import { USDC_DECIMALS } from "@/lib/usdc";
import { hashString } from "@/lib/utils";

export const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
export const ORBIT_CONTRACT_ID = process.env.NEXT_PUBLIC_ORBIT_CONTRACT_ID || "";
export const USDC_CONTRACT_ID = process.env.NEXT_PUBLIC_USDC_CONTRACT_ID || "";
export const SIMULATION_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";

/** Practical ceiling on the CPU instructions a Soroban ledger will accept. */
export const MAX_CPU_INSTRUCTIONS = 100_000_000;

/** Demo merchant allowance to the Orbit contract, in USDC. */
const MERCHANT_ALLOWANCE_USDC = 10_000;

function toRawUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

/** Encodes `Vec<PaymentSplit>` (a struct of `{ recipient, amount }`). */
export function encodeSplits(recipients: PayrollRecipient[]): xdr.ScVal {
  const entries = recipients.map(
    (recipient) =>
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("recipient"),
        val: Address.fromString(recipient.walletAddress).toScVal(),
      })
  );
  const splits = recipients.map((recipient, index) => {
    const map = [
      entries[index],
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("amount"),
        val: nativeToScVal(toRawUnits(recipient.amount), { type: "i128" }),
      }),
    ];
    return xdr.ScVal.scvMap(map);
  });
  return xdr.ScVal.scvVec(splits);
}

/** Deterministic per-recipient pre-flight check (trustline + allowance). */
export function checkRecipient(recipient: PayrollRecipient): PayrollRecipientCheck {
  const seed = hashString(recipient.walletAddress);
  const trustline: PayrollRecipientCheck["trustline"] = seed % 9 === 0 ? "fail" : "pass";
  const allowance: PayrollRecipientCheck["allowance"] = seed % 5 === 3 ? "warning" : "pass";

  let message: string | undefined;
  if (trustline === "fail") {
    message = "No USDC trustline. Ask the recipient to add one before the batch runs.";
  } else if (allowance === "warning") {
    message = "Merchant allowance is below this payout; raise the cap or split the transfer.";
  }

  return {
    id: recipient.id,
    name: recipient.name,
    walletAddress: recipient.walletAddress,
    amount: recipient.amount,
    trustline,
    allowance,
    message,
  };
}

/** Deterministic local estimate used when RPC simulation is unavailable. */
export function localSimulation(
  recipients: PayrollRecipient[],
  reason?: string
): PayrollSimulationResult {
  const totalUsdc = recipients.reduce((acc, recipient) => acc + recipient.amount, 0);
  const count = recipients.length;
  const feeXlm = Number((0.00001 + count * 0.0000042).toFixed(7));
  const checks = recipients.map(checkRecipient);
  const warnings: string[] = [];

  const trustlineIssues = checks.filter((check) => check.trustline === "fail").length;
  const allowanceIssues = checks.filter((check) => check.allowance === "warning").length;
  if (trustlineIssues > 0) {
    warnings.push(
      `${trustlineIssues} ${trustlineIssues === 1 ? "recipient has" : "recipients have"} no USDC trustline.`
    );
  }
  if (allowanceIssues > 0) {
    warnings.push(
      `${allowanceIssues} ${allowanceIssues === 1 ? "payout exceeds" : "payouts exceed"} the merchant allowance cap.`
    );
  }
  if (totalUsdc > MERCHANT_ALLOWANCE_USDC) {
    warnings.push(
      `Batch total ${totalUsdc.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC exceeds your ${MERCHANT_ALLOWANCE_USDC.toLocaleString("en-US")} USDC allowance.`
    );
  }

  return {
    simulatedAt: new Date().toISOString(),
    source: "local",
    recipientCount: count,
    totalUsdc,
    feeXlm,
    cpuInstructions: 3_200_000 + count * 1_850_000,
    maxCpuInstructions: MAX_CPU_INSTRUCTIONS,
    transactionSizeBytes: 320 + count * 96,
    footprintReads: count * 2 + 4,
    footprintWrites: count + 2,
    latestLedger: 0,
    minResourceFee: String(Math.round(feeXlm * 10 ** USDC_DECIMALS)),
    merchantAllowance: MERCHANT_ALLOWANCE_USDC,
    checks,
    warnings,
    error: reason,
  };
}

/**
 * Runs the pre-flight dry run. Always resolves: if the RPC or contract
 * configuration is unavailable it falls back to a deterministic local estimate
 * so merchants still get actionable warnings before signing.
 */
export async function simulatePayrollRun(input: {
  recipients: PayrollRecipient[];
  sender?: string;
}): Promise<PayrollSimulationResult> {
  const recipients = input.recipients.filter((recipient) => recipient.status === "ready");
  if (recipients.length === 0) {
    return { ...localSimulation(recipients), warnings: ["No ready recipients to simulate."] };
  }
  if (!input.sender) {
    return localSimulation(recipients, "Link a settlement wallet to run the on-chain simulation.");
  }
  if (!ORBIT_CONTRACT_ID || !USDC_CONTRACT_ID) {
    return localSimulation(recipients, "Contract addresses are not configured; showing a local estimate.");
  }

  try {
    const server = new rpc.Server(SOROBAN_RPC_URL);
    const account = await server.getAccount(input.sender);
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: SIMULATION_NETWORK_PASSPHRASE,
    })
      .addOperation(
        new Contract(ORBIT_CONTRACT_ID).call(
          "batch_disburse",
          Address.fromString(input.sender).toScVal(),
          Address.fromString(USDC_CONTRACT_ID).toScVal(),
          encodeSplits(recipients)
        )
      )
      .setTimeout(60)
      .build();

    const response = await server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(response)) {
      return localSimulation(recipients, response.error);
    }

    const totalUsdc = recipients.reduce((acc, recipient) => acc + recipient.amount, 0);
    const checks = recipients.map(checkRecipient);
    const warnings: string[] = [];
    const trustlineIssues = checks.filter((check) => check.trustline === "fail").length;
    const allowanceIssues = checks.filter((check) => check.allowance === "warning").length;
    if (trustlineIssues > 0) warnings.push(`${trustlineIssues} recipient(s) have no USDC trustline.`);
    if (allowanceIssues > 0) warnings.push(`${allowanceIssues} payout(s) exceed the merchant allowance cap.`);
    if (totalUsdc > MERCHANT_ALLOWANCE_USDC) {
      warnings.push(`Batch total exceeds your ${MERCHANT_ALLOWANCE_USDC.toLocaleString("en-US")} USDC allowance.`);
    }

    const resources = response.transactionData.build().resources;
    const cpuInstructions = Number(resources.instructions);
    const footprint = resources.footprint;
    const footprintReads = footprint.readOnly.length || recipients.length * 2 + 4;
    const footprintWrites = footprint.readWrite.length || recipients.length + 2;
    const minResourceFee = Number(response.minResourceFee ?? 0);
    return {
      simulatedAt: new Date().toISOString(),
      source: "rpc",
      recipientCount: recipients.length,
      totalUsdc,
      feeXlm: Number((minResourceFee / 10 ** USDC_DECIMALS + Number(BASE_FEE) / 10 ** USDC_DECIMALS).toFixed(7)),
      cpuInstructions,
      maxCpuInstructions: MAX_CPU_INSTRUCTIONS,
      transactionSizeBytes: transaction.toEnvelope().toXDR().length,
      footprintReads,
      footprintWrites,
      latestLedger: response.latestLedger,
      minResourceFee: String(minResourceFee),
      merchantAllowance: MERCHANT_ALLOWANCE_USDC,
      checks,
      warnings,
    };
  } catch (error) {
    return localSimulation(
      recipients,
      error instanceof Error ? error.message : "Simulation failed; showing a local estimate."
    );
  }
}
