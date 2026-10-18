"use client";

import { PriceDisplay } from "@/components/ui/price-display";
import { useEffect, useMemo, useState } from "react";
import {
  Wallet,
  ArrowUpRight,
  AlertCircle,
  Copy,
  Check,
  Layers,
  Send,
  ExternalLink,
  FileSpreadsheet,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { MerchantUser, useAuth } from "@/lib/auth-context";
import { connectFreighter } from "@/lib/freighter";
import { signMessage } from "@stellar/freighter-api";
import { AnalyticsRange, MerchantAnalytics, getAnalyticsChallenge, verifyAnalyticsSignature,
  fetchMerchantAnalytics, formatRawUsdc, plotVerifiedRevenue } from "@/lib/merchant-analytics";
import { DashboardTab, NetworkId, NETWORKS } from "../dashboard-types";

interface OverviewViewProps {
  user: MerchantUser;
  activeNetwork: NetworkId;
  onNavigateTab: (tab: DashboardTab) => void;
  onOpenReportsWizard?: () => void;
}

export function OverviewView({
  user,
  activeNetwork,
  onNavigateTab,
  onOpenReportsWizard,
}: OverviewViewProps) {
  const t = useTranslations("Overview");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<AnalyticsRange>("30D");

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const { updateWallet } = useAuth();
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");

  // No placeholder: the settlement address only exists once a wallet is linked.
  const settlementAddress = user.walletAddress || user.linkedVaults?.stellar || "";
  const isConnected = Boolean(settlementAddress);

  const handleConnectWallet = async () => {
    setConnectError("");
    setIsConnecting(true);

    const result = await connectFreighter();
    if (result.ok) {
      updateWallet(result.address);
    } else {
      setConnectError(result.error);
    }

    setIsConnecting(false);
  };

  const [analyticsToken, setAnalyticsToken] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<MerchantAnalytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState("");
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);

  async function connectAnalytics() {
    setAnalyticsError("");
    setAnalyticsLoading(true);
    setAnalyticsToken(null);
    setAnalytics(null);
    try {
      const wallet = await connectFreighter();
      if (!wallet.ok) throw new Error(wallet.error);
      if (user.walletAddress && wallet.address !== user.walletAddress)
        throw new Error("Connect the wallet linked to your merchant account.");
      const challenge = await getAnalyticsChallenge(wallet.address);
      const signed = await signMessage(challenge.message, { address: wallet.address });
      if (signed.error || !signed.signedMessage || signed.signerAddress !== wallet.address)
        throw new Error(signed.error?.message || "Wallet signature was not confirmed.");
      const signature =
  typeof signed.signedMessage === "string"
    ? signed.signedMessage
    : btoa(
        Array.from(signed.signedMessage, (byte) =>
          String.fromCharCode(byte)
        ).join("")
      );

const session = await verifyAnalyticsSignature(
  challenge.challenge_id,
  signature
);
      setAnalyticsToken(session.token); // read-only, short-lived; never persisted.
    } catch (error) {
      setAnalyticsError(error instanceof Error ? error.message : "Unable to load merchant analytics");
    } finally {
      setAnalyticsLoading(false);
    }
  }

  useEffect(() => {
    if (!analyticsToken) return;
    const controller = new AbortController();
    setAnalyticsLoading(true);
    setAnalytics(null); // do not display previous range as current.
    setAnalyticsError("");
    setHoveredDate(null);
    fetchMerchantAnalytics(analyticsToken, timeframe, controller.signal)
      .then(setAnalytics)
      .catch(error => {
        if (!controller.signal.aborted) setAnalyticsError(error instanceof Error ? error.message : "Unable to load analytics");
      })
      .finally(() => { if (!controller.signal.aborted) setAnalyticsLoading(false); });
    return () => controller.abort();
  }, [analyticsToken, timeframe]);

  const chartPoints = useMemo(() => analytics
    ? plotVerifiedRevenue(analytics.points, analytics.period_start, analytics.period_end)
    : [], [analytics]);
  const chartPath = chartPoints.map((pt, i) => `${i === 0 ? "M" : "L"} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`).join(" ");
  const hoveredDay = chartPoints.find(point => point.date === hoveredDate);

  return (
    <div className="space-y-8">
      {/* 1. Treasury Settlement Vault Card */}
      <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-black/5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <Wallet size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-black tracking-tight">
                {t("vaultTitle")}
              </h2>
              <p className="text-xs text-neutral-500 mt-0.5">
                {t("vaultDescription")}
              </p>
            </div>
          </div>
          <button
            onClick={handleConnectWallet}
            disabled={isConnecting}
            className="button button-secondary text-xs h-9 px-3 shrink-0 self-start md:self-auto inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            <Wallet size={14} />
            {isConnecting ? t("connecting") : isConnected ? t("changeWallet") : t("connectWallet")}
          </button>
        </div>

        {connectError && (
          <div className="mt-5 flex items-center gap-2 text-xs text-amber-700">
            <AlertCircle size={14} className="shrink-0" />
            {connectError}
          </div>
        )}

        {isConnected && (
        <div className="mt-5 p-4 rounded-lg border border-black/10 bg-neutral-50/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0"></div>
            <div>
              <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                {t("activeSettlementAddress")}
              </div>
              <div className="font-mono text-xs font-semibold text-black mt-0.5 break-all sm:break-normal">
                {settlementAddress}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-mono px-2.5 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
              {t("nonCustodialActive")}
            </span>
            <button
              onClick={() => copyToClipboard(settlementAddress, "vault")}
              className="p-1.5 rounded hover:bg-black/5 text-neutral-500 hover:text-black transition-colors"
              title={t("copyAddress")}
            >
              {copiedKey === "vault" ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
        )}
      </div>

      {/* Authenticated live analytics — no API keys in browser storage. */}
      <div className="rounded-xl border border-black/10 bg-white p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-black">Verified merchant analytics</div>
          <p className="text-xs text-neutral-500">Connect the registered merchant wallet and sign a read-only login message to view confirmed data.</p>
        </div>
        <button type="button" onClick={connectAnalytics} disabled={analyticsLoading}
          className="rounded-lg bg-black text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
          {analyticsLoading ? "Loading…" : analyticsToken ? "Reconnect wallet" : "Connect analytics"}
        </button>
      </div>
      {analyticsError && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{analyticsError}</div>}
      {analyticsLoading && !analytics && <div role="status" className="grid grid-cols-2 lg:grid-cols-4 gap-4" aria-label="Loading live metrics">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-xl animate-pulse bg-neutral-100" />)}
      </div>}
      {/* Core KPI metrics from verified, merchant-scoped records only. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">{t("mrr")}</div>
          <div className="text-2xl font-bold text-black mt-3">
            {!analytics || analytics.mrr_incomplete ? "—" : formatRawUsdc(analytics.mrr_usdc_units)}
            <span className="text-sm text-neutral-500 ml-1">USDC</span>
          </div>
          <div className="text-xs text-neutral-500 mt-2">{analytics?.mrr_incomplete ? "Some plans lack verified USDC pricing" : t("mrrNote")}</div>
        </div>
        <div className="p-5 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">{t("activeSubscribers")}</div>
          <div className="text-2xl font-bold text-black mt-3">{analytics?.active_subscribers.toLocaleString("en-US") ?? "—"}</div>
          <div className="text-xs text-neutral-500 mt-2">Current active subscriptions</div>
        </div>
        <div className="p-5 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Verified settled volume</div>
          <div className="text-2xl font-bold text-black mt-3">{formatRawUsdc(analytics?.settled_volume_usdc_units)} <span className="text-sm text-neutral-500">USDC</span></div>
          <div className="text-xs text-neutral-500 mt-2">Confirmed payments recorded on-chain</div>
        </div>
        <div className="p-5 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">New subscribers ({timeframe})</div>
          <div className="text-2xl font-bold text-black mt-3">{analytics?.new_subscribers.toLocaleString("en-US") ?? "—"}</div>
          <div className="text-xs text-neutral-500 mt-2">{analytics && analytics.previous_new_subscribers > 0
            ? `${((analytics.new_subscribers - analytics.previous_new_subscribers) / analytics.previous_new_subscribers * 100).toFixed(1)}% vs previous period`
            : "No previous-period comparison"}</div>
        </div>
      </div>

      {/* Verified revenue chart and existing quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 p-6 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-black/5">
            <div>
              <h3 className="text-base font-semibold text-black tracking-tight">{t("revenueTitle")}</h3>
              <p className="text-xs text-neutral-500 mt-0.5">Confirmed USDC settlements, grouped by UTC day</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-neutral-100 p-0.5 rounded-lg">
                {(["7D", "30D", "90D", "1Y"] as const).map(range => (
                  <button type="button" key={range} aria-pressed={timeframe === range}
                    onClick={() => setTimeframe(range)}
                    className={`text-xs font-mono px-2.5 py-1 rounded-md transition-colors ${timeframe === range ? "bg-white text-black font-bold shadow-2xs" : "text-neutral-500 hover:text-black"}`}>{range}</button>
                ))}
              </div>
              {onOpenReportsWizard && (
                <button
                  type="button"
                  onClick={onOpenReportsWizard}
                  className="px-2.5 py-1 rounded-lg border border-black/10 bg-white text-xs font-medium text-black hover:bg-neutral-50 flex items-center gap-1.5 transition-colors shadow-2xs"
                  title="Open Reports & Tax Reporting Wizard (#168)"
                >
                  <FileSpreadsheet size={13} />
                  <span>Tax Wizard</span>
                </button>
              )}
            </div>
          </div>
          {!analytics ? (
            <div className="h-56 flex items-center justify-center text-sm text-neutral-500">
              {analyticsLoading ? "Loading verified settlements…" : "Sign with your merchant wallet to load revenue"}
            </div>
          ) : chartPoints.every(p => p.amount === 0) ? (
            <div className="h-56 flex items-center justify-center text-sm text-neutral-500">No confirmed settlements in this timeframe</div>
          ) : (
            <div className="relative pt-6">
              <svg viewBox="0 0 400 150" preserveAspectRatio="none" className="w-full h-44 overflow-visible" role="img" aria-label={`Verified settlement revenue for ${timeframe}`}>
                <defs><linearGradient id="orbitLiveRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#09090b" stopOpacity="0.12" />
                  <stop offset="100%" stopColor="#09090b" stopOpacity="0" />
                </linearGradient></defs>
                {[30, 80, 130].map(y => <line key={y} x1="0" y1={y} x2="400" y2={y} stroke="#f0f0f2" strokeDasharray="3 3" />)}
                <path d={`${chartPath} L 380 145 L 20 145 Z`} fill="url(#orbitLiveRevenue)" />
                <path d={chartPath} fill="none" stroke="#09090b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                {chartPoints.map(pt => (
                  <circle key={pt.date} cx={pt.x} cy={pt.y} r={hoveredDate === pt.date ? 5 : 3}
                    fill="white" stroke="#09090b" strokeWidth="2" className="cursor-pointer"
                    onMouseEnter={() => setHoveredDate(pt.date)} onMouseLeave={() => setHoveredDate(null)}>
                    <title>{`${pt.date}: ${formatRawUsdc(pt.units)} USDC`}</title>
                  </circle>
                ))}
              </svg>
              {hoveredDay && <div className="absolute top-0 right-0 bg-black text-white text-xs px-3 py-1.5 rounded-lg shadow-md font-mono">
                {hoveredDay.date}: {formatRawUsdc(hoveredDay.units)} USDC
              </div>}
              <div className="flex justify-between text-[11px] font-mono text-neutral-400 pt-3 border-t border-black/5">
                <span>{chartPoints[0]?.date}</span><span>{chartPoints[chartPoints.length - 1]?.date}</span>
              </div>
            </div>
          )}
          <div className="text-xs text-neutral-500 mt-3">Settled in this period: {formatRawUsdc(analytics?.period_settled_usdc_units)} USDC</div>
        </div>

        {/* Quick Launch & Actions (1 col) */}
        <div className="p-6 rounded-xl bg-white border border-black/10 shadow-xs flex flex-col justify-between">
          <div>
            <h3 className="text-base font-semibold text-black tracking-tight">
              {t("quickOperations")}
            </h3>
            <p className="text-xs text-neutral-500 mt-0.5">
              {t("quickDescription")}
            </p>

            <div className="space-y-3 mt-5">
              <button
                onClick={() => onNavigateTab("plans")}
                className="w-full text-left p-3.5 rounded-lg border border-black/10 hover:border-black/30 hover:bg-neutral-50 transition-all flex items-center justify-between group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-md bg-black/5 flex items-center justify-center text-black">
                    <Layers size={16} />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-black group-hover:text-black">
                      {t("createPlan")}
                    </div>
                    <div className="text-[11px] text-neutral-500">
                      {t("createPlanHint")}
                    </div>
                  </div>
                </div>
                <ArrowUpRight size={14} className="text-neutral-400 group-hover:text-black transition-colors" />
              </button>

              <button
                onClick={() => onNavigateTab("payroll")}
                className="w-full text-left p-3.5 rounded-lg border border-black/10 hover:border-black/30 hover:bg-neutral-50 transition-all flex items-center justify-between group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-md bg-black/5 flex items-center justify-center text-black">
                    <Send size={16} />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-black group-hover:text-black">
                      {t("runPayroll")}
                    </div>
                    <div className="text-[11px] text-neutral-500">
                      {t("runPayrollHint")}
                    </div>
                  </div>
                </div>
                <ArrowUpRight size={14} className="text-neutral-400 group-hover:text-black transition-colors" />
              </button>

              <button
                onClick={() => onNavigateTab("developers")}
                className="w-full text-left p-3.5 rounded-lg border border-black/10 hover:border-black/30 hover:bg-neutral-50 transition-all flex items-center justify-between group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-md bg-black/5 flex items-center justify-center text-black">
                    <ExternalLink size={16} />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-black group-hover:text-black">
                      {t("apiKeys")}
                    </div>
                    <div className="text-[11px] text-neutral-500">
                      {t("apiKeysHint")}
                    </div>
                  </div>
                </div>
                <ArrowUpRight size={14} className="text-neutral-400 group-hover:text-black transition-colors" />
              </button>
            </div>
          </div>

          <div className="pt-5 mt-5 border-t border-black/5">
            <div className="flex items-center justify-between text-xs text-neutral-500">
              <span>{t("protocolState")}</span>
              <span className="font-mono text-emerald-600 font-medium">{t("readyForSettlement")}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent verified settlement dates, never synthetic transaction activity. */}
      <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs">
        <h3 className="text-base font-semibold text-black tracking-tight">Recent verified settlement days</h3>
        <p className="text-xs text-neutral-500 mt-1">Aggregated confirmed on-chain settlement records, not individual transaction receipts</p>
        <div className="divide-y divide-black/5 mt-4">
          {!analytics || analytics.points.length === 0 ? (
            <p className="py-4 text-sm text-neutral-500">{analytics ? "No confirmed payments for this timeframe" : "Connect analytics to view settlement history"}</p>
          ) : analytics.points.slice(-4).reverse().map(point => (
            <div key={point.date} className="py-3 flex justify-between items-center gap-3">
              <span className="text-sm text-neutral-600">{point.date} (UTC)</span>
              <strong className="text-sm font-mono text-black"><PriceDisplay amount={Number(point.amount_usdc_units) / 10000000} /></strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
