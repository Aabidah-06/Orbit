import { signTransaction } from "@stellar/freighter-api";
import { connectFreighter } from "./freighter";
import { ORBIT_API_URL, merchantRequestHeaders, ApiSubscriptionItem } from "./api";

export interface PullFailure { code: string; message: string; occurred_at?: string; transaction_hash?: string }

async function request<T>(path: string, init?: RequestInit): Promise<{ data: T; status: number }> {
  const response = await fetch(`${ORBIT_API_URL}${path}`, { ...init,
    headers: { ...merchantRequestHeaders(), ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The billing request failed.");
  return { data, status: response.status };
}

export async function fetchPullDiagnostics(id: string, signal?: AbortSignal) {
  return (await request<{ failure: PullFailure }>(`/subscriptions/${id}/diagnostics`, { signal })).data.failure;
}

export async function waiveInterval(id: string, idempotencyKey: string) {
  return (await request<{ subscription: ApiSubscriptionItem }>(`/subscriptions/${id}/waive`, {
    method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: "{}",
  })).data.subscription;
}

export async function checkPendingPull(id: string) {
  return (await request<{ status: "SUCCESS" | "FAILED" | "NOT_FOUND"; txHash: string; subscription?: ApiSubscriptionItem }>(
    `/subscriptions/${id}/check-pull`, { method: "POST", body: "{}" })).data;
}

export async function retrySignedPull(id: string, onStatus: (message: string) => void) {
  onStatus("Connecting to Freighter…");
  const wallet = await connectFreighter();
  if (!wallet.ok) throw new Error(wallet.error);
  onStatus("Preparing and simulating the pull…");
  const { data: prepared } = await request<{ transaction_xdr: string; merchant_address: string; network_passphrase: string }>("/trigger-pull", {
    method: "POST", body: JSON.stringify({ subscription_id: id }),
  });
  if (wallet.address !== prepared.merchant_address) throw new Error("Connect the merchant’s registered settlement wallet in Freighter.");
  onStatus("Approve the transaction in Freighter…");
  const signed = await signTransaction(prepared.transaction_xdr, {
    address: prepared.merchant_address, networkPassphrase: prepared.network_passphrase,
  });
  if (!signed.signedTxXdr) throw new Error(signed.error?.message || "The wallet signature was declined.");
  onStatus("Submitting the signed pull and waiting for confirmation…");
  const result = await request<{ txHash: string }>("/submit-pull", {
    method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ subscription_id: id, signed_xdr: signed.signedTxXdr }),
  });
  return { txHash: result.data.txHash, pending: result.status === 202 };
}
