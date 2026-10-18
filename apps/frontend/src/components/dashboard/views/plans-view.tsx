"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  Plus,
  Package,
  Code2,
  Copy,
  Check,
  Search,
  Users,
  ArrowRightLeft,
  Sparkles,
  CheckCircle2,
  Clock,
  Wallet,
  Calendar,
} from "lucide-react";
import {
  PlanMigrationCampaign,
  SubscriberMigrationRecord,
  SubscriptionPlan,
} from "../dashboard-types";
import { CreatePlanModal } from "../modals/create-plan-modal";
import { EmbedCodeModal } from "../modals/embed-code-modal";
import {
  PlanMigrationWizardModal,
  SubscriberUpgradeModal,
} from "../modals/plan-migration-modal";
import {
  completeSubscriberTierUpgrade,
  computeMigrationCampaignStats,
  createPlanMigrationCampaign,
  evaluatePlanLifecyclePolicy,
} from "@/lib/plan-migration";

const INITIAL_PLANS: SubscriptionPlan[] = [
  {
    id: "plan_mailkit_pro",
    name: "MailKit Pro",
    amount: 29.0,
    currency: "USDC",
    intervalDays: 30,
    network: "stellar-testnet",
    activeSubscribers: 86,
    status: "active",
    createdAt: "2026-09-01T10:00:00Z",
  },
  {
    id: "plan_ai_starter",
    name: "AI Engine Starter",
    amount: 15.0,
    currency: "USDC",
    intervalDays: 30,
    network: "stellar-testnet",
    activeSubscribers: 48,
    status: "deprecated",
    sunsetDate: "2026-12-01T23:59:59.000Z",
    migratedToPlanId: "plan_mailkit_pro",
    createdAt: "2026-09-05T14:30:00Z",
  },
  {
    id: "plan_dao_retainer",
    name: "DAO Builder Pass",
    amount: 100.0,
    currency: "USDC",
    intervalDays: 30,
    network: "stellar-testnet",
    activeSubscribers: 14,
    status: "active",
    createdAt: "2026-09-10T09:15:00Z",
  },
];

const INITIAL_CAMPAIGN: PlanMigrationCampaign = (() => {
  const { campaign } = createPlanMigrationCampaign({
    legacyPlan: INITIAL_PLANS[1],
    targetPlan: INITIAL_PLANS[0],
    sunsetDate: "2026-12-01T23:59:59.000Z",
    discountPercent: 15,
  });
  return completeSubscriberTierUpgrade(
    completeSubscriberTierUpgrade(campaign, "sub_mig_01"),
    "sub_mig_02"
  );
})();

export function PlansView() {
  const t = useTranslations("Tables");
  const [plans, setPlans] = useState<SubscriptionPlan[]>(INITIAL_PLANS);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedPlanForEmbed, setSelectedPlanForEmbed] =
    useState<SubscriptionPlan | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Plan Migration & Bulk Subscriber Tier Transfer (#183)
  const [campaigns, setCampaigns] = useState<PlanMigrationCampaign[]>([
    INITIAL_CAMPAIGN,
  ]);
  const [isMigrationWizardOpen, setIsMigrationWizardOpen] = useState(false);
  const [wizardLegacyPlanId, setWizardLegacyPlanId] = useState<
    string | undefined
  >(undefined);
  const [activeUpgradePreview, setActiveUpgradePreview] = useState<{
    campaign: PlanMigrationCampaign;
    subscriber: SubscriberMigrationRecord;
  } | null>(null);
  const [copiedMigrationLink, setCopiedMigrationLink] = useState<string | null>(
    null
  );

  const handleCreatePlan = (newPlan: SubscriptionPlan) => {
    setPlans((prev) => [newPlan, ...prev]);
  };

  const handleCreateMigrationCampaign = ({
    campaign,
    updatedLegacyPlan,
  }: {
    campaign: PlanMigrationCampaign;
    updatedLegacyPlan: SubscriptionPlan;
  }) => {
    setPlans((prev) =>
      prev.map((p) => (p.id === updatedLegacyPlan.id ? updatedLegacyPlan : p))
    );
    setCampaigns((prev) => [
      campaign,
      ...prev.filter((c) => c.id !== campaign.id),
    ]);
  };

  const handleSubscriberConfirmUpgrade = (
    campaignId: string,
    subscriberId: string
  ) => {
    setCampaigns((prev) =>
      prev.map((c) =>
        c.id === campaignId
          ? completeSubscriberTierUpgrade(c, subscriberId)
          : c
      )
    );
  };

  const copyPlanId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const filteredPlans = plans.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalSubscribers = plans.reduce(
    (acc, p) => acc + p.activeSubscribers,
    0
  );
  const totalMonthlyVolume = plans.reduce(
    (acc, p) => acc + p.amount * p.activeSubscribers * (30 / p.intervalDays),
    0
  );

  return (
    <div className="space-y-6">
      {/* 1. Header with Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-black">
            Subscription Plans
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Configure recurring USDC billing tiers, manage non-custodial plan migrations, and track Soroban vault allowance upgrades.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
          <button
            type="button"
            onClick={() => {
              setWizardLegacyPlanId(undefined);
              setIsMigrationWizardOpen(true);
            }}
            className="button button-secondary text-xs h-9 px-3.5 flex items-center gap-1.5"
          >
            <ArrowRightLeft size={14} />
            <span>Plan Migration Wizard</span>
          </button>

          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="button button-primary text-xs h-9 px-4 flex items-center gap-2"
          >
            <Plus size={15} />
            <span>Create New Plan</span>
          </button>
        </div>
      </div>

      {/* 2. Quick Metrics Summary Ribbon */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Active Plans
          </div>
          <div className="text-2xl font-bold text-black mt-1">
            {plans.length}
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            Configured on Stellar Testnet
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Total Subscribers
          </div>
          <div className="text-2xl font-bold text-black mt-1">
            {totalSubscribers}
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            Active on-chain recurring vaults
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Monthly Run Rate
          </div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">
            {totalMonthlyVolume.toLocaleString("en-US", {
              minimumFractionDigits: 2,
            })}{" "}
            <span className="text-xs font-mono font-bold text-neutral-500">
              USDC
            </span>
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            Projected automated revenue
          </div>
        </div>
      </div>

      {/* 3. Search & Filter Bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400"
          />
          <input
            type="text"
            placeholder="Search plans by name or plan_id..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-black/10 pl-9 pr-4 py-2 text-xs text-black bg-white focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
          />
        </div>
      </div>

      {/* 4. Plans Table */}
      <div className="rounded-xl border border-black/10 bg-white overflow-hidden shadow-xs">
        {filteredPlans.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50/80 border-b border-black/10 text-neutral-500 uppercase tracking-wider font-semibold text-[10px]">
                <tr>
                  <th className="py-3.5 px-5">{t("plans.name")}</th>
                  <th className="py-3.5 px-4">{t("plans.rate")}</th>
                  <th className="py-3.5 px-4">{t("plans.subscribers")}</th>
                  <th className="py-3.5 px-4">{t("plans.monthly")}</th>
                  <th className="py-3.5 px-4">{t("plans.status")}</th>
                  <th className="py-3.5 px-5 text-right">
                    {t("plans.integration")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 text-neutral-700">
                {filteredPlans.map((plan) => {
                  const monthlyEst =
                    plan.amount *
                    plan.activeSubscribers *
                    (30 / plan.intervalDays);
                  const policy = evaluatePlanLifecyclePolicy(plan);

                  return (
                    <tr
                      key={plan.id}
                      className="hover:bg-neutral-50/50 transition-colors"
                    >
                      <td className="py-4 px-5">
                        <div className="font-semibold text-black text-sm">
                          {plan.name}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="font-mono text-[10px] text-neutral-400">
                            {plan.id}
                          </span>
                          <button
                            onClick={() => copyPlanId(plan.id)}
                            className="p-1 rounded hover:bg-black/5 text-neutral-400 hover:text-black transition-colors"
                            title="Copy Plan ID"
                          >
                            {copiedId === plan.id ? (
                              <Check size={11} className="text-emerald-600" />
                            ) : (
                              <Copy size={11} />
                            )}
                          </button>
                        </div>
                      </td>

                      <td className="py-4 px-4">
                        <div className="font-mono font-bold text-black text-xs">
                          {plan.amount.toFixed(2)} USDC
                        </div>
                        <div className="text-[11px] text-neutral-400">
                          Every {plan.intervalDays} Days
                        </div>
                      </td>

                      <td className="py-4 px-4">
                        <div className="flex items-center gap-1.5">
                          <Users size={13} className="text-neutral-400" />
                          <span className="font-semibold text-black">
                            {plan.activeSubscribers}
                          </span>
                          <span className="text-neutral-400 text-[11px]">
                            vaults
                          </span>
                        </div>
                      </td>

                      <td className="py-4 px-4">
                        <div className="font-mono font-semibold text-black">
                          {monthlyEst.toLocaleString("en-US", {
                            minimumFractionDigits: 2,
                          })}{" "}
                          USDC
                        </div>
                      </td>

                      <td className="py-4 px-4">
                        {plan.status === "deprecated" ? (
                          <div className="space-y-1">
                            <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-bold">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                              DEPRECATED (NO NEW SIGNUPS)
                            </span>
                            {plan.sunsetDate && (
                              <div className="text-[10px] font-mono text-neutral-500">
                                Sunset:{" "}
                                {new Date(plan.sunsetDate).toLocaleDateString()}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                            ACTIVE
                          </span>
                        )}
                      </td>

                      <td className="py-4 px-5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setWizardLegacyPlanId(plan.id);
                              setIsMigrationWizardOpen(true);
                            }}
                            className="button button-secondary text-xs h-8 px-2.5 flex items-center gap-1"
                            title="Migrate subscribers to a new plan tier"
                          >
                            <ArrowRightLeft size={12} />
                            <span>Migrate Tier</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedPlanForEmbed(plan)}
                            disabled={!policy.allowNewSignups}
                            title={
                              policy.allowNewSignups
                                ? "Generate checkout embed code"
                                : policy.reason
                            }
                            className="button button-secondary text-xs h-8 px-3 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Code2 size={13} />
                            <span>
                              {policy.allowNewSignups
                                ? "Get Code"
                                : "Signups Disabled"}
                            </span>
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
              <Package size={22} />
            </div>
            <h4 className="font-semibold text-black text-sm">No plans found</h4>
            <p className="text-xs text-neutral-500 max-w-sm mx-auto mt-1 leading-relaxed">
              {searchQuery
                ? `No subscription plans matching "${searchQuery}".`
                : "Create your first recurring USDC pricing tier to generate drop-in checkout widgets."}
            </p>
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="button button-primary text-xs h-9 px-4 mt-4 inline-flex items-center gap-1.5"
            >
              <Plus size={14} /> Create Plan
            </button>
          </div>
        )}
      </div>

      {/* 5. Automated Plan Migration & Bulk Subscriber Tier Transfer Tracker (#183) */}
      {campaigns.length > 0 && (
        <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xs space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-black/5">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-black">
                <Sparkles size={16} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-black tracking-tight">
                    Automated Plan Migration &amp; Bulk Subscriber Tier Transfer
                  </h3>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                    SOROBAN ALLOWANCE SYNC
                  </span>
                </div>
                <p className="text-xs text-neutral-500">
                  Track non-custodial subscriber allowance upgrades from deprecated legacy plans before their sunset cutoff.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setWizardLegacyPlanId(undefined);
                setIsMigrationWizardOpen(true);
              }}
              className="button button-primary text-xs h-8 px-3.5 flex items-center gap-1.5 self-start sm:self-auto"
            >
              <ArrowRightLeft size={13} />
              <span>New Migration Campaign</span>
            </button>
          </div>

          <div className="space-y-6">
            {campaigns.map((camp) => {
              const stats = computeMigrationCampaignStats(camp);
              return (
                <div
                  key={camp.id}
                  className="rounded-xl border border-black/10 bg-neutral-50/40 p-5 space-y-5"
                >
                  {/* Campaign Header & Progress Bar */}
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-black text-sm">
                          {camp.legacyPlanName} ({camp.legacyAmount.toFixed(2)}{" "}
                          USDC)
                        </span>
                        <span className="font-mono text-xs text-neutral-400">
                          →
                        </span>
                        <span className="font-bold text-emerald-700 text-sm">
                          {camp.targetPlanName} (
                          {camp.effectiveTargetAmount.toFixed(2)} USDC)
                        </span>
                        {camp.discountPercent > 0 && (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                            -{camp.discountPercent}% GRANDFATHERED
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-4 text-xs text-neutral-500">
                        <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                          <Calendar size={12} />
                          Sunset: {new Date(camp.sunsetDate).toLocaleDateString()}
                        </span>
                        <span className="font-mono text-[11px]">
                          Net MRR Impact:{" "}
                          <strong
                            className={
                              stats.netMrrDelta >= 0
                                ? "text-emerald-700"
                                : "text-amber-700"
                            }
                          >
                            {stats.netMrrDelta >= 0 ? "+" : ""}
                            {stats.netMrrDelta.toFixed(2)} USDC/mo
                          </strong>
                        </span>
                      </div>
                    </div>

                    <div className="w-full lg:w-72 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-neutral-600">
                          Allowance Upgrade Progress
                        </span>
                        <span className="font-mono font-bold text-black">
                          {stats.migratedCount}/{stats.totalSubscribers} (
                          {stats.completionPercent}%)
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-neutral-200 overflow-hidden">
                        <div
                          className="h-full bg-emerald-600 transition-all duration-300"
                          style={{ width: `${stats.completionPercent}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Funnel Metrics: Total Legacy -> Notified -> Migrated -> Pending */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="p-3 rounded-lg bg-white border border-black/5">
                      <div className="text-[10px] font-mono uppercase text-neutral-400">
                        1. Total Legacy Subscribers
                      </div>
                      <div className="text-lg font-bold text-black mt-0.5">
                        {stats.totalSubscribers}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg bg-white border border-black/5">
                      <div className="text-[10px] font-mono uppercase text-neutral-400">
                        2. Notified (Link Dispatched)
                      </div>
                      <div className="text-lg font-bold text-black mt-0.5">
                        {stats.totalSubscribers}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg bg-white border border-black/5">
                      <div className="text-[10px] font-mono uppercase text-emerald-700">
                        3. Migrated (Allowance Updated)
                      </div>
                      <div className="text-lg font-bold text-emerald-600 mt-0.5">
                        {stats.migratedCount}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg bg-white border border-black/5">
                      <div className="text-[10px] font-mono uppercase text-amber-700">
                        4. Pending / At-Risk
                      </div>
                      <div className="text-lg font-bold text-amber-600 mt-0.5">
                        {stats.pendingCount}
                      </div>
                    </div>
                  </div>

                  {/* Per-Subscriber Migration Links & 1-Click Upgrade Table */}
                  <div className="overflow-x-auto rounded-lg border border-black/10 bg-white">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-neutral-50 border-b border-black/10 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                        <tr>
                          <th className="py-2.5 px-3.5">Subscriber Wallet</th>
                          <th className="py-2.5 px-3.5">Tier Transition</th>
                          <th className="py-2.5 px-3.5">Migration Link</th>
                          <th className="py-2.5 px-3.5">Status</th>
                          <th className="py-2.5 px-3.5 text-right">
                            1-Click Upgrade
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/5">
                        {camp.subscribers.map((sub) => (
                          <tr
                            key={sub.id}
                            className="hover:bg-neutral-50/70 transition-colors"
                          >
                            <td className="py-2.5 px-3.5 font-mono text-[11px] font-semibold text-black">
                              {sub.walletAddress.slice(0, 8)}...
                              {sub.walletAddress.slice(-6)}
                              {sub.email && (
                                <div className="font-sans text-[10px] font-normal text-neutral-400">
                                  {sub.email}
                                </div>
                              )}
                            </td>

                            <td className="py-2.5 px-3.5 font-mono text-[11px]">
                              {sub.legacyAmount.toFixed(2)} →{" "}
                              <strong className="text-black">
                                {sub.effectiveAmount.toFixed(2)} USDC
                              </strong>
                            </td>

                            <td className="py-2.5 px-3.5">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[10px] text-neutral-500 truncate max-w-[180px]">
                                  {sub.migrationUrl}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    navigator.clipboard.writeText(
                                      sub.migrationUrl
                                    );
                                    setCopiedMigrationLink(sub.id);
                                    setTimeout(
                                      () => setCopiedMigrationLink(null),
                                      1800
                                    );
                                  }}
                                  className="p-1 text-neutral-400 hover:text-black transition-colors"
                                  title="Copy subscriber migration URL"
                                >
                                  {copiedMigrationLink === sub.id ? (
                                    <Check
                                      size={11}
                                      className="text-emerald-600"
                                    />
                                  ) : (
                                    <Copy size={11} />
                                  )}
                                </button>
                              </div>
                            </td>

                            <td className="py-2.5 px-3.5">
                              {sub.state === "migrated" ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                                  <CheckCircle2 size={10} />
                                  MIGRATED
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-bold">
                                  <Clock size={10} />
                                  AWAITING SIGNATURE
                                </span>
                              )}
                            </td>

                            <td className="py-2.5 px-3.5 text-right">
                              <button
                                type="button"
                                onClick={() =>
                                  setActiveUpgradePreview({
                                    campaign: camp,
                                    subscriber: sub,
                                  })
                                }
                                className="button button-secondary text-[11px] h-7 px-2.5 inline-flex items-center gap-1"
                              >
                                <Wallet size={11} />
                                <span>
                                  {sub.state === "migrated"
                                    ? "View Receipt"
                                    : "1-Click Upgrade"}
                                </span>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Modals */}
      <CreatePlanModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreatePlan={handleCreatePlan}
      />

      <EmbedCodeModal
        plan={selectedPlanForEmbed}
        onClose={() => setSelectedPlanForEmbed(null)}
      />

      <PlanMigrationWizardModal
        isOpen={isMigrationWizardOpen}
        onClose={() => setIsMigrationWizardOpen(false)}
        plans={plans}
        initialLegacyPlanId={wizardLegacyPlanId}
        onCreateCampaign={handleCreateMigrationCampaign}
      />

      <SubscriberUpgradeModal
        isOpen={Boolean(activeUpgradePreview)}
        onClose={() => setActiveUpgradePreview(null)}
        campaign={activeUpgradePreview?.campaign || null}
        subscriber={activeUpgradePreview?.subscriber || null}
        onConfirmUpgrade={handleSubscriberConfirmUpgrade}
      />
    </div>
  );
}
