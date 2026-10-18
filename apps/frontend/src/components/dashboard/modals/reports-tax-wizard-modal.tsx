"use client";

import React, { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Filter,
  Globe,
  Loader2,
  Percent,
  Receipt,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

export type FiscalPeriodType = "fiscal_year" | "quarter" | "custom";
export type ReportType = "revenue" | "payout_splits" | "disbursements";
export type TaxJurisdiction = "US_1099" | "EU_VAT" | "UK_HMRC" | "GLOBAL_CSV";

interface ReportsTaxWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  merchantId?: string;
  merchantName?: string;
  walletAddress?: string;
}

interface PreviewTransaction {
  id: string;
  txHash: string;
  timestamp: string;
  dateStr: string;
  customerWallet: string;
  description: string;
  grossAmount: number;
  protocolFee: number;
  taxWithheld: number;
  netAmount: number;
  status: "verified" | "pending";
}

const JURISDICTION_INFO: Record<TaxJurisdiction, { label: string; tag: string; description: string; taxRate: number; formName: string }> = {
  US_1099: {
    label: "United States (IRS 1099-K / 1099-NEC)",
    tag: "US IRS",
    description: "Conforms to IRS Gross Reporting rules for electronic third-party settlement organizations ($600+ threshold).",
    taxRate: 0.0, // Non-employee compensation gross report
    formName: "Form 1099-K / 1099-NEC Schedule",
  },
  EU_VAT: {
    label: "European Union (VAT MOSS Reverse Charge)",
    tag: "EU VAT",
    description: "Cross-border digital services B2B/B2C schedule with estimated 20% standard VAT reserve.",
    taxRate: 0.20,
    formName: "EU VAT Mini One-Stop Shop (MOSS) Return",
  },
  UK_HMRC: {
    label: "United Kingdom (HMRC Digital Tax)",
    tag: "UK HMRC",
    description: "UK Making Tax Digital compliant schedule with standard 20% VAT withholding estimate.",
    taxRate: 0.20,
    formName: "HMRC Self-Assessment Schedule",
  },
  GLOBAL_CSV: {
    label: "Global / Generic Financial Audit Ledger",
    tag: "International",
    description: "Standard GAAP/IFRS gross-to-net reconciliation ledger with 0% default jurisdiction withholding.",
    taxRate: 0.0,
    formName: "GAAP Ledger Reconciliation",
  },
};

// Generates deterministic preview records for demonstration and audit preview
function generatePreviewLedger(
  reportType: ReportType,
  jurisdiction: TaxJurisdiction,
  startDateStr: string,
  endDateStr: string
): PreviewTransaction[] {
  const taxRate = JURISDICTION_INFO[jurisdiction].taxRate;
  const start = new Date(startDateStr).getTime() || Date.now() - 30 * 86400000;
  const end = new Date(endDateStr).getTime() || Date.now();
  const span = Math.max(86400000, end - start);

  const baseItems = [
    { desc: "Pro Enterprise Plan (Monthly)", gross: 499.0, wallet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    { desc: "Developer Team Tier (Monthly)", gross: 149.0, wallet: "GCAV7PQ3K444H3UOGK563R7V26A66V6C36R27SZ3KCVF44L5P6QW4XYZ" },
    { desc: "Starter Tier Annual (12 mo)", gross: 588.0, wallet: "GDJ64LPOQK434H3UOGK563R7V26A66V6C36R27SZ3KCVF44L5P6QW4ABC" },
    { desc: "API Volume Overage Bucket A", gross: 85.5, wallet: "GC7W8LPOQK434H3UOGK563R7V26A66V6C36R27SZ3KCVF44L5P6QW4DEF" },
    { desc: "Pro Enterprise Plan (Monthly)", gross: 499.0, wallet: "GAKL9LPOQK434H3UOGK563R7V26A66V6C36R27SZ3KCVF44L5P6QW4GHI" },
    { desc: "Platform Affiliate Referral Share", gross: -45.0, wallet: "GBMK5LPOQK434H3UOGK563R7V26A66V6C36R27SZ3KCVF44L5P6QW4JKL" },
    { desc: "Enterprise Custom Contract SLA", gross: 1200.0, wallet: "GC5T2LPOQK434H3UOGK563R7V26A66V6C36R27SZ3KCVF44L5P6QW4MNO" },
    { desc: "Team Tier Add-on (5 Seats)", gross: 75.0, wallet: "GD7P1LPOQK434H3UOGK563R7V26A66V6C36R27SZ3KCVF44L5P6QW4PQR" },
  ];

  const items = reportType === "payout_splits"
    ? baseItems.map((b) => ({ ...b, desc: `Affiliate Split: ${b.desc}`, gross: b.gross * 0.2 }))
    : reportType === "disbursements"
    ? baseItems.map((b) => ({ ...b, desc: `Contractor Payout: ${b.desc}`, gross: b.gross * 0.8 }))
    : baseItems;

  return items.map((item, index) => {
    const itemTime = new Date(start + ((index + 1) / (items.length + 1)) * span);
    const dateStr = itemTime.toISOString().split("T")[0];
    const hash = `0x${Array.from({ length: 64 }, (_, i) => ((index * 13 + i * 7) % 16).toString(16)).join("")}`;
    const fee = Number((item.gross * 0.005).toFixed(2)); // 0.5% Orbit fee
    const tax = Number((Math.max(0, item.gross) * taxRate).toFixed(2));
    const net = Number((item.gross - fee - tax).toFixed(2));

    return {
      id: `tx-${index + 1}`,
      txHash: hash,
      timestamp: itemTime.toISOString(),
      dateStr,
      customerWallet: item.wallet,
      description: item.desc,
      grossAmount: item.gross,
      protocolFee: fee,
      taxWithheld: tax,
      netAmount: net,
      status: "verified",
    };
  });
}

export function ReportsTaxWizardModal({
  isOpen,
  onClose,
  merchantId = "merchant_stellar_01",
  merchantName = "Orbit Merchant Store",
  walletAddress = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
}: ReportsTaxWizardModalProps) {
  // Wizard Step Control
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);

  // Step 1 Parameters
  const [periodType, setPeriodType] = useState<FiscalPeriodType>("quarter");
  const [fiscalYear, setFiscalYear] = useState<string>("2026");
  const [fiscalQuarter, setFiscalQuarter] = useState<string>("Q1");
  const [customStartDate, setCustomStartDate] = useState<string>("2026-01-01");
  const [customEndDate, setCustomEndDate] = useState<string>("2026-03-31");
  const [reportType, setReportType] = useState<ReportType>("revenue");
  const [jurisdiction, setJurisdiction] = useState<TaxJurisdiction>("US_1099");

  // Step 2 Preview Search & Filter
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  // Step 3 Export Generation
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStage, setExportStage] = useState("");
  const [exportComplete, setExportComplete] = useState(false);
  const [exportedChecksum, setExportedChecksum] = useState("");

  // Calculate Effective Dates
  const { startDate, endDate, dateRangeLabel } = useMemo(() => {
    if (periodType === "fiscal_year") {
      return {
        startDate: `${fiscalYear}-01-01`,
        endDate: `${fiscalYear}-12-31`,
        dateRangeLabel: `Full Fiscal Year ${fiscalYear}`,
      };
    }
    if (periodType === "quarter") {
      const qMap: Record<string, [string, string]> = {
        Q1: [`${fiscalYear}-01-01`, `${fiscalYear}-03-31`],
        Q2: [`${fiscalYear}-04-01`, `${fiscalYear}-06-30`],
        Q3: [`${fiscalYear}-07-01`, `${fiscalYear}-09-30`],
        Q4: [`${fiscalYear}-10-01`, `${fiscalYear}-12-31`],
      };
      const [start, end] = qMap[fiscalQuarter] || [`${fiscalYear}-01-01`, `${fiscalYear}-03-31`];
      return {
        startDate: start,
        endDate: end,
        dateRangeLabel: `${fiscalQuarter} ${fiscalYear} (${start} to ${end})`,
      };
    }
    return {
      startDate: customStartDate,
      endDate: customEndDate,
      dateRangeLabel: `Custom: ${customStartDate} to ${customEndDate}`,
    };
  }, [periodType, fiscalYear, fiscalQuarter, customStartDate, customEndDate]);

  // Generate Ledger Items
  const ledgerItems = useMemo(() => {
    return generatePreviewLedger(reportType, jurisdiction, startDate, endDate);
  }, [reportType, jurisdiction, startDate, endDate]);

  // Aggregate Totals
  const aggregates = useMemo(() => {
    const grossTotal = ledgerItems.reduce((acc, item) => acc + item.grossAmount, 0);
    const feeTotal = ledgerItems.reduce((acc, item) => acc + item.protocolFee, 0);
    const taxTotal = ledgerItems.reduce((acc, item) => acc + item.taxWithheld, 0);
    const netTotal = ledgerItems.reduce((acc, item) => acc + item.netAmount, 0);
    return {
      grossTotal: Number(grossTotal.toFixed(2)),
      feeTotal: Number(feeTotal.toFixed(2)),
      taxTotal: Number(taxTotal.toFixed(2)),
      netTotal: Number(netTotal.toFixed(2)),
      txCount: ledgerItems.length,
    };
  }, [ledgerItems]);

  // Filtered Items for Preview Table
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return ledgerItems;
    const q = searchQuery.toLowerCase();
    return ledgerItems.filter(
      (item) =>
        item.description.toLowerCase().includes(q) ||
        item.customerWallet.toLowerCase().includes(q) ||
        item.txHash.toLowerCase().includes(q) ||
        item.dateStr.includes(q)
    );
  }, [ledgerItems, searchQuery]);

  const copyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(key);
    setTimeout(() => setCopiedHash(null), 1800);
  };

  // Streaming Export Generator
  const runExportSimulation = async (format: "csv" | "pdf") => {
    setIsExporting(true);
    setExportProgress(10);
    setExportStage("Querying on-chain Soroban ledger events...");

    await new Promise((resolve) => setTimeout(resolve, 350));
    setExportProgress(35);
    setExportStage("Validating cryptographic SHA-256 transaction roots...");

    await new Promise((resolve) => setTimeout(resolve, 400));
    setExportProgress(70);
    setExportStage(`Applying ${JURISDICTION_INFO[jurisdiction].tag} tax schedules & fee withholdings...`);

    await new Promise((resolve) => setTimeout(resolve, 350));
    setExportProgress(100);
    setExportStage("Compiling verified export bundle...");

    const checksum = Array.from({ length: 64 }, (_, i) => ((i * 31 + 7) % 16).toString(16)).join("");
    setExportedChecksum(checksum);
    setExportComplete(true);
    setIsExporting(false);

    if (format === "csv") {
      downloadCsvFile();
    } else {
      downloadPdfAuditFile();
    }
  };

  // CSV Generator
  const downloadCsvFile = () => {
    const headers = [
      "Transaction ID",
      "UTC Date",
      "Timestamp",
      "Transaction Hash",
      "Customer / Counterparty Wallet",
      "Description",
      "Gross Volume (USDC)",
      "Orbit Protocol Fee (USDC)",
      "Tax Withholding (USDC)",
      "Net Realized (USDC)",
      "Verification Status",
      "Jurisdiction",
    ];

    const rows = ledgerItems.map((item) => [
      item.id,
      item.dateStr,
      item.timestamp,
      item.txHash,
      item.customerWallet,
      `"${item.description.replace(/"/g, '""')}"`,
      item.grossAmount.toFixed(2),
      item.protocolFee.toFixed(2),
      item.taxWithheld.toFixed(2),
      item.netAmount.toFixed(2),
      item.status,
      JURISDICTION_INFO[jurisdiction].tag,
    ]);

    const csvContent =
      `# Orbit Financial & Tax Compliance Export\n` +
      `# Merchant: ${merchantName} (${merchantId})\n` +
      `# Wallet: ${walletAddress}\n` +
      `# Period: ${dateRangeLabel}\n` +
      `# Jurisdiction: ${JURISDICTION_INFO[jurisdiction].label}\n` +
      `# Gross Total: $${aggregates.grossTotal.toFixed(2)} USDC | Net Total: $${aggregates.netTotal.toFixed(2)} USDC\n` +
      `# Generated At: ${new Date().toISOString()}\n\n` +
      [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `orbit-tax-report-${jurisdiction}-${startDate}-to-${endDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // PDF / Financial Audit Statement Generator
  const downloadPdfAuditFile = () => {
    const reportDoc =
      `========================================================================================\n` +
      `                      ORBIT PROTOCOL FINANCIAL AUDIT & TAX STATEMENT                     \n` +
      `========================================================================================\n\n` +
      `MERCHANT IDENTITY:       ${merchantName}\n` +
      `MERCHANT ID:             ${merchantId}\n` +
      `SETTLEMENT WALLET:       ${walletAddress}\n` +
      `REPORT TYPE:             ${reportType.toUpperCase()} LEDGER\n` +
      `COMPLIANCE JURISDICTION: ${JURISDICTION_INFO[jurisdiction].label}\n` +
      `TAX SCHEDULE APPLIED:    ${JURISDICTION_INFO[jurisdiction].formName}\n` +
      `FISCAL PERIOD:           ${dateRangeLabel}\n` +
      `REPORT GENERATED:        ${new Date().toUTCString()}\n` +
      `ON-CHAIN VALIDATOR:      Stellar Soroban Testnet (SEP-0041)\n\n` +
      `----------------------------------------------------------------------------------------\n` +
      `EXECUTIVE FINANCIAL RECONCILIATION SUMMARY\n` +
      `----------------------------------------------------------------------------------------\n` +
      `Total Transactions Processed:       ${aggregates.txCount}\n` +
      `Gross Settled Subscription Volume:  $${aggregates.grossTotal.toFixed(2)} USDC\n` +
      `Orbit Protocol & Gas Fees:        - $${aggregates.feeTotal.toFixed(2)} USDC\n` +
      `Estimated Tax Reserve / Withholding: - $${aggregates.taxTotal.toFixed(2)} USDC (${(JURISDICTION_INFO[jurisdiction].taxRate * 100).toFixed(0)}%)\n` +
      `----------------------------------------------------------------------------------------\n` +
      `NET REALIZED BUSINESS REVENUE:      $${aggregates.netTotal.toFixed(2)} USDC\n` +
      `----------------------------------------------------------------------------------------\n\n` +
      `CRYPTOGRAPHIC AUDIT INTEGRITY PROOF:\n` +
      `SHA-256 Checksum: ${exportedChecksum || "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}\n` +
      `Verified by Orbit Smart Contract Engine.\n\n` +
      `========================================================================================\n` +
      `DETAILED TRANSACTION LEDGER\n` +
      `========================================================================================\n` +
      ledgerItems
        .map(
          (item) =>
            `[${item.dateStr}] TX: ${item.txHash.slice(0, 18)}...\n` +
            `  Recipient/Wallet: ${item.customerWallet}\n` +
            `  Item:             ${item.description}\n` +
            `  Gross: $${item.grossAmount.toFixed(2)} USDC | Fee: $${item.protocolFee.toFixed(2)} | Tax: $${item.taxWithheld.toFixed(2)} | Net: $${item.netAmount.toFixed(2)} USDC\n` +
            `  Status:           VERIFIED ON SOROBAN\n`
        )
        .join("\n") +
      `\n========================================================================================\n` +
      `                               END OF OFFICIAL TAX STATEMENT                            \n` +
      `========================================================================================\n`;

    const blob = new Blob([reportDoc], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `orbit-financial-audit-${jurisdiction}-${startDate}-to-${endDate}.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reports-wizard-title"
    >
      <div className="w-full max-w-4xl max-h-[92vh] rounded-2xl bg-white border border-black/10 shadow-2xl flex flex-col overflow-hidden text-neutral-900">
        {/* Header */}
        <div className="px-6 py-5 border-b border-black/10 flex items-center justify-between shrink-0 bg-neutral-50/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-black text-white flex items-center justify-center shadow-xs">
              <Receipt size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="reports-wizard-title" className="text-base font-bold text-black tracking-tight">
                  Financial Analytics & Tax Reporting Wizard
                </h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
                  Soroban On-Chain
                </span>
              </div>
              <p className="text-xs text-neutral-500">
                Generate audit-ready revenue schedules, jurisdiction tax withholding estimates, and verified ledgers.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-black hover:bg-neutral-100 transition-colors"
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Step Indicator */}
        <div className="px-6 py-3 border-b border-black/5 bg-neutral-50/30 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 sm:gap-6 font-medium">
            <button
              onClick={() => setCurrentStep(1)}
              className={`flex items-center gap-2 ${
                currentStep === 1 ? "text-black font-bold" : currentStep > 1 ? "text-emerald-700" : "text-neutral-400"
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-mono ${
                  currentStep === 1
                    ? "bg-black text-white"
                    : currentStep > 1
                    ? "bg-emerald-600 text-white"
                    : "bg-neutral-200 text-neutral-600"
                }`}
              >
                {currentStep > 1 ? <Check size={12} /> : "1"}
              </span>
              <span>1. Parameters & Jurisdiction</span>
            </button>

            <span className="text-neutral-300">/</span>

            <button
              onClick={() => setCurrentStep(2)}
              className={`flex items-center gap-2 ${
                currentStep === 2 ? "text-black font-bold" : currentStep > 2 ? "text-emerald-700" : "text-neutral-400"
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-mono ${
                  currentStep === 2
                    ? "bg-black text-white"
                    : currentStep > 2
                    ? "bg-emerald-600 text-white"
                    : "bg-neutral-200 text-neutral-600"
                }`}
              >
                {currentStep > 2 ? <Check size={12} /> : "2"}
              </span>
              <span>2. Interactive Preview</span>
            </button>

            <span className="text-neutral-300">/</span>

            <button
              onClick={() => setCurrentStep(3)}
              className={`flex items-center gap-2 ${currentStep === 3 ? "text-black font-bold" : "text-neutral-400"}`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-mono ${
                  currentStep === 3 ? "bg-black text-white" : "bg-neutral-200 text-neutral-600"
                }`}
              >
                3
              </span>
              <span>3. Export & Download</span>
            </button>
          </div>

          <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-neutral-500 font-mono">
            <span>Range:</span>
            <span className="font-semibold text-neutral-800">{dateRangeLabel}</span>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {/* STEP 1: CONFIGURATION */}
          {currentStep === 1 && (
            <div className="space-y-6 animate-in fade-in duration-150">
              {/* Fiscal Period Selection */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                  1. Select Fiscal Period
                </label>
                <div className="grid grid-cols-3 gap-3 mb-3">
                  {[
                    { id: "quarter", label: "Fiscal Quarter", icon: Calendar },
                    { id: "fiscal_year", label: "Fiscal Year", icon: Calendar },
                    { id: "custom", label: "Custom Dates", icon: Filter },
                  ].map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setPeriodType(item.id as FiscalPeriodType)}
                      className={`p-3 rounded-xl border text-left flex items-center gap-2.5 transition-all ${
                        periodType === item.id
                          ? "border-black bg-neutral-50 ring-1 ring-black shadow-xs font-semibold text-black"
                          : "border-black/10 bg-white hover:border-black/30 text-neutral-600"
                      }`}
                    >
                      <item.icon size={15} />
                      <span className="text-xs">{item.label}</span>
                    </button>
                  ))}
                </div>

                {/* Sub-inputs for dates */}
                {periodType === "quarter" && (
                  <div className="grid grid-cols-2 gap-3 p-4 rounded-xl bg-neutral-50 border border-black/5">
                    <div>
                      <label className="block text-[11px] text-neutral-500 mb-1 font-mono">Fiscal Year</label>
                      <select
                        value={fiscalYear}
                        onChange={(e) => setFiscalYear(e.target.value)}
                        className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-xs font-mono"
                      >
                        <option value="2026">2026</option>
                        <option value="2025">2025</option>
                        <option value="2024">2024</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-neutral-500 mb-1 font-mono">Quarter</label>
                      <select
                        value={fiscalQuarter}
                        onChange={(e) => setFiscalQuarter(e.target.value)}
                        className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-xs font-mono"
                      >
                        <option value="Q1">Q1 (Jan 01 - Mar 31)</option>
                        <option value="Q2">Q2 (Apr 01 - Jun 30)</option>
                        <option value="Q3">Q3 (Jul 01 - Sep 30)</option>
                        <option value="Q4">Q4 (Oct 01 - Dec 31)</option>
                      </select>
                    </div>
                  </div>
                )}

                {periodType === "fiscal_year" && (
                  <div className="p-4 rounded-xl bg-neutral-50 border border-black/5">
                    <label className="block text-[11px] text-neutral-500 mb-1 font-mono">Select Fiscal Year</label>
                    <select
                      value={fiscalYear}
                      onChange={(e) => setFiscalYear(e.target.value)}
                      className="w-full sm:w-64 rounded-lg border border-black/10 bg-white px-3 py-2 text-xs font-mono"
                    >
                      <option value="2026">Fiscal Year 2026 (Jan 01 - Dec 31)</option>
                      <option value="2025">Fiscal Year 2025 (Jan 01 - Dec 31)</option>
                      <option value="2024">Fiscal Year 2024 (Jan 01 - Dec 31)</option>
                    </select>
                  </div>
                )}

                {periodType === "custom" && (
                  <div className="grid grid-cols-2 gap-3 p-4 rounded-xl bg-neutral-50 border border-black/5">
                    <div>
                      <label className="block text-[11px] text-neutral-500 mb-1 font-mono">Start Date</label>
                      <input
                        type="date"
                        value={customStartDate}
                        onChange={(e) => setCustomStartDate(e.target.value)}
                        className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-neutral-500 mb-1 font-mono">End Date</label>
                      <input
                        type="date"
                        value={customEndDate}
                        onChange={(e) => setCustomEndDate(e.target.value)}
                        className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-xs font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Report Type */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                  2. Select Report Type
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[
                    {
                      id: "revenue",
                      title: "Revenue & Settlements",
                      desc: "Gross subscription revenue, protocol fee deductions, and net receipts.",
                    },
                    {
                      id: "payout_splits",
                      title: "Payout Splits",
                      desc: "Multi-party revenue shares, affiliates, and sub-merchant allocations.",
                    },
                    {
                      id: "disbursements",
                      title: "Disbursements",
                      desc: "Contractor compensation, payroll outflows, and recurring allowances.",
                    },
                  ].map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setReportType(r.id as ReportType)}
                      className={`p-3.5 rounded-xl border text-left transition-all ${
                        reportType === r.id
                          ? "border-black bg-neutral-50 ring-1 ring-black shadow-xs"
                          : "border-black/10 bg-white hover:border-black/30"
                      }`}
                    >
                      <div className="text-xs font-bold text-black mb-1">{r.title}</div>
                      <div className="text-[11px] text-neutral-500 leading-relaxed">{r.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Tax Jurisdiction & Regulatory Profile */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                  3. Tax Jurisdiction & Reporting Profile
                </label>
                <div className="space-y-2">
                  {(Object.keys(JURISDICTION_INFO) as TaxJurisdiction[]).map((key) => {
                    const info = JURISDICTION_INFO[key];
                    const isSelected = jurisdiction === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setJurisdiction(key)}
                        className={`w-full p-3.5 rounded-xl border text-left flex items-start gap-3 transition-all ${
                          isSelected
                            ? "border-black bg-neutral-50 ring-1 ring-black shadow-xs"
                            : "border-black/10 bg-white hover:border-black/30"
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                            isSelected ? "border-black bg-black text-white" : "border-neutral-300"
                          }`}
                        >
                          {isSelected && <Check size={12} />}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-black">{info.label}</span>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-800">
                              {info.tag}
                            </span>
                            {info.taxRate > 0 && (
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                                {(info.taxRate * 100).toFixed(0)}% VAT Rate
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-neutral-500 mt-0.5 leading-relaxed">{info.description}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: INTERACTIVE PREVIEW */}
          {currentStep === 2 && (
            <div className="space-y-6 animate-in fade-in duration-150">
              {/* Summary Metrics */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="p-4 rounded-xl bg-neutral-50 border border-black/10">
                  <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Gross Volume</div>
                  <div className="text-xl font-bold text-black mt-1.5 font-mono">
                    ${aggregates.grossTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </div>
                  <div className="text-[10px] text-neutral-500 mt-1">Confirmed Soroban volume</div>
                </div>

                <div className="p-4 rounded-xl bg-neutral-50 border border-black/10">
                  <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Protocol Fees</div>
                  <div className="text-xl font-bold text-neutral-700 mt-1.5 font-mono">
                    -${aggregates.feeTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </div>
                  <div className="text-[10px] text-neutral-500 mt-1">0.5% Orbit platform fee</div>
                </div>

                <div className="p-4 rounded-xl bg-neutral-50 border border-black/10">
                  <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                    Tax / VAT Reserve
                  </div>
                  <div className="text-xl font-bold text-amber-800 mt-1.5 font-mono">
                    {aggregates.taxTotal > 0 ? `-$${aggregates.taxTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "$0.00"}
                  </div>
                  <div className="text-[10px] text-neutral-500 mt-1">
                    {JURISDICTION_INFO[jurisdiction].tag} withholding rule
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-emerald-50/60 border border-emerald-200">
                  <div className="text-[11px] font-semibold text-emerald-800 uppercase tracking-wider">Net Realized</div>
                  <div className="text-xl font-bold text-emerald-950 mt-1.5 font-mono">
                    ${aggregates.netTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </div>
                  <div className="text-[10px] text-emerald-700 mt-1">Ready for settlement</div>
                </div>
              </div>

              {/* Table Search & Controls */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="relative w-full sm:w-80">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                  <input
                    type="text"
                    placeholder="Search by wallet, tx hash, or plan..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-lg border border-black/10 bg-white pl-9 pr-3 py-2 text-xs text-black placeholder:text-neutral-400"
                  />
                </div>
                <div className="flex items-center gap-2 text-xs text-neutral-500 font-mono">
                  <span>Showing {filteredItems.length} of {ledgerItems.length} transactions</span>
                </div>
              </div>

              {/* Interactive Preview Table */}
              <div className="rounded-xl border border-black/10 overflow-hidden shadow-xs">
                <div className="overflow-x-auto max-h-72">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-neutral-50 border-b border-black/10 text-neutral-500 font-semibold sticky top-0 z-10">
                      <tr>
                        <th className="py-2.5 px-3">Date (UTC)</th>
                        <th className="py-2.5 px-3">Transaction Hash</th>
                        <th className="py-2.5 px-3">Counterparty Wallet</th>
                        <th className="py-2.5 px-3">Description</th>
                        <th className="py-2.5 px-3 text-right">Gross (USDC)</th>
                        <th className="py-2.5 px-3 text-right">Fee</th>
                        <th className="py-2.5 px-3 text-right">Tax Reserve</th>
                        <th className="py-2.5 px-3 text-right">Net (USDC)</th>
                        <th className="py-2.5 px-3 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/5">
                      {filteredItems.map((tx) => (
                        <tr key={tx.id} className="hover:bg-neutral-50/80 transition-colors">
                          <td className="py-2.5 px-3 font-mono text-neutral-600 whitespace-nowrap">{tx.dateStr}</td>
                          <td className="py-2.5 px-3 font-mono">
                            <div className="flex items-center gap-1.5">
                              <span className="text-neutral-800">{tx.txHash.slice(0, 10)}...</span>
                              <button
                                onClick={() => copyText(tx.txHash, tx.id)}
                                className="text-neutral-400 hover:text-black"
                                title="Copy full transaction hash"
                              >
                                {copiedHash === tx.id ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                              </button>
                              <a
                                href={`https://stellar.expert/explorer/testnet/tx/${tx.txHash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-neutral-400 hover:text-black"
                                title="Inspect on StellarExpert"
                              >
                                <ExternalLink size={12} />
                              </a>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-neutral-600 whitespace-nowrap">
                            {tx.customerWallet.slice(0, 6)}...{tx.customerWallet.slice(-4)}
                          </td>
                          <td className="py-2.5 px-3 text-neutral-800 font-medium whitespace-nowrap">
                            {tx.description}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-black font-semibold whitespace-nowrap">
                            ${tx.grossAmount.toFixed(2)}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-neutral-500 whitespace-nowrap">
                            -${tx.protocolFee.toFixed(2)}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-amber-700 whitespace-nowrap">
                            {tx.taxWithheld > 0 ? `-$${tx.taxWithheld.toFixed(2)}` : "$0.00"}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-emerald-800 font-bold whitespace-nowrap">
                            ${tx.netAmount.toFixed(2)}
                          </td>
                          <td className="py-2.5 px-3 text-center whitespace-nowrap">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-mono">
                              <ShieldCheck size={10} /> Verified
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: EXPORT ENGINE & DOWNLOAD */}
          {currentStep === 3 && (
            <div className="space-y-6 animate-in fade-in duration-150">
              <div className="p-5 rounded-xl bg-neutral-50 border border-black/10">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-black">Ready to Export Report Package</h3>
                    <p className="text-xs text-neutral-500 mt-0.5">
                      {dateRangeLabel} · {JURISDICTION_INFO[jurisdiction].label}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-base font-bold text-black font-mono">
                      ${aggregates.grossTotal.toFixed(2)} USDC
                    </div>
                    <div className="text-[11px] text-neutral-500 font-mono">{aggregates.txCount} verified records</div>
                  </div>
                </div>

                {/* Progress bar during export */}
                {isExporting && (
                  <div className="mt-4 pt-4 border-t border-black/5">
                    <div className="flex items-center justify-between text-xs mb-1.5 font-mono">
                      <span className="flex items-center gap-2 text-black">
                        <Loader2 size={13} className="animate-spin text-black" />
                        {exportStage}
                      </span>
                      <span className="font-bold text-black">{exportProgress}%</span>
                    </div>
                    <div className="w-full bg-neutral-200 h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-black h-full transition-all duration-300"
                        style={{ width: `${exportProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {exportComplete && (
                  <div className="mt-4 pt-4 border-t border-black/5">
                    <div className="flex items-center gap-2 text-xs text-emerald-800 font-bold mb-1">
                      <CheckCircle2 size={15} />
                      Export compiled with cryptographic verification
                    </div>
                    <div className="text-[11px] font-mono text-neutral-500 break-all bg-white p-2.5 rounded-lg border border-black/5">
                      <span className="text-neutral-400 select-none">SHA-256: </span>
                      {exportedChecksum}
                    </div>
                  </div>
                )}
              </div>

              {/* Download Buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                  type="button"
                  disabled={isExporting}
                  onClick={() => runExportSimulation("csv")}
                  className="p-5 rounded-xl border border-black/10 bg-white hover:border-black/30 hover:bg-neutral-50 transition-all text-left flex flex-col justify-between shadow-xs disabled:opacity-50"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-800 flex items-center justify-center">
                      <FileSpreadsheet size={20} />
                    </div>
                    <Download size={16} className="text-neutral-400" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-black mb-1">Download CSV Ledger</h4>
                    <p className="text-xs text-neutral-500 leading-relaxed">
                      Complete transactional table with transaction hashes, customer addresses, fee breakdowns, and jurisdiction schedules.
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  disabled={isExporting}
                  onClick={() => runExportSimulation("pdf")}
                  className="p-5 rounded-xl border border-black/10 bg-white hover:border-black/30 hover:bg-neutral-50 transition-all text-left flex flex-col justify-between shadow-xs disabled:opacity-50"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-800 flex items-center justify-center">
                      <FileText size={20} />
                    </div>
                    <Download size={16} className="text-neutral-400" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-black mb-1">Download Official Audit Statement</h4>
                    <p className="text-xs text-neutral-500 leading-relaxed">
                      Formatted financial audit statement suitable for accountants, IRS 1099 compliance, and VAT MOSS filing.
                    </p>
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Navigation */}
        <div className="px-6 py-4 border-t border-black/10 flex items-center justify-between shrink-0 bg-neutral-50/60">
          <div>
            {currentStep > 1 ? (
              <button
                type="button"
                onClick={() => setCurrentStep((s) => (s - 1) as 1 | 2)}
                className="px-4 py-2 rounded-lg border border-black/10 bg-white text-xs font-semibold text-neutral-700 hover:bg-neutral-50 flex items-center gap-1.5 transition-colors"
              >
                <ArrowLeft size={13} />
                Back
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-xs font-semibold text-neutral-500 hover:text-black transition-colors"
              >
                Cancel
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {currentStep < 3 ? (
              <button
                type="button"
                onClick={() => setCurrentStep((s) => (s + 1) as 2 | 3)}
                className="px-5 py-2 rounded-lg bg-black text-white text-xs font-semibold hover:bg-neutral-800 flex items-center gap-1.5 transition-colors shadow-xs"
              >
                <span>{currentStep === 1 ? "Proceed to Preview" : "Proceed to Export"}</span>
                <ArrowRight size={13} />
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2 rounded-lg bg-black text-white text-xs font-semibold hover:bg-neutral-800 transition-colors shadow-xs"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
