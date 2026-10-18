export type DashboardTab =
  | "overview"
  | "plans"
  | "subscribers"
  | "payroll"
  | "multisig"
  | "passes"
  | "domains"
  | "links"
  | "team"
  | "developers";

export type NetworkId = "stellar-testnet";

export interface NetworkConfig {
  id: NetworkId;
  name: string;
  badge: string;
  currency: string;
  explorerUrl: string;
  contractStandard: string;
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  "stellar-testnet": {
    id: "stellar-testnet",
    name: "Stellar Testnet",
    badge: "Soroban Rust",
    currency: "USDC",
    explorerUrl: "https://stellar.expert/explorer/testnet",
    contractStandard: "SEP-0041 / Soroban Vault",
  },
};

export interface SubscriptionPlan {
  id: string;
  name: string;
  amount: number;
  currency: string;
  intervalDays: number;
  network: NetworkId;
  activeSubscribers: number;
  status: "active" | "deprecated" | "archived";
  createdAt: string;
  sunsetDate?: string;
  migratedToPlanId?: string;
}

export interface SubscriberRecord {
  id: string;
  walletAddress: string;
  planId: string;
  planName: string;
  amount: number;
  network: NetworkId;
  status: "active" | "pending_pull" | "past_due" | "cancelled";
  nextPullDate: string;
  totalSettled: number;
  joinedDate: string;
  dunningStatus?: string;
  retryCount?: number;
  nextDunningRetryAt?: string;
  recoveryLink?: string;
  lastFailure?: { code: string; message: string; occurred_at?: string; transaction_hash?: string };
}

export interface PaymentTimelineEvent {
  id: string;
  type: "subscription_created" | "settled_pull" | "failed_pull" | "dunning_retry" | "refund" | "cancelled";
  title: string;
  description: string;
  timestamp: string;
  amount?: number;
  status: "success" | "warning" | "failed" | "info";
  txHash?: string;
}

export interface WebhookEndpoint {
  id: string;
  merchant_id: string;
  url: string;
  signing_secret: string;
  events: string[];
  active: boolean;
  created_at: string;
}

export interface WebhookDeliveryLog {
  id: string;
  webhook_id: string;
  merchant_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  request_headers?: Record<string, string>;
  response_status?: number;
  response_body?: string;
  attempt_count: number;
  status: "success" | "failed";
  created_at: string;
  webhooks?: {
    url: string;
  };
}

export interface PayrollRecipient {
  id: string;
  name: string;
  walletAddress: string;
  amount: number;
  role: string;
  network: NetworkId;
  status: "ready" | "disbursed" | "failed";
}

export interface PaymentLink {
  id: string;
  title: string;
  amount: number;
  currency: string;
  type: "recurring" | "one_time";
  intervalDays?: number;
  url: string;
  clicks: number;
  conversions: number;
  network: NetworkId;
  status: "active" | "disabled";
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  fullKeyPreview: string;
  environment: "test" | "live";
  lastUsed: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Multi-sig coordination room (#144)
 * ------------------------------------------------------------------ */

export type MultisigSignatureState = "approved" | "pending" | "rejected";

export type MultisigProposalState =
  | "collecting"
  | "ready"
  | "broadcast"
  | "rejected"
  | "expired";

export type MultisigProposalKind = "payroll" | "plan_update" | "treasury";

export interface MultisigSigner {
  id: string;
  name: string;
  walletAddress: string;
  state: MultisigSignatureState;
  signedAt?: string;
  signedXdr?: string;
}

export interface MultisigProposal {
  id: string;
  title: string;
  description: string;
  kind: MultisigProposalKind;
  amount: number;
  currency: string;
  threshold: number;
  signers: MultisigSigner[];
  state: MultisigProposalState;
  createdAt: string;
  expiresAt: string;
  txHash?: string;
}

/* ------------------------------------------------------------------ *
 * Custom domain & SSL mapping (#145)
 * ------------------------------------------------------------------ */

export type DomainSslState = "active" | "pending_dns" | "issuing" | "error";

export interface VanitySlug {
  id: string;
  slug: string;
  planId: string;
  planName: string;
  createdAt: string;
}

export interface CustomDomain {
  id: string;
  hostname: string;
  cnameTarget: string;
  txtName: string;
  txtValue: string;
  sslState: DomainSslState;
  verificationToken: string;
  vanitySlugs: VanitySlug[];
  createdAt: string;
  verificationChecks: number;
  lastCheckedAt?: string;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Gift links & pre-paid passes (#146)
 * ------------------------------------------------------------------ */

export type GiftClaimState = "unclaimed" | "claimed" | "expired";

export interface GiftPass {
  id: string;
  code: string;
  claimUrl: string;
  planId: string;
  planName: string;
  monthlyAmount: number;
  months: number;
  amount: number;
  state: GiftClaimState;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  claimedBy?: string;
}

/* ------------------------------------------------------------------ *
 * Batch payroll dry-run simulation (#147)
 * ------------------------------------------------------------------ */

export type PayrollCheckState = "pass" | "warning" | "fail";

export interface PayrollRecipientCheck {
  id: string;
  name: string;
  walletAddress: string;
  amount: number;
  trustline: PayrollCheckState;
  allowance: PayrollCheckState;
  message?: string;
}

export interface PayrollSimulationResult {
  simulatedAt: string;
  source: "rpc" | "local";
  recipientCount: number;
  totalUsdc: number;
  feeXlm: number;
  cpuInstructions: number;
  maxCpuInstructions: number;
  transactionSizeBytes: number;
  footprintReads: number;
  footprintWrites: number;
  latestLedger: number;
  minResourceFee: string;
  merchantAllowance: number;
  checks: PayrollRecipientCheck[];
  warnings: string[];
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Plan migration & bulk subscriber tier transfer tool (#183)
 * ------------------------------------------------------------------ */

export type SubscriberMigrationState = "pending" | "notified" | "migrated" | "sunset_expired";

export interface SubscriberMigrationRecord {
  id: string;
  subscriberId: string;
  walletAddress: string;
  email?: string;
  legacyPlanId: string;
  targetPlanId: string;
  legacyAmount: number;
  targetAmount: number;
  effectiveAmount: number;
  discountPercent: number;
  migrationToken: string;
  migrationUrl: string;
  state: SubscriberMigrationState;
  migratedAt?: string;
  txHash?: string;
}

export interface PlanMigrationCampaign {
  id: string;
  legacyPlanId: string;
  legacyPlanName: string;
  legacyAmount: number;
  targetPlanId: string;
  targetPlanName: string;
  targetAmount: number;
  sunsetDate: string;
  discountPercent: number;
  effectiveTargetAmount: number;
  status: "active" | "completed" | "sunset_enforced";
  createdAt: string;
  subscribers: SubscriberMigrationRecord[];
}

