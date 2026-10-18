"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  LayoutDashboard,
  Package,
  Users,
  SendHorizontal,
  Link2,
  Code2,
  ArrowUpRight,
  LogOut,
  ChevronDown,
  Menu,
  X,
  ShieldCheck,
  Globe,
  Wallet,
  Copy,
  Check,
  Pencil,
  Bell,
  UserCog,
  UsersRound,
  Gift,
  Sparkles,
  FileSpreadsheet,
} from "lucide-react";
import { Brand } from "@/components/layout/brand";
import { useAuth } from "@/lib/auth-context";
import { useNotifications } from "@/lib/notification-context";
import { DashboardTab, NetworkId, NETWORKS } from "./dashboard-types";
import { OverviewView } from "./views/overview-view";
import { PlansView } from "./views/plans-view";
import { SubscribersView } from "./views/subscribers-view";
import { PayrollView } from "./views/payroll-view";
import { MultisigView } from "./views/multisig-view";
import { GiftPassesView } from "./views/gift-passes-view";
import { DomainsView } from "./views/domains-view";
import { PaymentLinksView } from "./views/payment-links-view";
import { DevelopersView } from "./views/developers-view";
import { TeamView } from "./views/team-view";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { VaultModal } from "./modals/vault-modal";
import { DeployVaultModal } from "./modals/deploy-vault-modal";
import { ReportsTaxWizardModal } from "./modals/reports-tax-wizard-modal";
import { NotificationDrawer } from "./drawers/notification-drawer";
import { DOCS_URL } from "@/lib/links";

export function DashboardShell() {
  const t = useTranslations("Dashboard");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { user, signOut, updateVault, updateBusinessName } = useAuth();
  const { unreadCount, toggleDrawer } = useNotifications();
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");

  const handleSignOut = () => {
    signOut();
    router.push("/signin");
  };
  const [activeNetwork, setActiveNetwork] = useState<NetworkId>("stellar-testnet");
  const [isNetworkDropdownOpen, setIsNetworkDropdownOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isVaultModalOpen, setIsVaultModalOpen] = useState(false);
  const [isDeployModalOpen, setIsDeployModalOpen] = useState(false);
  const [isReportsWizardOpen, setIsReportsWizardOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [isEditingBusinessName, setIsEditingBusinessName] = useState(false);
  const [businessNameInput, setBusinessNameInput] = useState("");

  if (!user) return null;

  const handleSaveBusinessName = (e: React.FormEvent) => {
    e.preventDefault();
    if (businessNameInput.trim()) {
      updateBusinessName(businessNameInput.trim());
      setIsEditingBusinessName(false);
    }
  };

  const copyMerchantId = () => {
    navigator.clipboard.writeText(user.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const navItems = [
    {
      id: "overview" as DashboardTab,
      label: t("nav.overview"),
      icon: LayoutDashboard,
      badge: null,
    },
    {
      id: "plans" as DashboardTab,
      label: t("nav.plans"),
      icon: Package,
      badge: "3",
    },
    {
      id: "subscribers" as DashboardTab,
      label: t("nav.subscribers"),
      icon: Users,
      badge: "148",
    },
    {
      id: "payroll" as DashboardTab,
      label: t("nav.payroll"),
      icon: SendHorizontal,
      badge: t("badges.superpower"),
    },
    {
      id: "multisig" as DashboardTab,
      label: t("nav.multisig"),
      icon: UsersRound,
      badge: t("badges.multisig"),
    },
    {
      id: "passes" as DashboardTab,
      label: t("nav.passes"),
      icon: Gift,
      badge: t("badges.oneTime"),
    },
    {
      id: "domains" as DashboardTab,
      label: t("nav.domains"),
      icon: Globe,
      badge: null,
    },
    {
      id: "links" as DashboardTab,
      label: t("nav.links"),
      icon: Link2,
      badge: null,
    },
    {
      id: "team" as DashboardTab,
      label: t("nav.team"),
      icon: UserCog,
      badge: null,
    },
    {
      id: "developers" as DashboardTab,
      label: t("nav.developers"),
      icon: Code2,
      badge: t("badges.api"),
    },
  ];

  return (
    <div className="min-h-screen bg-[#fafafb] flex text-[#09090b]">
      {/* Mobile Backdrop */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 bg-white border-r border-black/10 flex flex-col justify-between transition-transform duration-200 ${
          isMobileMenuOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div>
          {/* Brand Header */}
          <div className="h-16 px-6 border-b border-black/10 flex items-center justify-between">
            <Brand variant="black" />
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-black/5 text-neutral-600 border border-black/10">
              {t("merchantBadge")}
            </span>
          </div>

          {/* Workspace & Merchant Pill */}
          <div className="p-4 border-b border-black/5">
            <div className="p-3.5 rounded-lg bg-neutral-50 border border-black/5">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                  {t("businessEntity")}
                </div>
                {!isEditingBusinessName && (
                  <button
                    onClick={() => {
                      setBusinessNameInput(user.businessName);
                      setIsEditingBusinessName(true);
                    }}
                    className="text-[10px] text-neutral-400 hover:text-black flex items-center gap-1 font-medium transition-colors"
                    title={t("renameCompany")}
                  >
                    <Pencil size={10} />
                    <span>{tc("edit")}</span>
                  </button>
                )}
              </div>

              {!isEditingBusinessName ? (
                <div className="text-sm font-bold text-black truncate mt-0.5">
                  {user.businessName}
                </div>
              ) : (
                <form onSubmit={handleSaveBusinessName} className="mt-1.5 space-y-1.5">
                  <input
                    type="text"
                    required
                    placeholder={t("businessNamePlaceholder")}
                    value={businessNameInput}
                    onChange={(e) => setBusinessNameInput(e.target.value)}
                    className="w-full text-xs font-bold border border-black/20 rounded px-2 py-1 bg-white text-black focus:outline-hidden focus:ring-1 focus:ring-black"
                    autoFocus
                  />
                  <div className="flex items-center gap-1.5 justify-end">
                    <button
                      type="button"
                      onClick={() => setIsEditingBusinessName(false)}
                      className="text-[10px] px-2 py-0.5 rounded border border-black/10 hover:bg-black/5"
                    >
                      {tc("cancel")}
                    </button>
                    <button
                      type="submit"
                      className="text-[10px] px-2.5 py-0.5 rounded bg-black text-white hover:bg-neutral-800 font-semibold"
                    >
                      {tc("save")}
                    </button>
                  </div>
                </form>
              )}

              <button
                onClick={copyMerchantId}
                className="hover:text-black font-mono text-[10px] text-neutral-500 flex items-center gap-1 mt-2 transition-colors"
                title={t("copyMerchantId")}
              >
                <span>ID: {user.id}</span>
                {copiedId ? (
                  <Check size={10} className="text-emerald-600" />
                ) : (
                  <Copy size={10} />
                )}
              </button>
            </div>
          </div>

          {/* Navigation Items */}
          <nav className="p-3 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveTab(item.id);
                    setIsMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-black text-white"
                      : "text-neutral-600 hover:text-black hover:bg-neutral-100"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon size={16} />
                    <span>{item.label}</span>
                  </div>
                  {item.badge && (
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                        isActive
                          ? "bg-white/20 text-white"
                          : "bg-neutral-100 text-neutral-600 border border-black/5"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer: Linked Vaults Indicator & Sign Out */}
        <div className="p-4 border-t border-black/10 space-y-3">
          {/* Linked Vaults Status Pill */}
          <button
            onClick={() => setIsVaultModalOpen(true)}
            className="w-full text-left p-2.5 rounded-lg border border-black/10 hover:border-black/30 bg-neutral-50/60 hover:bg-neutral-50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-1.5">
                <ShieldCheck size={12} className="text-emerald-600" />
                {user.customContractId ? "Custom Vault" : t("settlementVault")}
              </span>
              <span className="text-[10px] font-mono text-emerald-600 font-bold">
                {user.customContractId ? "Active" : t("ready")}
              </span>
            </div>
            <div className="text-[11px] font-mono text-neutral-600 truncate mt-1">
              {user.customContractId || t("treasuryDescription")}
            </div>
          </button>

          {/* User Sign Out */}
          <div className="flex items-center justify-between pt-1 text-xs text-neutral-500">
            <span className="truncate max-w-[140px] font-semibold text-black" title={user.businessName}>
              {user.businessName}
            </span>
            <button
              onClick={handleSignOut}
              className="p-1.5 rounded hover:bg-black/5 text-neutral-500 hover:text-black transition-colors"
              title={t("signOut")}
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <header className="h-16 px-6 border-b border-black/10 bg-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="lg:hidden p-2 rounded-md hover:bg-neutral-100 text-neutral-600"
            >
              {isMobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
            <div>
              <h1 className="text-base font-bold text-black tracking-tight capitalize">
                {t(`titles.${activeTab}`)}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={toggleDrawer}
              className="relative p-2 rounded-lg border border-black/10 hover:border-black/25 bg-white text-neutral-600 hover:text-black transition-colors"
              title={t("notifications")}
              aria-label={t("notifications")}
            >
              <Bell size={16} />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-indigo-600 text-white rounded-full text-[9px] font-bold flex items-center justify-center font-mono">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>
            <LocaleSwitcher className="hidden sm:inline-flex" />
            <Link
              href={`${DOCS_URL}/checkout/widget`}
              className="button button-secondary text-xs h-8 px-3 flex items-center gap-1"
            >
              <span>{t("sdkDocs")}</span>
              <ArrowUpRight size={12} />
            </Link>
            <button
              onClick={() => setIsReportsWizardOpen(true)}
              className="button button-secondary text-xs h-8 px-3 flex items-center gap-1.5"
              title="Interactive Subscription Analytics & Tax Reporting Wizard (#168)"
            >
              <FileSpreadsheet size={13} className="text-black" />
              <span className="hidden sm:inline">Reports & Taxes</span>
            </button>
            {user.customContractId ? (
              <button
                onClick={() => setIsDeployModalOpen(true)}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-mono hover:bg-emerald-100 transition-colors"
                title={`Active Custom Contract: ${user.customContractId}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <span>Vault: {user.customContractId.slice(0, 4)}...{user.customContractId.slice(-4)}</span>
              </button>
            ) : (
              <button
                onClick={() => setIsDeployModalOpen(true)}
                className="button button-secondary text-xs h-8 px-3 flex items-center gap-1.5"
                title="Deploy custom branded Soroban vault"
              >
                <Sparkles size={13} className="text-black" />
                <span className="hidden sm:inline">Deploy Vault</span>
              </button>
            )}
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-full bg-neutral-100 text-neutral-800 border border-black/5 text-xs font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>{t("settlementEngine")}</span>
            </div>
          </div>
        </header>

        {/* Tab Content */}
        <main className="flex-1 p-6 md:p-8 overflow-y-auto max-w-6xl w-full mx-auto">
          {activeTab === "overview" && (
            <OverviewView
              user={user}
              activeNetwork={activeNetwork}
              onNavigateTab={(tab) => setActiveTab(tab)}
              onOpenReportsWizard={() => setIsReportsWizardOpen(true)}
            />
          )}

          {activeTab === "plans" && <PlansView />}

          {activeTab === "subscribers" && <SubscribersView />}

          {activeTab === "payroll" && <PayrollView />}

          {activeTab === "multisig" && <MultisigView />}

          {activeTab === "passes" && <GiftPassesView />}

          {activeTab === "domains" && <DomainsView />}

          {activeTab === "links" && (
            <PaymentLinksView businessName={user.businessName} />
          )}

          {activeTab === "team" && <TeamView />}

          {activeTab === "developers" && <DevelopersView />}
        </main>
      </div>

      {/* Vault Management Modal */}
      <VaultModal
        isOpen={isVaultModalOpen}
        onClose={() => setIsVaultModalOpen(false)}
        user={user}
        onUpdateVault={updateVault}
      />

      {/* Custom Branded Soroban Vault Deployment Wizard Modal (#143) */}
      <DeployVaultModal
        isOpen={isDeployModalOpen}
        onClose={() => setIsDeployModalOpen(false)}
      />

      {/* Interactive Subscription Analytics Export & Tax Reporting Wizard Modal (#168) */}
      <ReportsTaxWizardModal
        isOpen={isReportsWizardOpen}
        onClose={() => setIsReportsWizardOpen(false)}
        merchantId={user.id}
        merchantName={user.businessName}
        walletAddress={user.walletAddress}
      />

      {/* Real-time Notifications Drawer */}
      <NotificationDrawer />
    </div>
  );
}
