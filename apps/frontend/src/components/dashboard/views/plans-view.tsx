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
  ExternalLink,
  Users,
  TrendingUp,
  Layers,
  ArrowUpRight,
} from "lucide-react";
import { SubscriptionPlan } from "../dashboard-types";
import { CreatePlanModal } from "../modals/create-plan-modal";
import { EmbedCodeModal } from "../modals/embed-code-modal";

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
    status: "active",
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

export function PlansView() {
  const t = useTranslations("Tables");
  const [plans, setPlans] = useState<SubscriptionPlan[]>(INITIAL_PLANS);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedPlanForEmbed, setSelectedPlanForEmbed] = useState<SubscriptionPlan | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCreatePlan = (newPlan: SubscriptionPlan) => {
    setPlans((prev) => [newPlan, ...prev]);
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

  const totalSubscribers = plans.reduce((acc, p) => acc + p.activeSubscribers, 0);
  const totalMonthlyVolume = plans.reduce(
    (acc, p) => acc + (p.amount * p.activeSubscribers * (30 / p.intervalDays)),
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
            Configure recurring USDC billing tiers enforced by non-custodial Soroban allowance vaults.
          </p>
        </div>

        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="button button-primary text-xs h-9 px-4 flex items-center gap-2 self-start sm:self-auto shrink-0"
        >
          <Plus size={15} />
          <span>Create New Plan</span>
        </button>
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
            {totalMonthlyVolume.toLocaleString("en-US", { minimumFractionDigits: 2 })} <span className="text-xs font-mono font-bold text-neutral-500">USDC</span>
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            Projected automated revenue
          </div>
        </div>
      </div>

      {/* 3. Search & Filter Bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
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
                  <th className="py-3.5 px-5 text-right">{t("plans.integration")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 text-neutral-700">
                {filteredPlans.map((plan) => {
                  const monthlyEst = (plan.amount * plan.activeSubscribers * (30 / plan.intervalDays));
                  return (
                    <tr key={plan.id} className="hover:bg-neutral-50/50 transition-colors">
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
                          <span className="font-semibold text-black">{plan.activeSubscribers}</span>
                          <span className="text-neutral-400 text-[11px]">vaults</span>
                        </div>
                      </td>

                      <td className="py-4 px-4">
                        <div className="font-mono font-semibold text-black">
                          {monthlyEst.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC
                        </div>
                      </td>

                      <td className="py-4 px-4">
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                          ACTIVE
                        </span>
                      </td>

                      <td className="py-4 px-5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setSelectedPlanForEmbed(plan)}
                            className="button button-secondary text-xs h-8 px-3 flex items-center gap-1.5"
                          >
                            <Code2 size={13} />
                            <span>Get Code</span>
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
    </div>
  );
}
