"use client";

import { PriceDisplay } from "@/components/ui/price-display";
import { useTranslations } from "next-intl";
import { useEffect, useState, useCallback } from "react";
import {
  Users,
  Search,
  CheckCircle2,
  Clock,
  ExternalLink,
  Copy,
  Check,
  Zap,
  ShieldCheck,
  RotateCw,
  AlertCircle,
  Database,
  Radio,
  RefreshCw,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { SubscriberRecord } from "../dashboard-types";
import {
  fetchSubscribers,
  mapApiSubscriberToRecord,
  ORBIT_API_URL,
  setMerchantApiKey,
} from "@/lib/api";
import { CustomerDetailDrawer } from "../drawers/customer-detail-drawer";
import { PastDueResolutionModal } from "../modals/past-due-resolution-modal";
import { retrySignedPull } from "@/lib/billing-resolution";

export const INITIAL_SUBSCRIBERS: SubscriberRecord[] = [
  {
    id: "sub_bob_9421",
    walletAddress: "GBOBZ7M5W8Y2K6T1R9P0V4N8D2L7C3F9A1H5J8K2",
    planId: "plan_mailkit_pro",
    planName: "MailKit Pro",
    amount: 29.0,
    network: "stellar-testnet",
    status: "pending_pull",
    nextPullDate: "Due Now",
    totalSettled: 116.0,
    joinedDate: "May 18, 2026",
  },
  {
    id: "sub_alice_4812",
    walletAddress: "GALI37H9P4B2N8C1X6K5M7W9D0F3L8T2V4J7R9Q0",
    planId: "plan_ai_starter",
    planName: "AI Engine Starter",
    amount: 15.0,
    network: "stellar-testnet",
    status: "active",
    nextPullDate: "In 12 days",
    totalSettled: 45.0,
    joinedDate: "Jul 02, 2026",
  },
  {
    id: "sub_david_8932",
    walletAddress: "GDAV84N2L7C3F9A1H5J8K2GB3XQ4Z7M5W8Y2K6T1",
    planId: "plan_dao_retainer",
    planName: "DAO Builder Pass",
    amount: 100.0,
    network: "stellar-testnet",
    status: "pending_pull",
    nextPullDate: "Due Now",
    totalSettled: 400.0,
    joinedDate: "Apr 11, 2026",
  },
  {
    id: "sub_elena_3391",
    walletAddress: "GELE93M4K8P1T6R9V0D2L7C3F9A1H5J8K2W8Y2K5",
    planId: "plan_mailkit_pro",
    planName: "MailKit Pro",
    amount: 29.0,
    network: "stellar-testnet",
    status: "active",
    nextPullDate: "In 18 days",
    totalSettled: 87.0,
    joinedDate: "Jun 14, 2026",
  },
  {
    id: "sub_marcus_7721",
    walletAddress: "GMAR51K9T3R7V2D8L4C0F6A2H8J1K5W9Y3K7M2P6",
    planId: "plan_ai_starter",
    planName: "AI Engine Starter",
    amount: 15.0,
    network: "stellar-testnet",
    status: "past_due",
    nextPullDate: "Retry in 2d",
    totalSettled: 30.0,
    joinedDate: "Aug 01, 2026",
    dunningStatus: "pending",
    retryCount: 1,
  },
];

export function SubscribersView() {
  const t = useTranslations("Tables");
  const { user } = useAuth();
  const [subscribers, setSubscribers] = useState<SubscriberRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Demo mode flag
  const [isDemoMode, setIsDemoMode] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("demo") === "true") return true;
      if (params.get("demo") === "false") return false;
    }
    return process.env.NEXT_PUBLIC_DEMO_MODE === "true" || !user?.id;
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "pending_pull" | "active" | "past_due">("all");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [executingPullId, setExecutingPullId] = useState<string | null>(null);
  const [pullSuccessMessage, setPullSuccessMessage] = useState<string | null>(null);
  const [isBatchPulling, setIsBatchPulling] = useState(false);

  // Customer Management Drawer
  const [selectedSubscriber, setSelectedSubscriber] = useState<SubscriberRecord | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [resolutionSubscriber, setResolutionSubscriber] = useState<SubscriberRecord | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");

  // Load subscribers from Merchant API or fallback to Demo Data
  const loadSubscribers = useCallback(async () => {
    if (isDemoMode) {
      setSubscribers(INITIAL_SUBSCRIBERS);
      setIsLoading(false);
      setError(null);
      return;
    }

    if (!user?.id) {
      setSubscribers(INITIAL_SUBSCRIBERS);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const items = await fetchSubscribers(user.id);
      const mapped = items.map(mapApiSubscriberToRecord);
      setSubscribers(mapped);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to connect to Orbit Merchant API";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [isDemoMode, user?.id]);

  useEffect(() => {
    loadSubscribers();
  }, [loadSubscribers]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleOpenDrawer = (sub: SubscriberRecord) => {
    setSelectedSubscriber(sub);
    setIsDrawerOpen(true);
  };

  const handleSubscriberUpdated = (updated: SubscriberRecord) => {
    setSubscribers((prev) =>
      prev.map((s) => (s.id === updated.id ? updated : s))
    );
    setSelectedSubscriber(updated);
  };

  // Execute Pull Trigger (simulates on-chain Soroban pull_funds execution)
  const handleExecutePull = async (sub: SubscriberRecord) => {
    setExecutingPullId(sub.id);
    setPullSuccessMessage(null);
    if (!isDemoMode) {
      try {
        const result = await retrySignedPull(sub.id, setPullSuccessMessage);
        setPullSuccessMessage(result.pending ? `Pull submitted; confirmation pending. Transaction: ${result.txHash}` : `Pull confirmed. Transaction: ${result.txHash}`);
        if (!result.pending) await loadSubscribers();
      } catch (reason) { setError(reason instanceof Error ? reason.message : "Pull failed"); }
      finally { setExecutingPullId(null); }
      return;
    }

    setTimeout(() => {
      setSubscribers((prev) =>
        prev.map((s) => {
          if (s.id === sub.id) {
            const updated: SubscriberRecord = {
              ...s,
              status: "active",
              nextPullDate: "In 30 days",
              totalSettled: s.totalSettled + s.amount,
            };
            if (selectedSubscriber?.id === sub.id) {
              setSelectedSubscriber(updated);
            }
            return updated;
          }
          return s;
        })
      );

      setExecutingPullId(null);
      setPullSuccessMessage(
        `On-Chain Pull Settled! ${sub.amount} USDC pulled from ${sub.walletAddress.slice(0, 4)}...${sub.walletAddress.slice(-4)} into your treasury vault (1.2s finality).`
      );

      setTimeout(() => setPullSuccessMessage(null), 6000);
    }, 1200);
  };

  // Batch Pull All Due
  const handleBatchPullDue = async () => {
    const dueSubs = subscribers.filter((s) => s.status === "pending_pull");
    if (dueSubs.length === 0) return;

    setIsBatchPulling(true);
    setPullSuccessMessage(null);
    if (!isDemoMode) {
      try { for (const subscriber of dueSubs) await handleExecutePull(subscriber); }
      finally { setIsBatchPulling(false); }
      return;
    }

    const totalPullAmount = dueSubs.reduce((acc, s) => acc + s.amount, 0);

    setTimeout(() => {
      setSubscribers((prev) =>
        prev.map((s) => {
          if (s.status === "pending_pull") {
            return {
              ...s,
              status: "active",
              nextPullDate: "In 30 days",
              totalSettled: s.totalSettled + s.amount,
            };
          }
          return s;
        })
      );

      setIsBatchPulling(false);
      setPullSuccessMessage(
        `Batch Pull Succeeded! Settled ${totalPullAmount} USDC across ${dueSubs.length} due subscribers in single ledger block (1.3s finality).`
      );

      setTimeout(() => setPullSuccessMessage(null), 6000);
    }, 1400);
  };

  const filteredSubscribers = subscribers.filter((s) => {
    const matchesSearch =
      s.walletAddress.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.planName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(searchQuery.toLowerCase());

    if (filterTab === "all") return matchesSearch;
    return matchesSearch && s.status === filterTab;
  });

  const dueCount = subscribers.filter((s) => s.status === "pending_pull").length;
  const pastDueCount = subscribers.filter((s) => s.status === "past_due").length;
  const totalSettledAll = subscribers.reduce((acc, s) => acc + s.totalSettled, 0);

  return (
    <div className="space-y-6">
      {/* 1. Header with Batch Action and Demo Mode Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-bold tracking-tight text-black">
              Subscribers &amp; Allowance Vaults
            </h2>
            {isDemoMode ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-mono font-medium">
                <Radio size={10} className="text-amber-500 animate-pulse" />
                DEMO DATA
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-mono font-medium">
                <Database size={10} className="text-emerald-500" />
                LIVE API
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-500 mt-0.5">
            Verified on-chain customer vaults authorizing recurring USDC pull payments on Stellar Soroban. Click any customer row to manage subscription lifecycle &amp; timeline.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
          {/* Toggle between Live and Demo data */}
          <button
            onClick={() => setIsDemoMode((prev) => !prev)}
            className="text-[11px] h-9 px-3 rounded-lg border border-black/10 bg-white hover:bg-neutral-50 text-neutral-600 hover:text-black font-medium inline-flex items-center gap-1.5 transition-colors shadow-2xs"
            title="Toggle between live Supabase API and demo mock data"
          >
            {isDemoMode ? (
              <>
                <Database size={12} className="text-neutral-500" />
                <span>Switch to Live API</span>
              </>
            ) : (
              <>
                <Radio size={12} className="text-amber-500" />
                <span>Switch to Demo Data</span>
              </>
            )}
          </button>

          {/* Refresh button */}
          {!isDemoMode && (
            <button
              onClick={loadSubscribers}
              disabled={isLoading}
              className="button button-secondary text-xs h-9 px-3 flex items-center gap-1.5 shadow-2xs"
              title="Refresh subscribers from API"
            >
              <RefreshCw size={12} className={isLoading ? "animate-spin" : ""} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          )}

          {dueCount > 0 && (
            <button
              onClick={handleBatchPullDue}
              disabled={isBatchPulling}
              className="button button-primary text-xs h-9 px-4 flex items-center gap-2 shrink-0 shadow-xs"
            >
              {isBatchPulling ? (
                <>
                  <RotateCw size={13} className="animate-spin" />
                  <span>Executing Batch Pull...</span>
                </>
              ) : (
                <>
                  <Zap size={13} className="text-emerald-400" />
                  <span>Execute All Due Pulls ({dueCount})</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {!isDemoMode && <form className="flex flex-wrap items-center gap-3 rounded-xl border p-4 text-xs" onSubmit={(event) => {
        event.preventDefault(); setMerchantApiKey(apiKeyInput); setApiKeyInput(""); void loadSubscribers();
      }}><label htmlFor="subscriber-api-key">Merchant API key</label><input id="subscriber-api-key" type="password" autoComplete="off"
        value={apiKeyInput} onChange={(event) => setApiKeyInput(event.target.value)} required placeholder="orb_test_…"
        className="min-w-0 flex-1 rounded-lg border px-3 py-2" /><button type="submit" className="button button-secondary px-3 py-2">Connect API</button>
        <span className="text-neutral-500">Held in memory for this page session.</span></form>}

      {/* Success Notification Banner */}
      {pullSuccessMessage && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 flex items-start gap-3 animate-in fade-in duration-200 shadow-xs">
          <CheckCircle2 size={18} className="text-emerald-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-semibold">Protocol Execution Verified:</span> {pullSuccessMessage}
          </div>
        </div>
      )}

      {/* Error State Banner */}
      {error && !isDemoMode && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in fade-in duration-200 shadow-xs">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="text-red-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-red-900">Merchant API Error:</span>{" "}
              {error}
              <div className="text-[11px] text-red-700 mt-0.5">
                Target endpoint: <code className="font-mono">{ORBIT_API_URL}/subscribers</code>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
            <button
              onClick={loadSubscribers}
              className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium text-xs transition-colors"
            >
              Retry
            </button>
            <button
              onClick={() => setIsDemoMode(true)}
              className="px-3 py-1.5 rounded-lg bg-white border border-red-300 hover:bg-red-100 text-red-900 font-medium text-xs transition-colors"
            >
              Use Demo Data
            </button>
          </div>
        </div>
      )}

      {/* 2. Metrics Ribbon */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Total Subscribers
          </div>
          <div className="text-2xl font-bold text-black mt-1">
            {isLoading ? "—" : subscribers.length}
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            Active on-chain vaults
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Pulls Due Now
          </div>
          <div className={`text-2xl font-bold mt-1 ${dueCount > 0 ? "text-amber-600" : "text-black"}`}>
            {isLoading ? "—" : dueCount}
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            {dueCount > 0 ? "Ready for on-chain trigger" : "All vaults up to date"}
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Settled to Date
          </div>
          <div className="text-2xl font-bold text-black mt-1">
            {isLoading ? "—" : totalSettledAll.toLocaleString("en-US", { minimumFractionDigits: 2 })} <span className="text-xs font-mono font-bold text-neutral-500">USDC</span>
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            100% non-custodial
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Past-Due in Dunning
          </div>
          <div className={`text-2xl font-bold mt-1 ${pastDueCount > 0 ? "text-red-600" : "text-black"}`}>
            {isLoading ? "—" : pastDueCount}
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            Smart retry cadence active
          </div>
        </div>
      </div>

      {/* 3. Search & Status Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            placeholder="Search by customer address, plan name, or subscription ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-black/10 pl-9 pr-4 py-2 text-xs text-black bg-white focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
          />
        </div>

        <div className="flex items-center gap-1 bg-neutral-100 p-0.5 rounded-lg shrink-0">
          <button
            onClick={() => setFilterTab("all")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
              filterTab === "all"
                ? "bg-white text-black font-bold shadow-2xs"
                : "text-neutral-500 hover:text-black"
            }`}
          >
            All ({subscribers.length})
          </button>
          <button
            onClick={() => setFilterTab("pending_pull")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
              filterTab === "pending_pull"
                ? "bg-white text-amber-700 font-bold shadow-2xs"
                : "text-neutral-500 hover:text-black"
            }`}
          >
            Due ({dueCount})
          </button>
          <button
            onClick={() => setFilterTab("active")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
              filterTab === "active"
                ? "bg-white text-black font-bold shadow-2xs"
                : "text-neutral-500 hover:text-black"
            }`}
          >
            Active ({subscribers.filter((s) => s.status === "active").length})
          </button>
          <button
            onClick={() => setFilterTab("past_due")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
              filterTab === "past_due"
                ? "bg-white text-red-700 font-bold shadow-2xs"
                : "text-neutral-500 hover:text-black"
            }`}
          >
            Past Due ({pastDueCount})
          </button>
        </div>
      </div>

      {/* 4. Subscribers Table */}
      <div className="rounded-xl border border-black/10 bg-white overflow-hidden shadow-xs">
        {isLoading ? (
          <div className="py-20 flex flex-col items-center justify-center text-center">
            <RotateCw size={24} className="text-black animate-spin mb-3" />
            <h4 className="font-semibold text-black text-sm">Loading subscribers...</h4>
            <p className="text-xs text-neutral-500 mt-1 font-mono">
              Fetching active vaults from {ORBIT_API_URL}/subscribers
            </p>
          </div>
        ) : filteredSubscribers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50/80 border-b border-black/10 text-neutral-500 uppercase tracking-wider font-semibold text-[10px]">
                <tr>
                  <th className="py-3.5 px-5">{t("subscribers.vault")}</th>
                  <th className="py-3.5 px-4">{t("subscribers.plan")}</th>
                  <th className="py-3.5 px-4">{t("subscribers.rate")}</th>
                  <th className="py-3.5 px-4">{t("subscribers.settled")}</th>
                  <th className="py-3.5 px-4">{t("subscribers.nextPull")}</th>
                  <th className="py-3.5 px-4">{t("subscribers.status")}</th>
                  <th className="py-3.5 px-5 text-right">{t("subscribers.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 text-neutral-700">
                {filteredSubscribers.map((sub) => {
                  const isExecuting = executingPullId === sub.id;
                  const isDue = sub.status === "pending_pull";
                  const isPastDue = sub.status === "past_due";
                  const isCancelled = sub.status === "cancelled";

                  return (
                    <tr
                      key={sub.id}
                      onClick={() => handleOpenDrawer(sub)}
                      className="hover:bg-neutral-50/70 transition-colors cursor-pointer group"
                    >
                      {/* Customer Address & Copy */}
                      <td className="py-4 px-5">
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              isCancelled
                                ? "bg-neutral-400"
                                : isPastDue
                                ? "bg-red-500 animate-pulse"
                                : isDue
                                ? "bg-amber-500 animate-pulse"
                                : "bg-emerald-500"
                            }`}
                          />
                          <span className="font-mono text-xs font-semibold text-black group-hover:underline">
                            {sub.walletAddress.slice(0, 6)}...{sub.walletAddress.slice(-4)}
                          </span>
                          <button
                            onClick={() => copyToClipboard(sub.walletAddress, sub.id)}
                            className="p-1 rounded hover:bg-black/5 text-neutral-400 hover:text-black transition-colors"
                            title="Copy full address"
                          >
                            {copiedKey === sub.id ? (
                              <Check size={11} className="text-emerald-600" />
                            ) : (
                              <Copy size={11} />
                            )}
                          </button>
                          <a
                            href={`https://stellar.expert/explorer/testnet/account/${sub.walletAddress}`}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1 rounded hover:bg-black/5 text-neutral-400 hover:text-black transition-colors"
                            title="View on Stellar Expert"
                          >
                            <ExternalLink size={11} />
                          </a>
                        </div>
                        <div className="text-[10px] font-mono text-neutral-400 mt-0.5 pl-4">
                          ID: {sub.id.slice(0, 16)} · Joined {sub.joinedDate}
                        </div>
                      </td>

                      {/* Plan Name */}
                      <td className="py-4 px-4 font-semibold text-black">
                        {sub.planName}
                      </td>

                      {/* Allowance Rate */}
                      <td className="py-4 px-4">
                        <div className="font-mono font-bold text-black">
                          <PriceDisplay amount={sub.amount} />
                        </div>
                        <div className="text-[10px] text-neutral-400">
                          Per Cycle
                        </div>
                      </td>

                      {/* Total Settled */}
                      <td className="py-4 px-4">
                        <div className="font-mono font-semibold text-black">
                          <PriceDisplay amount={sub.totalSettled} />
                        </div>
                        <div className="text-[10px] text-neutral-400">
                          {Math.round(sub.totalSettled / (sub.amount || 1))} pulls settled
                        </div>
                      </td>

                      {/* Next Billing Date */}
                      <td className="py-4 px-4">
                        {isPastDue ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold text-red-800 bg-red-100 px-2 py-0.5 rounded border border-red-300">
                            <Clock size={11} />
                            {sub.nextPullDate}
                          </span>
                        ) : isDue ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded border border-amber-300">
                            <Clock size={11} />
                            {sub.nextPullDate}
                          </span>
                        ) : (
                          <span className="font-mono text-xs text-neutral-600">
                            {sub.nextPullDate}
                          </span>
                        )}
                      </td>

                      {/* Vault Status */}
                      <td className="py-4 px-4">
                        {isCancelled ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-neutral-100 text-neutral-600 border border-neutral-200 font-medium">
                            CANCELLED
                          </span>
                        ) : isPastDue ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>
                            PAST DUE (DUNNING)
                          </span>
                        ) : isDue ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                            PULL READY
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                            ACTIVE VAULT
                          </span>
                        )}
                      </td>

                      {/* Action Buttons */}
                      <td className="py-4 px-5 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          {isPastDue && <button className="button button-secondary h-7 px-2 text-xs text-red-700"
                            onClick={() => setResolutionSubscriber(sub)}>Resolve payment</button>}
                          {isDue && (
                            <button
                              onClick={() => handleExecutePull(sub)}
                              disabled={isExecuting || isBatchPulling}
                              className="button button-primary text-xs h-7 px-2.5 inline-flex items-center gap-1 bg-black text-white hover:bg-neutral-800"
                              title="Execute pull funds on Soroban"
                            >
                              {isExecuting ? (
                                <RotateCw size={11} className="animate-spin" />
                              ) : (
                                <Zap size={11} className="text-emerald-400" />
                              )}
                              <span>Pull</span>
                            </button>
                          )}

                          <button
                            onClick={() => handleOpenDrawer(sub)}
                            className="button button-secondary text-[11px] h-7 px-2 text-neutral-600 hover:text-black flex items-center gap-1"
                            title="Open Customer Portal Drawer"
                          >
                            <SlidersHorizontal size={11} />
                            <span>Manage</span>
                            <ChevronRight size={11} className="text-neutral-400" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-16 text-center">
            <div className="w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 flex items-center justify-center mx-auto mb-3">
              <Users size={22} />
            </div>
            <h4 className="font-semibold text-black text-sm">No subscribers found</h4>
            <p className="text-xs text-neutral-500 max-w-sm mx-auto mt-1 leading-relaxed">
              {searchQuery
                ? `No active vaults matching "${searchQuery}".`
                : "When customers subscribe via the Orbit Checkout Widget, their on-chain vaults appear here."}
            </p>
            {!isDemoMode && (
              <button
                onClick={() => setIsDemoMode(true)}
                className="mt-4 px-3 py-1.5 rounded-lg border border-black/10 bg-white hover:bg-neutral-50 text-xs font-medium text-black transition-colors"
              >
                Load Demo Mock Subscribers
              </button>
            )}
          </div>
        )}
      </div>

      {/* On-Chain Security Guarantee Card */}
      <div className="p-4 rounded-xl bg-neutral-50 border border-black/5 flex items-start gap-3 text-xs text-neutral-600">
        <ShieldCheck size={18} className="text-black shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-black">Non-Custodial Pull Contract Rules:</span>
          {" "}The Soroban smart contract (<code className="font-mono text-[11px] text-black">CAZBZB...YQNG</code>) verifies on-chain ledger timestamps. A merchant cannot pull funds before the interval has elapsed or exceed the authorized amount cap.
        </div>
      </div>

      {/* Customer Detail Drawer */}
      {resolutionSubscriber && <PastDueResolutionModal key={resolutionSubscriber.id} subscriber={resolutionSubscriber} demo={isDemoMode}
        onClose={() => setResolutionSubscriber(null)} onUpdated={(updated) => {
          if (updated) handleSubscriberUpdated(updated); else void loadSubscribers();
        }} />}
      <CustomerDetailDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        subscriber={selectedSubscriber}
        onExecutePull={handleExecutePull}
        onSubscriberUpdated={handleSubscriberUpdated}
        isExecutingPull={executingPullId === selectedSubscriber?.id}
      />
    </div>
  );
}
