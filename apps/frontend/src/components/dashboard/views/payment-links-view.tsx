"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  Link2,
  Plus,
  Copy,
  Check,
  Search,
  ExternalLink,
  Eye,
  TrendingUp,
  Clock,
  Sparkles,
} from "lucide-react";
import { PaymentLink } from "../dashboard-types";
import { CreatePaymentLinkModal } from "../modals/create-payment-link-modal";
import { PreviewLinkModal } from "../modals/preview-link-modal";

interface PaymentLinksViewProps {
  businessName: string;
}

const SAMPLE_LINKS: PaymentLink[] = [
  {
    id: "plink_retainer_94a",
    title: "Monthly Advisory Retainer",
    amount: 2000.0,
    currency: "USDC",
    type: "recurring",
    intervalDays: 30,
    url: "https://orbit.network/pay/plink_retainer_94a",
    clicks: 142,
    conversions: 18,
    network: "stellar-testnet",
    status: "active",
  },
  {
    id: "plink_community_81b",
    title: "Private DAO Member Pass",
    amount: 100.0,
    currency: "USDC",
    type: "recurring",
    intervalDays: 30,
    url: "https://orbit.network/pay/plink_community_81b",
    clicks: 285,
    conversions: 64,
    network: "stellar-testnet",
    status: "active",
  },
  {
    id: "plink_audit_42c",
    title: "Architecture Audit & Review",
    amount: 1500.0,
    currency: "USDC",
    type: "one_time",
    url: "https://orbit.network/pay/plink_audit_42c",
    clicks: 68,
    conversions: 8,
    network: "stellar-testnet",
    status: "active",
  },
];

export function PaymentLinksView({ businessName }: PaymentLinksViewProps) {
  const t = useTranslations("Tables");
  const [links, setLinks] = useState<PaymentLink[]>(SAMPLE_LINKS);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "recurring" | "one_time">("all");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [previewLink, setPreviewLink] = useState<PaymentLink | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCreateLink = (newLink: PaymentLink) => {
    setLinks((prev) => [newLink, ...prev]);
  };

  const copyUrl = (rawUrl: string, id: string) => {
    const fullUrl = typeof window !== "undefined" ? `${window.location.origin}/pay/${id}` : rawUrl;
    navigator.clipboard.writeText(fullUrl);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const filteredLinks = links.filter((l) => {
    const matchesSearch =
      l.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      l.id.toLowerCase().includes(searchQuery.toLowerCase());

    if (filterType === "all") return matchesSearch;
    return matchesSearch && l.type === filterType;
  });

  const totalCollected = links.reduce((acc, l) => acc + l.amount * l.conversions, 0);
  const totalClicks = links.reduce((acc, l) => acc + l.clicks, 0);
  const totalConversions = links.reduce((acc, l) => acc + l.conversions, 0);
  const avgConversionRate = totalClicks > 0 ? ((totalConversions / totalClicks) * 100).toFixed(1) : "0";

  return (
    <div className="space-y-6">
      {/* 1. Header with Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-black">
            Payment Links (Hosted Checkout)
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Shareable checkout URLs for consulting retainers, services, and digital dollar billing.
          </p>
        </div>

        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="button button-primary text-xs h-9 px-4 flex items-center gap-2 self-start sm:self-auto shrink-0 shadow-xs"
        >
          <Plus size={15} />
          <span>Create Payment Link</span>
        </button>
      </div>

      {/* 2. Metrics Ribbon */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Active Links
          </div>
          <div className="text-2xl font-bold text-black mt-1">
            {links.length}
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            Hosted checkout URLs
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Collected Volume
          </div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">
            {totalCollected.toLocaleString("en-US", { minimumFractionDigits: 2 })}{" "}
            <span className="text-xs font-mono font-bold text-neutral-500">USDC</span>
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            100% direct to your treasury
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Total Visits / Clicks
          </div>
          <div className="text-2xl font-bold text-black mt-1">
            {totalClicks}
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            Unique link impressions
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Conversion Rate
          </div>
          <div className="text-2xl font-bold text-black mt-1">
            {avgConversionRate}%
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            {totalConversions} successful payments
          </div>
        </div>
      </div>

      {/* 3. Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            placeholder="Search payment links by title or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-black/10 pl-9 pr-4 py-2 text-xs text-black bg-white focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black"
          />
        </div>

        <div className="flex items-center gap-1 bg-neutral-100 p-0.5 rounded-lg shrink-0">
          <button
            onClick={() => setFilterType("all")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
              filterType === "all"
                ? "bg-white text-black font-bold shadow-2xs"
                : "text-neutral-500 hover:text-black"
            }`}
          >
            All ({links.length})
          </button>
          <button
            onClick={() => setFilterType("recurring")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
              filterType === "recurring"
                ? "bg-white text-black font-bold shadow-2xs"
                : "text-neutral-500 hover:text-black"
            }`}
          >
            Recurring ({links.filter((l) => l.type === "recurring").length})
          </button>
          <button
            onClick={() => setFilterType("one_time")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
              filterType === "one_time"
                ? "bg-white text-black font-bold shadow-2xs"
                : "text-neutral-500 hover:text-black"
            }`}
          >
            One-Time ({links.filter((l) => l.type === "one_time").length})
          </button>
        </div>
      </div>

      {/* 4. Payment Links Table */}
      <div className="rounded-xl border border-black/10 bg-white overflow-hidden shadow-xs">
        {filteredLinks.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50/80 border-b border-black/10 text-neutral-500 uppercase tracking-wider font-semibold text-[10px]">
                <tr>
                  <th className="py-3.5 px-5">{t("links.title")}</th>
                  <th className="py-3.5 px-4">{t("links.amount")}</th>
                  <th className="py-3.5 px-4">{t("links.conversions")}</th>
                  <th className="py-3.5 px-4">{t("links.collected")}</th>
                  <th className="py-3.5 px-4">{t("links.status")}</th>
                  <th className="py-3.5 px-5 text-right">{t("links.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 text-neutral-700">
                {filteredLinks.map((link) => {
                  const collected = link.amount * link.conversions;

                  return (
                    <tr key={link.id} className="hover:bg-neutral-50/50 transition-colors">
                      {/* Title & Link */}
                      <td className="py-4 px-5">
                        <div className="font-semibold text-black text-sm">
                          {link.title}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="font-mono text-[11px] text-neutral-400 truncate max-w-[240px]">
                            {link.url}
                          </span>
                          <button
                            onClick={() => copyUrl(link.url, link.id)}
                            className="p-1 rounded hover:bg-black/5 text-neutral-400 hover:text-black transition-colors"
                            title="Copy link"
                          >
                            {copiedId === link.id ? (
                              <Check size={11} className="text-emerald-600" />
                            ) : (
                              <Copy size={11} />
                            )}
                          </button>
                        </div>
                      </td>

                      {/* Amount & Type */}
                      <td className="py-4 px-4">
                        <div className="font-mono font-bold text-black text-xs">
                          {link.amount.toFixed(2)} USDC
                        </div>
                        <div className="text-[11px] text-neutral-400">
                          {link.type === "recurring"
                            ? `Recurring / ${link.intervalDays} Days`
                            : "One-Time Invoice"}
                        </div>
                      </td>

                      {/* Performance */}
                      <td className="py-4 px-4">
                        <div className="font-semibold text-black">
                          {link.conversions} paid
                        </div>
                        <div className="text-[11px] text-neutral-400">
                          {link.clicks} impressions
                        </div>
                      </td>

                      {/* Total Collected */}
                      <td className="py-4 px-4 font-mono font-bold text-black">
                        {collected.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC
                      </td>

                      {/* Status */}
                      <td className="py-4 px-4">
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                          ACTIVE
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="py-4 px-5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => copyUrl(link.url, link.id)}
                            className="button button-secondary text-xs h-8 px-2.5 flex items-center gap-1"
                            title="Copy shareable link"
                          >
                            {copiedId === link.id ? (
                              <Check size={12} className="text-emerald-600" />
                            ) : (
                              <Copy size={12} />
                            )}
                            <span>{copiedId === link.id ? "Copied" : "Copy"}</span>
                          </button>

                          <button
                            onClick={() => setPreviewLink(link)}
                            className="button button-secondary text-xs h-8 px-2.5 flex items-center gap-1 text-neutral-600 hover:text-black"
                            title="Preview hosted checkout"
                          >
                            <Eye size={12} />
                            <span>Preview</span>
                          </button>

                          <a
                            href={`/pay/${link.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="button button-secondary text-xs h-8 px-2.5 flex items-center gap-1 text-neutral-600 hover:text-black"
                            title="Open hosted checkout page"
                          >
                            <ExternalLink size={12} />
                            <span>Open</span>
                          </a>
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
              <Link2 size={22} />
            </div>
            <h4 className="font-semibold text-black text-sm">No payment links found</h4>
            <p className="text-xs text-neutral-500 max-w-sm mx-auto mt-1 leading-relaxed">
              Generate your first shareable checkout link to accept retainers or services with 0 lines of code.
            </p>
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="button button-primary text-xs h-9 px-4 mt-4 inline-flex items-center gap-1.5"
            >
              <Plus size={14} /> Create Payment Link
            </button>
          </div>
        )}
      </div>

      {/* Modals */}
      <CreatePaymentLinkModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreateLink={handleCreateLink}
      />

      <PreviewLinkModal
        link={previewLink}
        businessName={businessName}
        onClose={() => setPreviewLink(null)}
      />
    </div>
  );
}
