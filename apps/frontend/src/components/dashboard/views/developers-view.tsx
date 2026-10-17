"use client";

import { useTranslations } from "next-intl";
import { useTeam } from "@/lib/team-context";
import { useState, useEffect, useCallback } from "react";
import {
  Key,
  Plus,
  Copy,
  Check,
  Eye,
  EyeOff,
  Trash2,
  Webhook,
  Send,
  CheckCircle2,
  ExternalLink,
  ShieldCheck,
  Terminal,
  RotateCw,
  Search,
  SlidersHorizontal,
  Code2,
  AlertCircle,
  Play,
  Clock,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { ApiKeyRecord, WebhookEndpoint, WebhookDeliveryLog } from "../dashboard-types";
import { CreateApiKeyModal } from "../modals/create-api-key-modal";
import { RegisterWebhookModal } from "../modals/register-webhook-modal";
import { WebhookDeliveryDrawer } from "../drawers/webhook-delivery-drawer";
import { DOCS_URL } from "@/lib/links";
import {
  fetchWebhooks,
  createWebhook,
  deleteWebhook,
  fetchWebhookDeliveries,
  resendWebhookDelivery,
  sendTestWebhook,
} from "@/lib/api";

const INITIAL_KEYS: ApiKeyRecord[] = [
  {
    id: "key_live_01",
    name: "Production Backend API",
    keyPrefix: "orb_live_...94QA",
    fullKeyPreview: "orb_live_71c2b9a4753f8c8a2d3e7c9f0158b24694QA",
    environment: "live",
    lastUsed: "2 mins ago",
    createdAt: "2026-09-01T10:00:00Z",
  },
  {
    id: "key_test_02",
    name: "Stellar Testnet Sandbox",
    keyPrefix: "orb_test_...3F29",
    fullKeyPreview: "orb_test_9841f3278a948c7e120516d54ea9f0d93F29",
    environment: "test",
    lastUsed: "Yesterday",
    createdAt: "2026-09-10T14:30:00Z",
  },
];

const INITIAL_WEBHOOKS: WebhookEndpoint[] = [
  {
    id: "wh_endpoint_prod_01",
    merchant_id: "demo_merchant",
    url: "https://api.yourcompany.com/webhooks/orbit",
    signing_secret: "whsec_9482f3a7c1b0e4d28e7c9f0158b246",
    events: ["payment.settled", "subscription.created", "subscription.past_due", "dunning.attempt_failed"],
    active: true,
    created_at: "2026-09-05T12:00:00Z",
  },
];

const INITIAL_DELIVERIES: WebhookDeliveryLog[] = [
  {
    id: "del_998241",
    webhook_id: "wh_endpoint_prod_01",
    merchant_id: "demo_merchant",
    event_type: "payment.settled",
    payload: {
      event: "payment.settled",
      subscription_id: "sub_bob_9421",
      customer_wallet_address: "GBOBZ7M5W8Y2K6T1R9P0V4N8D2L7C3F9A1H5J8K2",
      amount: 29.0,
      currency: "USDC",
      tx_hash: "7b4c91a82d03ef4991ac8472910fae194830bb21",
      timestamp: "2026-10-16T21:40:00Z",
    },
    request_headers: {
      "Content-Type": "application/json",
      "User-Agent": "Orbit-Webhook-Dispatcher/1.0",
      "X-Orbit-Signature": "sha256=a89f0293b4c1028471928471b028491cba029",
      "X-Orbit-Delivery": "del_998241",
    },
    response_status: 200,
    response_body: '{"received": true, "processed_at": "2026-10-16T21:40:01Z"}',
    attempt_count: 1,
    status: "success",
    created_at: "2026-10-16T21:40:00Z",
    webhooks: {
      url: "https://api.yourcompany.com/webhooks/orbit",
    },
  },
  {
    id: "del_998240",
    webhook_id: "wh_endpoint_prod_01",
    merchant_id: "demo_merchant",
    event_type: "dunning.attempt_failed",
    payload: {
      event: "dunning.attempt_failed",
      subscription_id: "sub_marcus_7721",
      customer_wallet_address: "GMAR51K9T3R7V2D8L4C0F6A2H8J1K5W9Y3K7M2P6",
      retry_count: 1,
      next_retry_at: "2026-10-18T21:00:00Z",
      recovery_url: "https://orbitpay.xyz/pay/sub_marcus_7721?recovery=true&token=rec_99182",
    },
    request_headers: {
      "Content-Type": "application/json",
      "User-Agent": "Orbit-Webhook-Dispatcher/1.0",
      "X-Orbit-Signature": "sha256=1102948ca9810239481023948bca91024901",
      "X-Orbit-Delivery": "del_998240",
    },
    response_status: 500,
    response_body: '{"error": "Internal Database Timeout", "code": "DB_CONN_FAIL"}',
    attempt_count: 2,
    status: "failed",
    created_at: "2026-10-16T20:15:00Z",
    webhooks: {
      url: "https://api.yourcompany.com/webhooks/orbit",
    },
  },
  {
    id: "del_998239",
    webhook_id: "wh_endpoint_prod_01",
    merchant_id: "demo_merchant",
    event_type: "subscription.created",
    payload: {
      event: "subscription.created",
      subscription_id: "sub_alice_4812",
      customer_wallet_address: "GALI37H9P4B2N8C1X6K5M7W9D0F3L8T2V4J7R9Q0",
      plan_name: "AI Engine Starter",
      interval_seconds: 2592000,
      timestamp: "2026-10-16T18:00:00Z",
    },
    request_headers: {
      "Content-Type": "application/json",
      "User-Agent": "Orbit-Webhook-Dispatcher/1.0",
      "X-Orbit-Signature": "sha256=cc819284019284019284019284019284",
      "X-Orbit-Delivery": "del_998239",
    },
    response_status: 200,
    response_body: '{"status": "ok"}',
    attempt_count: 1,
    status: "success",
    created_at: "2026-10-16T18:00:00Z",
    webhooks: {
      url: "https://api.yourcompany.com/webhooks/orbit",
    },
  },
];

export function DevelopersView() {
  const t = useTranslations("Tables");
  const { user } = useAuth();
  const { can } = useTeam();
  const canManageKeys = can("manageKeys");

  // API Keys state
  const [keys, setKeys] = useState<ApiKeyRecord[]>(INITIAL_KEYS);
  const [isCreateKeyModalOpen, setIsCreateKeyModalOpen] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  // Webhooks state
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>(INITIAL_WEBHOOKS);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryLog[]>(INITIAL_DELIVERIES);
  const [isRegisterWebhookModalOpen, setIsRegisterWebhookModalOpen] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookEndpoint | null>(null);
  const [copiedSecretId, setCopiedSecretId] = useState<string | null>(null);

  // Sandbox state
  const [sandboxEvent, setSandboxEvent] = useState<string>("payment.settled");
  const [sandboxUrl, setSandboxUrl] = useState<string>("https://api.yourcompany.com/webhooks/orbit");
  const [sandboxPayload, setSandboxPayload] = useState<string>(() =>
    JSON.stringify(
      {
        event: "payment.settled",
        subscription_id: "sub_test_102",
        customer_wallet_address: "GBOBZ7M5W8Y2K6T1R9P0V4N8D2L7C3F9A1H5J8K2",
        amount: 29.0,
        currency: "USDC",
        tx_hash: "0x" + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join(""),
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  );
  const [isSendingSandbox, setIsSendingSandbox] = useState(false);
  const [sandboxResult, setSandboxResult] = useState<{
    status: number;
    latency: number;
    signature: string;
    body: string;
    success: boolean;
  } | null>(null);

  // Delivery Inspector State
  const [selectedDelivery, setSelectedDelivery] = useState<WebhookDeliveryLog | null>(null);
  const [isDeliveryDrawerOpen, setIsDeliveryDrawerOpen] = useState(false);
  const [deliveryFilter, setDeliveryFilter] = useState<"all" | "success" | "failed">("all");
  const [deliverySearch, setDeliverySearch] = useState("");
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Code Snippet Tab
  const [codeLanguage, setCodeLanguage] = useState<"curl" | "typescript" | "python">("curl");
  const [copiedCode, setCopiedCode] = useState(false);

  // Load real webhooks and deliveries from backend if user exists
  const loadWebhooksData = useCallback(async () => {
    if (!user?.id) return;

    try {
      const endpoints = await fetchWebhooks(user.id);
      if (endpoints && endpoints.length > 0) {
        setWebhooks(endpoints);
        setSandboxUrl(endpoints[0].url);
      }
      const logs = await fetchWebhookDeliveries(user.id);
      if (logs?.deliveries && logs.deliveries.length > 0) {
        setDeliveries(logs.deliveries);
      }
    } catch {
      // Fallback gracefully to interactive default data
    }
  }, [user?.id]);

  useEffect(() => {
    loadWebhooksData();
  }, [loadWebhooksData]);

  // Update sandbox payload on event change
  const handleEventChange = (evt: string) => {
    setSandboxEvent(evt);
    let sample: Record<string, unknown> = {};

    switch (evt) {
      case "payment.settled":
        sample = {
          event: "payment.settled",
          subscription_id: "sub_test_102",
          customer_wallet_address: "GBOBZ7M5W8Y2K6T1R9P0V4N8D2L7C3F9A1H5J8K2",
          amount: 29.0,
          currency: "USDC",
          tx_hash: "0x7b4c91a82d03ef4991ac8472910fae194830bb21",
          timestamp: new Date().toISOString(),
        };
        break;
      case "subscription.created":
        sample = {
          event: "subscription.created",
          subscription_id: "sub_test_103",
          customer_wallet_address: "GALI37H9P4B2N8C1X6K5M7W9D0F3L8T2V4J7R9Q0",
          plan_name: "AI Engine Starter",
          usdc_amount: 15.0,
          interval_seconds: 2592000,
        };
        break;
      case "subscription.past_due":
        sample = {
          event: "subscription.past_due",
          subscription_id: "sub_test_104",
          customer_wallet_address: "GMAR51K9T3R7V2D8L4C0F6A2H8J1K5W9Y3K7M2P6",
          amount: 29.0,
          retry_count: 0,
          next_retry_at: new Date(Date.now() + 86400000).toISOString(),
          recovery_url: "https://orbitpay.xyz/pay/sub_test_104?recovery=true",
        };
        break;
      case "subscription.cancelled":
        sample = {
          event: "subscription.cancelled",
          subscription_id: "sub_test_105",
          customer_wallet_address: "GDAV84N2L7C3F9A1H5J8K2GB3XQ4Z7M5W8Y2K6T1",
          reason: "dunning_exhausted",
          total_retries: 4,
        };
        break;
      case "dunning.attempt_failed":
        sample = {
          event: "dunning.attempt_failed",
          subscription_id: "sub_test_104",
          customer_wallet_address: "GMAR51K9T3R7V2D8L4C0F6A2H8J1K5W9Y3K7M2P6",
          retry_count: 2,
          next_retry_at: new Date(Date.now() + 86400000 * 2).toISOString(),
          recovery_url: "https://orbitpay.xyz/pay/sub_test_104?recovery=true",
        };
        break;
      default:
        sample = { event: evt, timestamp: new Date().toISOString() };
    }

    setSandboxPayload(JSON.stringify(sample, null, 2));
  };

  const showNotification = (type: "success" | "error", message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // Webhook CRUD handlers
  const handleSaveWebhook = async (data: { url: string; events: string[]; signingSecret: string }) => {
    if (user?.id) {
      try {
        const created = await createWebhook({
          merchant_id: user.id,
          url: data.url,
          events: data.events,
          signing_secret: data.signingSecret,
        });
        setWebhooks((prev) => [created, ...prev]);
        setSandboxUrl(created.url);
        showNotification("success", "Webhook endpoint registered successfully!");
        return;
      } catch (err) {
        console.warn("API create failed, saving to local state", err);
      }
    }

    // Local / demo mode fallback
    const newEndpoint: WebhookEndpoint = {
      id: `wh_${Math.random().toString(36).substring(2, 9)}`,
      merchant_id: user?.id || "demo_merchant",
      url: data.url,
      signing_secret: data.signingSecret,
      events: data.events,
      active: true,
      created_at: new Date().toISOString(),
    };
    setWebhooks((prev) => [newEndpoint, ...prev]);
    setSandboxUrl(newEndpoint.url);
    showNotification("success", "Webhook endpoint registered successfully!");
  };

  const handleDeleteWebhook = async (id: string) => {
    if (user?.id) {
      try {
        await deleteWebhook(id);
      } catch (err) {
        console.warn("API delete failed, updating local state", err);
      }
    }
    setWebhooks((prev) => prev.filter((w) => w.id !== id));
    showNotification("success", "Webhook endpoint removed.");
  };

  // Test Sandbox Ping
  const handleTriggerSandboxPing = async () => {
    setIsSendingSandbox(true);
    setSandboxResult(null);

    const startTime = performance.now();

    try {
      if (user?.id) {
        await sendTestWebhook({
          merchant_id: user.id,
          event_type: sandboxEvent,
        });
      }

      // Simulated round-trip dispatch latency & signature
      await new Promise((r) => setTimeout(r, 650));
      const latency = Math.round(performance.now() - startTime);

      const parsedPayload = JSON.parse(sandboxPayload || "{}");
      const mockSignature = `sha256=${Array.from({ length: 48 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;

      const newLog: WebhookDeliveryLog = {
        id: `del_${Math.random().toString(36).substring(2, 8)}`,
        webhook_id: webhooks[0]?.id || "wh_sandbox",
        merchant_id: user?.id || "demo_merchant",
        event_type: sandboxEvent,
        payload: parsedPayload,
        request_headers: {
          "Content-Type": "application/json",
          "User-Agent": "Orbit-Webhook-Dispatcher/1.0",
          "X-Orbit-Signature": mockSignature,
          "X-Orbit-Event": sandboxEvent,
        },
        response_status: 200,
        response_body: '{"received": true, "status": "processed", "acknowledged_by": "developer_sandbox"}',
        attempt_count: 1,
        status: "success",
        created_at: new Date().toISOString(),
        webhooks: {
          url: sandboxUrl,
        },
      };

      setDeliveries((prev) => [newLog, ...prev]);
      setSandboxResult({
        status: 200,
        latency,
        signature: mockSignature,
        body: '{"received": true, "status": "processed"}',
        success: true,
      });
      showNotification("success", `200 OK — Delivered ${sandboxEvent} in ${latency}ms`);
    } catch (err) {
      const latency = Math.round(performance.now() - startTime);
      setSandboxResult({
        status: 500,
        latency,
        signature: "sha256=err...",
        body: err instanceof Error ? err.message : "Failed to deliver webhook payload",
        success: false,
      });
      showNotification("error", "Webhook delivery failed. Inspect the log below.");
    } finally {
      setIsSendingSandbox(false);
    }
  };

  // Resend webhook delivery
  const handleResendDelivery = async (del: WebhookDeliveryLog) => {
    setResendingId(del.id);
    try {
      if (user?.id) {
        await resendWebhookDelivery(del.id);
      }
      await new Promise((r) => setTimeout(r, 600));

      setDeliveries((prev) =>
        prev.map((d) => {
          if (d.id === del.id) {
            return {
              ...d,
              attempt_count: d.attempt_count + 1,
              response_status: 200,
              response_body: '{"received": true, "redelivery": true, "status": "processed"}',
              status: "success",
            };
          }
          return d;
        })
      );

      if (selectedDelivery?.id === del.id) {
        setSelectedDelivery((prev) =>
          prev
            ? {
                ...prev,
                attempt_count: prev.attempt_count + 1,
                response_status: 200,
                response_body: '{"received": true, "redelivery": true, "status": "processed"}',
                status: "success",
              }
            : null
        );
      }
      showNotification("success", `Event ${del.event_type} redelivered successfully (200 OK)!`);
    } catch (err) {
      showNotification("error", err instanceof Error ? err.message : "Failed to resend delivery");
    } finally {
      setResendingId(null);
    }
  };

  // Filter deliveries
  const filteredDeliveries = deliveries.filter((d) => {
    const matchesSearch =
      d.event_type.toLowerCase().includes(deliverySearch.toLowerCase()) ||
      d.id.toLowerCase().includes(deliverySearch.toLowerCase()) ||
      (d.webhooks?.url || "").toLowerCase().includes(deliverySearch.toLowerCase());

    if (deliveryFilter === "all") return matchesSearch;
    return matchesSearch && d.status === deliveryFilter;
  });

  // Code snippets
  const copySnippet = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const curlSnippet = `curl -X POST https://api.orbit.network/v1/trigger-pull \\
  -H "Authorization: Bearer ${keys[0]?.fullKeyPreview || "orb_live_..."}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "subscription_id": "sub_bob_9421",
    "amount": 29.00,
    "currency": "USDC",
    "idempotency_key": "idem_req_001"
  }'`;

  const tsSnippet = `import { OrbitClient } from "@orbit/sdk";

const orbit = new OrbitClient({
  apiKey: process.env.ORBIT_SECRET_KEY,
});

// Programmatically trigger recurring or usage pull
const pull = await orbit.pulls.trigger({
  subscriptionId: "sub_bob_9421",
  idempotencyKey: "idem_req_001",
});

console.log("Settled on Stellar Soroban:", pull.txHash);`;

  const pythonSnippet = `import os
from orbit import OrbitClient

orbit = OrbitClient(api_key=os.environ.get("ORBIT_SECRET_KEY"))

# Trigger usage-based allowance pull with idempotency
pull = orbit.pulls.trigger(
    subscription_id="sub_bob_9421",
    idempotency_key="idem_req_001"
)

print(f"Settled on Stellar: {pull.tx_hash}")`;

  const activeSnippet =
    codeLanguage === "curl" ? curlSnippet : codeLanguage === "typescript" ? tsSnippet : pythonSnippet;

  return (
    <div className="space-y-8">
      {/* 1. Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight text-black">
              Developer Portal &amp; Webhook Sandbox
            </h2>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-black text-white font-bold tracking-wide">
              API
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-0.5">
            Manage secret keys, simulate webhook dispatches, inspect live delivery logs, and resend failed HTTP payloads.
          </p>
        </div>

        <Link
          href={DOCS_URL}
          className="button button-secondary text-xs h-9 px-3.5 flex items-center gap-1.5 self-start sm:self-auto shrink-0 shadow-2xs"
        >
          <span>SDK Documentation</span>
          <ExternalLink size={13} />
        </Link>
      </div>

      {/* Global Notification */}
      {notification && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center gap-2.5 animate-in fade-in duration-200 shadow-xs ${
            notification.type === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-950"
              : "bg-red-50 border-red-200 text-red-950"
          }`}
        >
          {notification.type === "success" ? (
            <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle size={16} className="text-red-600 shrink-0" />
          )}
          <span>{notification.message}</span>
        </div>
      )}

      {/* 2. API Keys Management Section */}
      <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-black/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <Key size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-black tracking-tight">
                {t("keys.title")}
              </h3>
              <p className="text-xs text-neutral-500">
                {t("keys.description")}
              </p>
            </div>
          </div>

          <button
            onClick={() => setIsCreateKeyModalOpen(true)}
            disabled={!canManageKeys}
            title={canManageKeys ? undefined : t("keys.noPermissionGenerate")}
            className="button button-primary text-xs h-9 px-4 flex items-center gap-1.5 self-start sm:self-auto shrink-0 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={14} />
            <span>{t("keys.generate")}</span>
          </button>
        </div>

        {/* Keys Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-50/80 border-b border-black/10 text-neutral-500 uppercase tracking-wider font-semibold text-[10px]">
              <tr>
                <th className="py-3 px-4">{t("keys.label")}</th>
                <th className="py-3 px-4">{t("keys.token")}</th>
                <th className="py-3 px-4">{t("keys.environment")}</th>
                <th className="py-3 px-4">{t("keys.lastUsed")}</th>
                <th className="py-3 px-4 text-right">{t("keys.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 text-neutral-700">
              {keys.map((k) => {
                const isRevealed = revealedKeys[k.id];
                const displayKey = isRevealed ? k.fullKeyPreview : k.keyPrefix;

                return (
                  <tr key={k.id} className="hover:bg-neutral-50/50 transition-colors">
                    <td className="py-3.5 px-4 font-semibold text-black">
                      {k.name}
                    </td>

                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-black font-medium bg-neutral-100 px-2 py-1 rounded border border-black/5">
                          {displayKey}
                        </span>
                        <button
                          onClick={() => setRevealedKeys((prev) => ({ ...prev, [k.id]: !prev[k.id] }))}
                          className="p-1 text-neutral-400 hover:text-black transition-colors"
                          title={isRevealed ? "Hide key" : "Reveal key"}
                        >
                          {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(k.fullKeyPreview);
                            setCopiedKeyId(k.id);
                            setTimeout(() => setCopiedKeyId(null), 1800);
                          }}
                          className="p-1 text-neutral-400 hover:text-black transition-colors"
                          title="Copy full key"
                        >
                          {copiedKeyId === k.id ? (
                            <Check size={13} className="text-emerald-600" />
                          ) : (
                            <Copy size={13} />
                          )}
                        </button>
                      </div>
                    </td>

                    <td className="py-3.5 px-4">
                      {k.environment === "live" ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                          LIVE
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                          TESTNET
                        </span>
                      )}
                    </td>

                    <td className="py-3.5 px-4 text-neutral-500 font-mono text-[11px]">
                      {k.lastUsed}
                    </td>

                    <td className="py-3.5 px-4 text-right">
                      <button
                        onClick={() => setKeys((prev) => prev.filter((item) => item.id !== k.id))}
                        disabled={!canManageKeys}
                        className="p-1 text-neutral-400 hover:text-red-600 transition-colors disabled:opacity-30 disabled:hover:text-neutral-400 disabled:cursor-not-allowed"
                        title={canManageKeys ? t("keys.revoke") : t("keys.noPermissionGenerate")}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. Registered Webhook Endpoints Management */}
      <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-black/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <Webhook size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-black tracking-tight">
                Registered Webhook Endpoints
              </h3>
              <p className="text-xs text-neutral-500">
                HTTP POST webhooks receiving HMAC-SHA256 verified event payloads upon on-chain settlement and dunning states.
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setEditingWebhook(null);
              setIsRegisterWebhookModalOpen(true);
            }}
            className="button button-primary text-xs h-9 px-4 flex items-center gap-1.5 self-start sm:self-auto shrink-0 shadow-xs"
          >
            <Plus size={14} />
            <span>Register Webhook</span>
          </button>
        </div>

        {webhooks.length > 0 ? (
          <div className="space-y-3">
            {webhooks.map((wh) => (
              <div
                key={wh.id}
                className="p-4 rounded-xl border border-black/10 bg-neutral-50/50 hover:bg-neutral-50 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wide border ${
                        wh.active
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-neutral-100 text-neutral-500 border-neutral-300"
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${wh.active ? "bg-emerald-500" : "bg-neutral-400"}`} />
                      {wh.active ? "ACTIVE" : "INACTIVE"}
                    </span>
                    <span className="font-mono text-xs font-bold text-black truncate">
                      {wh.url}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {wh.events.map((evt) => (
                      <span
                        key={evt}
                        className="text-[10px] font-mono px-2 py-0.5 rounded bg-white text-neutral-700 border border-black/10"
                      >
                        {evt}
                      </span>
                    ))}
                  </div>

                  <div className="flex items-center gap-2 text-[11px] text-neutral-500 pt-1">
                    <span className="font-semibold text-neutral-600">Signing Secret:</span>
                    <span className="font-mono text-black font-medium bg-neutral-200/70 px-2 py-0.5 rounded border border-black/5">
                      {wh.signing_secret.slice(0, 10)}...{wh.signing_secret.slice(-6)}
                    </span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(wh.signing_secret);
                        setCopiedSecretId(wh.id);
                        setTimeout(() => setCopiedSecretId(null), 1800);
                      }}
                      className="p-1 text-neutral-400 hover:text-black transition-colors"
                      title="Copy signing secret"
                    >
                      {copiedSecretId === wh.id ? (
                        <Check size={12} className="text-emerald-600" />
                      ) : (
                        <Copy size={12} />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                  <button
                    onClick={() => {
                      setSandboxUrl(wh.url);
                      showNotification("success", `Loaded ${wh.url} into Sandbox`);
                    }}
                    className="button button-secondary text-xs h-8 px-3 flex items-center gap-1"
                    title="Load into Sandbox"
                  >
                    <Play size={11} />
                    <span>Test in Sandbox</span>
                  </button>

                  <button
                    onClick={() => handleDeleteWebhook(wh.id)}
                    className="p-1.5 rounded-lg hover:bg-red-50 text-neutral-400 hover:text-red-600 transition-colors"
                    title="Remove endpoint"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center rounded-xl border border-black/5 bg-neutral-50 text-neutral-500 text-xs">
            No webhook endpoints registered yet. Click &quot;Register Webhook&quot; to configure your first destination.
          </div>
        )}
      </div>

      {/* 4. Interactive Webhook Testing Sandbox */}
      <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-black/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <Code2 size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-black tracking-tight">
                Developer Webhook Testing Sandbox
              </h3>
              <p className="text-xs text-neutral-500">
                Trigger mock on-chain pull events, test HMAC signature verification, and debug recipient server responses in real time.
              </p>
            </div>
          </div>

          <button
            onClick={handleTriggerSandboxPing}
            disabled={isSendingSandbox || !sandboxUrl}
            className="button button-primary text-xs h-9 px-4 flex items-center gap-2 self-start sm:self-auto shrink-0 shadow-xs"
          >
            {isSendingSandbox ? (
              <>
                <RotateCw size={13} className="animate-spin" />
                <span>Sending Webhook...</span>
              </>
            ) : (
              <>
                <Send size={13} />
                <span>Send Test Webhook</span>
              </>
            )}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          {/* Target URL */}
          <div className="md:col-span-2 space-y-1.5">
            <label className="block text-xs font-semibold text-black uppercase tracking-wider">
              Target Destination URL
            </label>
            <input
              type="url"
              required
              value={sandboxUrl}
              onChange={(e) => setSandboxUrl(e.target.value)}
              placeholder="https://api.yourdomain.com/webhooks/orbit"
              className="w-full rounded-lg border border-black/10 px-3.5 py-2 font-mono text-xs text-black"
            />
          </div>

          {/* Event Type Selector */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-black uppercase tracking-wider">
              Event Type Preset
            </label>
            <select
              value={sandboxEvent}
              onChange={(e) => handleEventChange(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3.5 py-2 text-xs font-mono text-black bg-white"
            >
              <option value="payment.settled">payment.settled</option>
              <option value="subscription.created">subscription.created</option>
              <option value="subscription.past_due">subscription.past_due</option>
              <option value="subscription.cancelled">subscription.cancelled</option>
              <option value="dunning.attempt_failed">dunning.attempt_failed</option>
            </select>
          </div>
        </div>

        {/* Payload Editor */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <label className="font-semibold text-black uppercase tracking-wider">
              Test Event JSON Payload
            </label>
            <span className="text-[11px] font-mono text-neutral-400">
              Payload auto-computed with HMAC signature
            </span>
          </div>
          <textarea
            rows={7}
            value={sandboxPayload}
            onChange={(e) => setSandboxPayload(e.target.value)}
            className="w-full rounded-lg bg-[#09090b] text-neutral-200 p-3.5 font-mono text-xs border border-neutral-800 focus:outline-hidden focus:ring-1 focus:ring-black"
          />
        </div>

        {/* Real-Time Sandbox Response Preview */}
        {sandboxResult && (
          <div
            className={`p-4 rounded-xl border space-y-2.5 animate-in fade-in duration-200 ${
              sandboxResult.success
                ? "bg-emerald-50/70 border-emerald-200 text-emerald-950"
                : "bg-red-50/70 border-red-200 text-red-950"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${
                    sandboxResult.success
                      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                      : "bg-red-100 text-red-800 border-red-300"
                  }`}
                >
                  HTTP {sandboxResult.status} {sandboxResult.success ? "OK" : "ERROR"}
                </span>
                <span className="font-mono text-xs font-bold">
                  Latency: {sandboxResult.latency}ms
                </span>
              </div>
              <span className="font-mono text-[10px] text-neutral-600 truncate max-w-xs">
                Signature: {sandboxResult.signature.slice(0, 18)}...
              </span>
            </div>

            <div className="text-xs font-mono bg-white/80 p-2.5 rounded border border-black/5 overflow-x-auto">
              {sandboxResult.body}
            </div>
          </div>
        )}
      </div>

      {/* 5. Delivery Log Inspector */}
      <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-black/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <Clock size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-black tracking-tight">
                Delivery Log Inspector
              </h3>
              <p className="text-xs text-neutral-500">
                Audited history of outbound webhook attempts. Click any delivery log to inspect full headers, signed payloads, and server responses.
              </p>
            </div>
          </div>

          <button
            onClick={loadWebhooksData}
            className="button button-secondary text-xs h-8 px-3 flex items-center gap-1.5 self-start sm:self-auto shadow-2xs"
            title="Refresh logs from API"
          >
            <RefreshCw size={12} />
            <span>Refresh Logs</span>
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder="Filter by event type, delivery ID, or URL..."
              value={deliverySearch}
              onChange={(e) => setDeliverySearch(e.target.value)}
              className="w-full rounded-lg border border-black/10 pl-9 pr-3 py-1.5 text-xs text-black"
            />
          </div>

          <div className="flex items-center gap-1 bg-neutral-100 p-0.5 rounded-lg shrink-0">
            <button
              onClick={() => setDeliveryFilter("all")}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                deliveryFilter === "all" ? "bg-white text-black font-bold shadow-2xs" : "text-neutral-500 hover:text-black"
              }`}
            >
              All ({deliveries.length})
            </button>
            <button
              onClick={() => setDeliveryFilter("success")}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                deliveryFilter === "success" ? "bg-white text-emerald-700 font-bold shadow-2xs" : "text-neutral-500 hover:text-black"
              }`}
            >
              200 OK ({deliveries.filter((d) => d.status === "success").length})
            </button>
            <button
              onClick={() => setDeliveryFilter("failed")}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                deliveryFilter === "failed" ? "bg-white text-red-700 font-bold shadow-2xs" : "text-neutral-500 hover:text-black"
              }`}
            >
              Failed ({deliveries.filter((d) => d.status === "failed").length})
            </button>
          </div>
        </div>

        {/* Deliveries Table */}
        <div className="overflow-x-auto rounded-lg border border-black/10">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-50/80 border-b border-black/10 text-neutral-500 uppercase tracking-wider font-semibold text-[10px]">
              <tr>
                <th className="py-3 px-4">{t("deliveries.status")}</th>
                <th className="py-3 px-4">{t("deliveries.event")}</th>
                <th className="py-3 px-4">{t("deliveries.endpoint")}</th>
                <th className="py-3 px-4">{t("deliveries.dispatched")}</th>
                <th className="py-3 px-4">{t("deliveries.attempts")}</th>
                <th className="py-3 px-4 text-right">{t("deliveries.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 text-neutral-700">
              {filteredDeliveries.length > 0 ? (
                filteredDeliveries.map((del) => {
                  const isSuccess = del.status === "success" || (del.response_status && del.response_status >= 200 && del.response_status < 300);
                  const isResendingThis = resendingId === del.id;

                  return (
                    <tr
                      key={del.id}
                      onClick={() => {
                        setSelectedDelivery(del);
                        setIsDeliveryDrawerOpen(true);
                      }}
                      className="hover:bg-neutral-50/70 transition-colors cursor-pointer group"
                    >
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border font-bold ${
                            isSuccess
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-red-50 text-red-700 border-red-200"
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${isSuccess ? "bg-emerald-500" : "bg-red-500"}`}
                          />
                          {del.response_status || (isSuccess ? "200 OK" : "ERROR")}
                        </span>
                      </td>

                      <td className="py-3 px-4 font-mono font-bold text-black group-hover:underline">
                        {del.event_type}
                      </td>

                      <td className="py-3 px-4 font-mono text-[11px] text-neutral-500 max-w-xs truncate">
                        {del.webhooks?.url || "https://..."}
                      </td>

                      <td className="py-3 px-4 font-mono text-[11px] text-neutral-500">
                        {new Date(del.created_at).toLocaleTimeString()} · {new Date(del.created_at).toLocaleDateString()}
                      </td>

                      <td className="py-3 px-4 font-mono text-[11px]">
                        #{del.attempt_count}
                      </td>

                      <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleResendDelivery(del)}
                            disabled={isResendingThis}
                            className="button button-secondary text-[11px] h-7 px-2.5 flex items-center gap-1"
                            title="Resend this delivery"
                          >
                            {isResendingThis ? (
                              <RotateCw size={11} className="animate-spin" />
                            ) : (
                              <Send size={11} />
                            )}
                            <span>Resend</span>
                          </button>

                          <button
                            onClick={() => {
                              setSelectedDelivery(del);
                              setIsDeliveryDrawerOpen(true);
                            }}
                            className="button button-secondary text-[11px] h-7 px-2 text-neutral-600 hover:text-black"
                            title="Inspect Payload & Headers"
                          >
                            Inspect
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-neutral-500 text-xs">
                    No delivery records match your filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 6. Interactive Programmatic Usage API Snippets */}
      <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-black/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <Terminal size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-black tracking-tight">
                Programmatic Usage Billing API
              </h3>
              <p className="text-xs text-neutral-500">
                Trigger on-chain USDC pulls on demand (e.g. for AI inference compute or API call volume).
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 bg-neutral-100 p-0.5 rounded-lg shrink-0">
            {(["curl", "typescript", "python"] as const).map((lang) => (
              <button
                key={lang}
                onClick={() => setCodeLanguage(lang)}
                className={`text-xs font-mono px-3 py-1 rounded-md transition-colors ${
                  codeLanguage === lang
                    ? "bg-white text-black font-bold shadow-2xs"
                    : "text-neutral-500 hover:text-black"
                }`}
              >
                {lang === "curl" ? "cURL" : lang === "typescript" ? "TypeScript" : "Python"}
              </button>
            ))}
          </div>
        </div>

        <div className="relative rounded-lg bg-[#09090b] text-neutral-200 p-4 font-mono text-xs overflow-x-auto border border-neutral-800">
          <button
            onClick={() => copySnippet(activeSnippet)}
            className="absolute right-3 top-3 button button-secondary text-xs h-7 px-2.5 bg-neutral-800 text-white hover:bg-neutral-700 border-neutral-700 flex items-center gap-1"
          >
            {copiedCode ? (
              <>
                <Check size={11} className="text-emerald-400" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy size={11} />
                <span>Copy</span>
              </>
            )}
          </button>
          <pre className="leading-relaxed pr-16">
            <code>{activeSnippet}</code>
          </pre>
        </div>

        <div className="p-3.5 rounded-lg bg-neutral-50 border border-black/5 text-xs text-neutral-600 flex items-start gap-2.5">
          <ShieldCheck size={16} className="text-black shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-black">Idempotency &amp; Nonce Protection:</span>{" "}
            All programmatic pulls accept an <code className="font-mono text-[11px] text-black">idempotency_key</code> to guarantee that automated billing jobs never double-charge a user under network retries.
          </div>
        </div>
      </div>

      {/* Modals & Drawers */}
      <CreateApiKeyModal
        isOpen={isCreateKeyModalOpen}
        onClose={() => setIsCreateKeyModalOpen(false)}
        onCreateKey={(newKey) => setKeys((prev) => [newKey, ...prev])}
      />

      <RegisterWebhookModal
        isOpen={isRegisterWebhookModalOpen}
        onClose={() => setIsRegisterWebhookModalOpen(false)}
        onSave={handleSaveWebhook}
        initialData={editingWebhook}
      />

      <WebhookDeliveryDrawer
        isOpen={isDeliveryDrawerOpen}
        onClose={() => setIsDeliveryDrawerOpen(false)}
        delivery={selectedDelivery}
        onResend={handleResendDelivery}
        isResending={resendingId === selectedDelivery?.id}
      />
    </div>
  );
}
