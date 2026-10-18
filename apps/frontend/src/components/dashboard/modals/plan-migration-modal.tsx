"use client";

import { useState } from "react";
import {
  X,
  ArrowRight,
  Calendar,
  Percent,
  Send,
  ShieldCheck,
  CheckCircle2,
  Sparkles,
  Wallet,
  Copy,
  Check,
  RotateCw,
} from "lucide-react";
import type {
  PlanMigrationCampaign,
  SubscriberMigrationRecord,
  SubscriptionPlan,
} from "../dashboard-types";
import {
  calculateEffectivePlanPrice,
  createPlanMigrationCampaign,
} from "@/lib/plan-migration";

interface PlanMigrationWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  plans: SubscriptionPlan[];
  initialLegacyPlanId?: string;
  onCreateCampaign: (result: {
    campaign: PlanMigrationCampaign;
    updatedLegacyPlan: SubscriptionPlan;
  }) => void;
}

export function PlanMigrationWizardModal({
  isOpen,
  onClose,
  plans,
  initialLegacyPlanId,
  onCreateCampaign,
}: PlanMigrationWizardModalProps) {
  const activeOrDeprecatedPlans = plans.filter((p) => p.status !== "archived");
  const defaultLegacy =
    initialLegacyPlanId ||
    activeOrDeprecatedPlans[0]?.id ||
    "";
  const defaultTarget =
    activeOrDeprecatedPlans.find((p) => p.id !== defaultLegacy)?.id ||
    activeOrDeprecatedPlans[1]?.id ||
    "";

  const [legacyPlanId, setLegacyPlanId] = useState<string>(defaultLegacy);
  const [targetPlanId, setTargetPlanId] = useState<string>(defaultTarget);
  const [sunsetDate, setSunsetDate] = useState<string>(() => {
    const d = new Date(Date.now() + 30 * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  const [discountPercent, setDiscountPercent] = useState<number>(15);
  const [autoNotify, setAutoNotify] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const selectedLegacy =
    plans.find((p) => p.id === legacyPlanId) || activeOrDeprecatedPlans[0];
  const selectedTarget =
    plans.find((p) => p.id === targetPlanId) ||
    activeOrDeprecatedPlans.find((p) => p.id !== selectedLegacy?.id) ||
    activeOrDeprecatedPlans[0];

  const effectivePrice = selectedTarget
    ? calculateEffectivePlanPrice(selectedTarget.amount, discountPercent)
    : 0;

  const legacyMrr = selectedLegacy
    ? selectedLegacy.amount * selectedLegacy.activeSubscribers
    : 0;
  const targetMrr = selectedLegacy
    ? effectivePrice * selectedLegacy.activeSubscribers
    : 0;
  const mrrDelta = targetMrr - legacyMrr;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedLegacy || !selectedTarget) {
      setError("Select both a legacy plan and a target replacement plan.");
      return;
    }
    if (selectedLegacy.id === selectedTarget.id) {
      setError("Legacy plan and target plan must be different tiers.");
      return;
    }

    try {
      const result = createPlanMigrationCampaign({
        legacyPlan: selectedLegacy,
        targetPlan: selectedTarget,
        sunsetDate: new Date(`${sunsetDate}T23:59:59.000Z`).toISOString(),
        discountPercent,
      });
      onCreateCampaign(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create migration campaign");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
      <div className="w-full max-w-xl rounded-2xl bg-white border border-black/10 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 bg-neutral-50/70">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-black">
                Launch Plan Migration Campaign
              </h3>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-black text-white font-bold">
                NON-CUSTODIAL
              </span>
            </div>
            <p className="text-xs text-neutral-500 mt-0.5">
              Deprecate a legacy tier, enforce a sunset date, and dispatch 1-click Soroban allowance upgrade links.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-black hover:bg-black/5 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 text-xs">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 font-medium">
              {error}
            </div>
          )}

          {/* Plan Selection Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div className="space-y-1.5">
              <label className="block font-semibold text-black uppercase tracking-wider">
                Legacy Plan (To Deprecate)
              </label>
              <select
                value={selectedLegacy?.id || ""}
                onChange={(e) => setLegacyPlanId(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 text-xs text-black bg-white font-medium"
              >
                {activeOrDeprecatedPlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.amount.toFixed(2)} USDC / {p.intervalDays}d)
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block font-semibold text-black uppercase tracking-wider">
                Target Upgrade Plan
              </label>
              <select
                value={selectedTarget?.id || ""}
                onChange={(e) => setTargetPlanId(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 text-xs text-black bg-white font-medium"
              >
                {activeOrDeprecatedPlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.amount.toFixed(2)} USDC / {p.intervalDays}d)
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Sunset Date & Grandfathered Discount */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 font-semibold text-black uppercase tracking-wider">
                <Calendar size={12} />
                <span>Legacy Plan Sunset Date</span>
              </label>
              <input
                type="date"
                required
                value={sunsetDate}
                onChange={(e) => setSunsetDate(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-xs text-black"
              />
              <p className="text-[11px] text-neutral-400">
                New signups stop immediately; existing vaults stay active until sunset.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 font-semibold text-black uppercase tracking-wider">
                <Percent size={12} />
                <span>Grandfathered Discount (%)</span>
              </label>
              <input
                type="number"
                min={0}
                max={90}
                value={discountPercent}
                onChange={(e) => setDiscountPercent(Number(e.target.value))}
                className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-xs text-black"
              />
              <p className="text-[11px] text-neutral-400">
                Effective rate:{" "}
                <span className="font-mono font-bold text-black">
                  {effectivePrice.toFixed(2)} USDC
                </span>{" "}
                (list {selectedTarget?.amount.toFixed(2)} USDC)
              </p>
            </div>
          </div>

          {/* Projected MRR Impact Summary */}
          <div className="rounded-xl border border-black/10 bg-neutral-50 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-neutral-500">
                Cohort &amp; MRR Transition Preview
              </span>
              <span className="font-mono text-[11px] font-bold text-black">
                {selectedLegacy?.activeSubscribers || 0} Active Vaults
              </span>
            </div>
            <div className="flex items-center justify-between pt-1 text-xs">
              <div>
                <div className="text-neutral-500">Legacy Cohort MRR</div>
                <div className="font-mono font-bold text-black text-sm">
                  {legacyMrr.toFixed(2)} USDC
                </div>
              </div>
              <ArrowRight size={16} className="text-neutral-400" />
              <div>
                <div className="text-neutral-500">Target Cohort MRR</div>
                <div className="font-mono font-bold text-black text-sm">
                  {targetMrr.toFixed(2)} USDC
                </div>
              </div>
              <div className="text-right">
                <div className="text-neutral-500">Net MRR Delta</div>
                <div
                  className={`font-mono font-bold text-sm ${
                    mrrDelta >= 0 ? "text-emerald-600" : "text-amber-600"
                  }`}
                >
                  {mrrDelta >= 0 ? "+" : ""}
                  {mrrDelta.toFixed(2)} USDC/mo
                </div>
              </div>
            </div>
          </div>

          {/* Notification Trigger Toggle */}
          <label className="flex items-start gap-2.5 p-3 rounded-xl border border-black/10 bg-white cursor-pointer">
            <input
              type="checkbox"
              checked={autoNotify}
              onChange={(e) => setAutoNotify(e.target.checked)}
              className="mt-0.5 rounded border-black/20"
            />
            <div>
              <div className="font-semibold text-black flex items-center gap-1.5">
                <Send size={12} />
                <span>Generate &amp; Dispatch Personalized Subscriber Upgrade Links</span>
              </div>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                Automatically creates cryptographically signed 1-click migration links for all active subscribers on {selectedLegacy?.name}.
              </p>
            </div>
          </label>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-black/5">
            <button
              type="button"
              onClick={onClose}
              className="button button-secondary text-xs h-9 px-4"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary text-xs h-9 px-4 flex items-center gap-1.5"
            >
              <Sparkles size={13} />
              <span>Deprecate Legacy Plan &amp; Start Migration</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface SubscriberUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  campaign: PlanMigrationCampaign | null;
  subscriber: SubscriberMigrationRecord | null;
  onConfirmUpgrade: (campaignId: string, subscriberId: string) => void;
}

export function SubscriberUpgradeModal({
  isOpen,
  onClose,
  campaign,
  subscriber,
  onConfirmUpgrade,
}: SubscriberUpgradeModalProps) {
  const [isSigning, setIsSigning] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  if (!isOpen || !campaign || !subscriber) return null;

  const priceDelta = subscriber.effectiveAmount - subscriber.legacyAmount;

  const handleOneClickSign = async () => {
    setIsSigning(true);
    await new Promise((r) => setTimeout(r, 450));
    onConfirmUpgrade(campaign.id, subscriber.subscriberId);
    setIsSigning(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white border border-black/10 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 bg-neutral-50/70">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-black">
                1-Click Subscriber Tier Upgrade
              </h3>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                FREIGHTER SOROBAN
              </span>
            </div>
            <p className="text-xs text-neutral-500 mt-0.5">
              Pre-authenticated subscriber view for updating on-chain SEP-0041 vault allowance and plan binding.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-black hover:bg-black/5 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-6 space-y-5 text-xs">
          {/* Subscriber Wallet & Migration Link */}
          <div className="p-3.5 rounded-xl bg-neutral-50 border border-black/10 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                Subscriber Wallet
              </span>
              <span className="font-mono text-[11px] font-bold text-black">
                {subscriber.walletAddress.slice(0, 10)}...{subscriber.walletAddress.slice(-8)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-black/5">
              <span className="font-mono text-[10px] text-neutral-600 truncate">
                {subscriber.migrationUrl}
              </span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(subscriber.migrationUrl);
                  setCopiedUrl(true);
                  setTimeout(() => setCopiedUrl(false), 1800);
                }}
                className="button button-secondary text-[11px] h-6 px-2 shrink-0 flex items-center gap-1"
              >
                {copiedUrl ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                <span>{copiedUrl ? "Copied" : "Copy Link"}</span>
              </button>
            </div>
          </div>

          {/* Side-by-Side Comparison: Old Plan vs New Plan */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-4 rounded-xl border border-black/10 bg-neutral-50/70 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-bold">
                  SUNSETTING
                </span>
                <span className="font-mono text-[10px] text-neutral-400">
                  {campaign.legacyPlanId}
                </span>
              </div>
              <div className="font-bold text-black text-sm pt-1">
                {campaign.legacyPlanName}
              </div>
              <div className="font-mono font-bold text-base text-neutral-700">
                {subscriber.legacyAmount.toFixed(2)} USDC{" "}
                <span className="text-[11px] font-normal text-neutral-400">/ 30d</span>
              </div>
              <div className="text-[11px] text-neutral-500 pt-1">
                Sunsets on {new Date(campaign.sunsetDate).toLocaleDateString()}
              </div>
            </div>

            <div className="p-4 rounded-xl border-2 border-black bg-white space-y-1.5 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                  NEW TIER
                </span>
                {subscriber.discountPercent > 0 && (
                  <span className="text-[10px] font-mono font-bold text-emerald-700">
                    -{subscriber.discountPercent}% GRANDFATHERED
                  </span>
                )}
              </div>
              <div className="font-bold text-black text-sm pt-1">
                {campaign.targetPlanName}
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono font-bold text-base text-black">
                  {subscriber.effectiveAmount.toFixed(2)} USDC
                </span>
                {subscriber.discountPercent > 0 && (
                  <span className="font-mono text-[11px] text-neutral-400 line-through">
                    {subscriber.targetAmount.toFixed(2)}
                  </span>
                )}
                <span className="text-[11px] text-neutral-400">/ 30d</span>
              </div>
              <div className="text-[11px] text-emerald-700 font-medium pt-1">
                {priceDelta >= 0
                  ? `+${priceDelta.toFixed(2)} USDC/mo allowance delta`
                  : `${priceDelta.toFixed(2)} USDC/mo savings`}
              </div>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-neutral-50 border border-black/5 flex items-start gap-2.5 text-neutral-600">
            <ShieldCheck size={15} className="text-black shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-black">Atomic Allowance &amp; Plan Binding:</span>{" "}
              Signing this transaction updates your Soroban subscription vault allowance to{" "}
              <code className="font-mono text-black font-semibold">
                {subscriber.effectiveAmount.toFixed(2)} USDC
              </code>{" "}
              and binds your vault to <code className="font-mono text-black">{campaign.targetPlanId}</code> without double-charging your current billing cycle.
            </div>
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-black/5">
            <button
              type="button"
              onClick={onClose}
              className="button button-secondary text-xs h-9 px-4"
            >
              Close
            </button>
            {subscriber.state === "migrated" ? (
              <span className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
                <CheckCircle2 size={14} />
                <span>Allowance Upgraded ({subscriber.txHash?.slice(0, 10)}...)</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={handleOneClickSign}
                disabled={isSigning}
                className="button button-primary text-xs h-9 px-4 flex items-center gap-1.5"
              >
                {isSigning ? (
                  <>
                    <RotateCw size={13} className="animate-spin" />
                    <span>Signing with Freighter...</span>
                  </>
                ) : (
                  <>
                    <Wallet size={13} />
                    <span>Sign 1-Click Allowance Upgrade</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
