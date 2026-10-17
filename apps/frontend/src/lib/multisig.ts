import { Account, BASE_FEE, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { MultisigProposal, MultisigSigner } from "@/components/dashboard/dashboard-types";
import { hashString } from "@/lib/utils";

export const ORBIT_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";

/**
 * Demo proposals used to bootstrap the coordination room. Real deployments
 * would hydrate these from the `/signing-sessions` API, but the shape is
 * identical: a pending envelope, a signer roster and a required threshold.
 */
export const SEED_PROPOSALS: MultisigProposal[] = [
  {
    id: "ms_payroll_oct",
    title: "October contractor payroll",
    description: "Atomic batch_disburse across 4 contractor wallets (engineering, design, community).",
    kind: "payroll",
    amount: 1200,
    currency: "USDC",
    threshold: 2,
    state: "collecting",
    createdAt: "2026-10-14T09:12:00Z",
    expiresAt: "2026-10-18T09:12:00Z",
    signers: [
      {
        id: "ms_sig_owner",
        name: "Aisha Bello",
        walletAddress: "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
        state: "approved",
        signedAt: "2026-10-14T09:31:00Z",
      },
      {
        id: "ms_sig_finance",
        name: "Marco Reyes",
        walletAddress: "GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A",
        state: "pending",
      },
      {
        id: "ms_sig_ops",
        name: "Priya Nair",
        walletAddress: "GAJ7J66Q66THHJ22WTBBEJUHHLVD7RZZW6KTVQDBBQYXRPVC4UFFQFDR",
        state: "pending",
      },
    ],
  },
  {
    id: "ms_plan_update",
    title: "Raise Pro plan to 39 USDC",
    description: "On-chain plan_catalog update for the MailKit Pro tier.",
    kind: "plan_update",
    amount: 0,
    currency: "USDC",
    threshold: 2,
    state: "collecting",
    createdAt: "2026-10-15T14:02:00Z",
    expiresAt: "2026-10-19T14:02:00Z",
    signers: [
      {
        id: "ms_sig_owner",
        name: "Aisha Bello",
        walletAddress: "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
        state: "approved",
        signedAt: "2026-10-15T14:20:00Z",
      },
      {
        id: "ms_sig_finance",
        name: "Marco Reyes",
        walletAddress: "GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A",
        state: "rejected",
        signedAt: "2026-10-15T15:01:00Z",
      },
      {
        id: "ms_sig_ops",
        name: "Priya Nair",
        walletAddress: "GAJ7J66Q66THHJ22WTBBEJUHHLVD7RZZW6KTVQDBBQYXRPVC4UFFQFDR",
        state: "pending",
      },
    ],
  },
  {
    id: "ms_treasury_sweep",
    title: "Treasury rebalance to yield vault",
    description: "Sweep 8,500 USDC of idle settlement balance into the DAO yield vault.",
    kind: "treasury",
    amount: 8500,
    currency: "USDC",
    threshold: 3,
    state: "collecting",
    createdAt: "2026-10-16T08:45:00Z",
    expiresAt: "2026-10-20T08:45:00Z",
    signers: [
      {
        id: "ms_sig_owner",
        name: "Aisha Bello",
        walletAddress: "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
        state: "approved",
        signedAt: "2026-10-16T09:02:00Z",
      },
      {
        id: "ms_sig_finance",
        name: "Marco Reyes",
        walletAddress: "GBXCR3C3CEKQ3UYNA3UUN2BUBB3GOGWN4VPR2FJ2G2WFQJLFVKJXDJ3A",
        state: "pending",
      },
      {
        id: "ms_sig_ops",
        name: "Priya Nair",
        walletAddress: "GAJ7J66Q66THHJ22WTBBEJUHHLVD7RZZW6KTVQDBBQYXRPVC4UFFQFDR",
        state: "pending",
      },
      {
        id: "ms_sig_audit",
        name: "Tomas Lindqvist",
        walletAddress: "GBDXVD27PJS4PVC5USFBSJUTTYVXIH6MS6MM6M2IDCXJWJHEPRTTIQNP",
        state: "pending",
      },
    ],
  },
];

const AVATAR_PALETTE = [
  "bg-rose-100 text-rose-700 border-rose-200",
  "bg-amber-100 text-amber-800 border-amber-200",
  "bg-emerald-100 text-emerald-700 border-emerald-200",
  "bg-sky-100 text-sky-700 border-sky-200",
  "bg-indigo-100 text-indigo-700 border-indigo-200",
  "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200",
];

export function avatarClass(walletAddress: string): string {
  return AVATAR_PALETTE[hashString(walletAddress) % AVATAR_PALETTE.length];
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function approvedSigners(proposal: MultisigProposal): MultisigSigner[] {
  return proposal.signers.filter((signer) => signer.state === "approved");
}

export function isThresholdMet(proposal: MultisigProposal): boolean {
  return approvedSigners(proposal).length >= proposal.threshold;
}

export function isExpired(proposal: MultisigProposal): boolean {
  return new Date(proposal.expiresAt).getTime() <= Date.now();
}

/** Picks the next co-signer whose approval can be simulated for a live demo. */
export function nextAdvancesSigner(
  proposal: MultisigProposal,
  excludeWallet?: string
): MultisigSigner | undefined {
  return proposal.signers.find(
    (signer) =>
      signer.state === "pending" &&
      (!excludeWallet || signer.walletAddress !== excludeWallet)
  );
}

/**
 * Builds a minimal, network-valid envelope for a proposal so co-signers can
 * produce a real Freighter signature. Production deployments store the actual
 * Soroban envelope returned by the API; when one is present we sign that
 * instead (see `signProposalEnvelope`).
 */
export function buildProposalEnvelope(
  sourceAddress: string,
  proposal: MultisigProposal
): string {
  const account = new Account(sourceAddress, "0");
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: ORBIT_NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.manageData({
        name: `orbit:multisig:${proposal.id}`.slice(0, 64),
        value: `${proposal.kind}:${proposal.threshold}`,
      })
    )
    .addMemo(Memo.text("Orbit multi-sig approval"))
    .setTimeout(300)
    .build()
    .toXDR();
}

export function proposalStateLabel(proposal: MultisigProposal): string {
  if (proposal.state === "broadcast") return "Broadcast on-chain";
  if (proposal.state === "rejected") return "Rejected";
  if (isExpired(proposal) && proposal.state !== "ready") return "Expired";
  if (isThresholdMet(proposal)) return "Ready to broadcast";
  return "Collecting signatures";
}
