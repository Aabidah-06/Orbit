export type DashboardTab =
  | "overview"
  | "plans"
  | "subscribers"
  | "payroll"
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
  status: "active" | "archived";
  createdAt: string;
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
