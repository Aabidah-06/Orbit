import {
  SubscriberRecord,
  WebhookEndpoint,
  WebhookDeliveryLog,
  PaymentTimelineEvent,
} from "@/components/dashboard/dashboard-types";
import { fromRawUsdc } from "@/lib/usdc";

export const ORBIT_API_URL =
  process.env.NEXT_PUBLIC_ORBIT_API_URL || "http://localhost:3001";

// Keep the merchant credential in memory; never place a secret in localStorage.
let merchantApiKey = "";
export function setMerchantApiKey(key: string) { merchantApiKey = key.trim(); }
export function merchantRequestHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...(merchantApiKey ? { Authorization: `Bearer ${merchantApiKey}` } : {}) };
}

export interface ApiSubscriptionItem {
  id: string;
  plan_id: string;
  customer_wallet_address: string;
  status: string;
  next_billing_date: string;
  created_at: string;
  retry_count?: number;
  dunning_status?: string;
  next_dunning_retry_at?: string;
  last_failure?: { code: string; message: string; occurred_at?: string; transaction_hash?: string };
  plans?: {
    merchant_id?: string;
    name?: string;
    usdc_amount?: number | string;
    interval_seconds?: number | string;
  };
}

export interface GetSubscribersResponse {
  subscribers: ApiSubscriptionItem[];
}

/**
 * Helper to parse JSON or fallback error message
 */
async function handleResponse<T>(res: Response, fallbackError: string): Promise<T> {
  if (!res.ok) {
    let errorMsg = `${fallbackError} (${res.status} ${res.statusText})`;
    try {
      const errorJson = await res.json();
      if (errorJson && typeof errorJson.error === "string") {
        errorMsg = errorJson.error;
      }
    } catch {
      // Fallback
    }
    throw new Error(errorMsg);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetches subscribers for a specific merchant from the Merchant API.
 */
export async function fetchSubscribers(
  merchantId: string,
  signal?: AbortSignal
): Promise<ApiSubscriptionItem[]> {
  const url = new URL("/subscribers", ORBIT_API_URL);
  // The API key determines the merchant; dashboard session IDs are local profiles.
  void merchantId;

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: merchantRequestHeaders(),
    signal,
  });

  const data = await handleResponse<GetSubscribersResponse>(res, "Failed to fetch subscribers");
  return data.subscribers || [];
}

/**
 * Maps an API subscription record to the frontend's SubscriberRecord.
 */
export function mapApiSubscriberToRecord(
  item: ApiSubscriptionItem
): SubscriberRecord {
  const now = new Date();
  const nextBilling = new Date(item.next_billing_date);
  const isValidNextBilling = !isNaN(nextBilling.getTime());
  const isDue = isValidNextBilling && nextBilling.getTime() <= now.getTime();

  let status: "active" | "pending_pull" | "past_due" | "cancelled" = "active";
  if (item.status === "cancelled") {
    status = "cancelled";
  } else if (item.status === "past_due") {
    status = "past_due";
  } else if (isDue || item.status === "pending_pull") {
    status = "pending_pull";
  }

  let nextPullDate = "Active";
  if (item.status === "cancelled") {
    nextPullDate = "Cancelled";
  } else if (item.status === "past_due") {
    if (item.next_dunning_retry_at) {
      const retryDate = new Date(item.next_dunning_retry_at);
      const diffMs = retryDate.getTime() - now.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      nextPullDate = diffDays <= 0 ? "Retry Due Now" : `Retry in ${diffDays}d`;
    } else {
      nextPullDate = "Past Due";
    }
  } else if (isDue) {
    nextPullDate = "Due Now";
  } else if (isValidNextBilling) {
    const diffMs = nextBilling.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    nextPullDate =
      diffDays > 0 ? `In ${diffDays} ${diffDays === 1 ? "day" : "days"}` : "Due Now";
  }

  const createdDate = new Date(item.created_at);
  const joinedDate = !isNaN(createdDate.getTime())
    ? createdDate.toLocaleDateString("en-US", {
        month: "short",
        day: "2-digit",
        year: "numeric",
      })
    : "Recent";

  const amount = fromRawUsdc(item.plans?.usdc_amount);

  return {
    id: item.id,
    walletAddress: item.customer_wallet_address,
    planId: item.plan_id,
    planName: item.plans?.name || "Subscription Plan",
    amount,
    network: "stellar-testnet",
    status,
    nextPullDate,
    totalSettled: amount,
    joinedDate,
    dunningStatus: item.dunning_status,
    retryCount: item.retry_count,
    nextDunningRetryAt: item.next_dunning_retry_at,
    lastFailure: item.last_failure,
  };
}

/**
 * Fetches the chronological payment and audit timeline for a subscription.
 */
export async function fetchSubscriptionTimeline(
  subscriptionId: string
): Promise<{ timeline: PaymentTimelineEvent[]; subscription: ApiSubscriptionItem }> {
  const url = new URL(`/subscriptions/${subscriptionId}/timeline`, ORBIT_API_URL);
  const res = await fetch(url.toString(), {
    headers: { "Content-Type": "application/json" },
  });
  return handleResponse(res, "Failed to fetch subscription timeline");
}

/**
 * Cancels a subscription and revokes on-chain pull rights.
 */
export async function cancelSubscription(
  subscriptionId: string,
  reason?: string
): Promise<{ message: string; subscription: ApiSubscriptionItem }> {
  const url = new URL(`/subscriptions/${subscriptionId}/cancel`, ORBIT_API_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  return handleResponse(res, "Failed to cancel subscription");
}

/**
 * Issues a prorated or custom refund to a subscriber.
 */
export async function refundSubscription(
  subscriptionId: string,
  amount?: number,
  reason?: string
): Promise<{ message: string; refund: Record<string, unknown> }> {
  const url = new URL(`/subscriptions/${subscriptionId}/refund`, ORBIT_API_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount, reason, prorated: amount === undefined }),
  });
  return handleResponse(res, "Failed to process refund");
}

/**
 * Generates an instant customer self-service recovery link for past-due vaults.
 */
export async function generateRecoveryLink(
  subscriptionId: string
): Promise<{ recovery_url: string; recovery_token: string; expires_at: string }> {
  const url = new URL(`/subscriptions/${subscriptionId}/recovery-link`, ORBIT_API_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: merchantRequestHeaders(),
  });
  return handleResponse(res, "Failed to generate recovery link");
}

/**
 * Webhook Management
 */
export async function fetchWebhooks(
  merchantId: string
): Promise<WebhookEndpoint[]> {
  const url = new URL("/webhooks", ORBIT_API_URL);
  url.searchParams.set("merchant_id", merchantId);
  const res = await fetch(url.toString(), {
    headers: { "Content-Type": "application/json" },
  });
  const data = await handleResponse<{ webhooks: WebhookEndpoint[] }>(res, "Failed to fetch webhooks");
  return data.webhooks || [];
}

export async function createWebhook(data: {
  merchant_id: string;
  url: string;
  events?: string[];
  signing_secret?: string;
}): Promise<WebhookEndpoint> {
  const url = new URL("/webhooks", ORBIT_API_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await handleResponse<{ webhook: WebhookEndpoint }>(res, "Failed to create webhook");
  return result.webhook;
}

export async function updateWebhook(
  id: string,
  data: {
    url?: string;
    events?: string[];
    active?: boolean;
    signing_secret?: string;
  }
): Promise<WebhookEndpoint> {
  const url = new URL(`/webhooks/${id}`, ORBIT_API_URL);
  const res = await fetch(url.toString(), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await handleResponse<{ webhook: WebhookEndpoint }>(res, "Failed to update webhook");
  return result.webhook;
}

export async function deleteWebhook(id: string): Promise<void> {
  const url = new URL(`/webhooks/${id}`, ORBIT_API_URL);
  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
  await handleResponse(res, "Failed to delete webhook");
}

export async function fetchWebhookDeliveries(
  merchantId: string,
  webhookId?: string,
  limit = 50
): Promise<{ deliveries: WebhookDeliveryLog[]; total: number }> {
  const url = new URL("/webhooks/deliveries", ORBIT_API_URL);
  url.searchParams.set("merchant_id", merchantId);
  if (webhookId) url.searchParams.set("webhook_id", webhookId);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    headers: { "Content-Type": "application/json" },
  });
  return handleResponse(res, "Failed to fetch webhook deliveries");
}

export async function resendWebhookDelivery(
  deliveryId: string
): Promise<{ message: string; delivery: WebhookDeliveryLog }> {
  const url = new URL(`/webhooks/deliveries/${deliveryId}/resend`, ORBIT_API_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  return handleResponse(res, "Failed to resend webhook delivery");
}

export async function sendTestWebhook(data: {
  merchant_id: string;
  webhook_id?: string;
  event_type?: string;
}): Promise<{ message: string; event: string }> {
  const url = new URL("/webhooks/test", ORBIT_API_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return handleResponse(res, "Failed to trigger test webhook");
}
