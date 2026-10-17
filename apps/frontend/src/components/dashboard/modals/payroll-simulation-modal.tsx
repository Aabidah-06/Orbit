"use client";

import {
  AlertTriangle,
  Bug,
  Cpu,
  Fuel,
  Gauge,
  Loader2,
  Network,
  ShieldCheck,
  ShieldX,
  Wallet,
  X,
} from "lucide-react";
import type { PayrollSimulationResult } from "../dashboard-types";

interface PayrollSimulationModalProps {
  isOpen: boolean;
  isLoading: boolean;
  result: PayrollSimulationResult | null;
  onClose: () => void;
}

const CHECK_BADGE: Record<"pass" | "warning" | "fail", string> = {
  pass: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warning: "bg-amber-50 text-amber-800 border-amber-200",
  fail: "bg-red-50 text-red-700 border-red-200",
};

function CheckPill({ state, label }: { state: "pass" | "warning" | "fail"; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border ${CHECK_BADGE[state]}`}>
      {state === "pass" ? <ShieldCheck size={11} /> : <ShieldX size={11} />}
      {label}
    </span>
  );
}

export function PayrollSimulationModal({ isOpen, isLoading, result, onClose }: PayrollSimulationModalProps) {
  if (!isOpen) return null;

  const cpuPct = result ? Math.min(100, (result.cpuInstructions / result.maxCpuInstructions) * 100) : 0;
  const issues = result ? result.checks.filter((check) => check.trustline !== "pass" || check.allowance !== "pass") : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="w-full max-w-3xl max-h-[90vh] rounded-xl bg-white border border-black/10 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-black/10 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center text-black">
              <Bug size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-black tracking-tight">Payroll Dry-Run Simulation</h3>
              <p className="text-xs text-neutral-500">
                Pre-flight the <code className="font-mono text-[11px]">batch_disburse</code> envelope without signing.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-black hover:bg-neutral-100 transition-colors"
            aria-label="Close simulation"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto">
          {isLoading && (
            <div className="py-16 flex flex-col items-center gap-3 text-neutral-500">
              <Loader2 size={28} className="animate-spin text-black" />
              <p className="text-xs">Building the full batch envelope and simulating against Soroban RPC…</p>
              <p className="text-[11px] text-neutral-400">No wallet signature is requested during a dry run.</p>
            </div>
          )}

          {!isLoading && result && (
            <div className="space-y-5">
              {/* Source note */}
              <div
                className={`p-3.5 rounded-xl text-xs flex items-start gap-2.5 border ${
                  result.source === "rpc"
                    ? "bg-emerald-50 border-emerald-200 text-emerald-950"
                    : "bg-amber-50 border-amber-200 text-amber-900"
                }`}
              >
                {result.source === "rpc" ? (
                  <Network size={16} className="text-emerald-600 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                )}
                <div>
                  <span className="font-semibold">
                    {result.source === "rpc" ? "Simulated on Soroban testnet" : "Local pre-flight estimate"}
                  </span>
                  {" — "}
                  {result.source === "rpc"
                    ? "resource fees, CPU and footprint come straight from the RPC simulation."
                    : result.error || "Live simulation unavailable; figures are deterministic estimates."}
                </div>
              </div>

              {/* Primary metrics */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="p-4 rounded-xl bg-white border border-black/10">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 flex items-center gap-1">
                    <Fuel size={11} /> Network fee
                  </div>
                  <div className="text-xl font-bold text-black mt-1 font-mono">{result.feeXlm.toFixed(7)}</div>
                  <div className="text-[10px] text-neutral-400">XLM (inclusion + resource)</div>
                </div>
                <div className="p-4 rounded-xl bg-white border border-black/10">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 flex items-center gap-1">
                    <Wallet size={11} /> Total payout
                  </div>
                  <div className="text-xl font-bold text-black mt-1 font-mono">
                    {result.totalUsdc.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </div>
                  <div className="text-[10px] text-neutral-400">USDC to {result.recipientCount} recipients</div>
                </div>
                <div className="p-4 rounded-xl bg-white border border-black/10">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 flex items-center gap-1">
                    <Cpu size={11} /> CPU instructions
                  </div>
                  <div className="text-xl font-bold text-black mt-1 font-mono">
                    {(result.cpuInstructions / 1_000_000).toFixed(2)}M
                  </div>
                  <div className="text-[10px] text-neutral-400">of {result.maxCpuInstructions / 1_000_000}M limit</div>
                  <div className="h-1.5 w-full rounded-full bg-neutral-100 overflow-hidden mt-2">
                    <div className={`h-full rounded-full ${cpuPct > 80 ? "bg-red-500" : cpuPct > 50 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${cpuPct}%` }} />
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-white border border-black/10">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 flex items-center gap-1">
                    <Gauge size={11} /> Footprint
                  </div>
                  <div className="text-xl font-bold text-black mt-1 font-mono">
                    {result.footprintReads}<span className="text-sm text-neutral-400">r</span> /{" "}
                    {result.footprintWrites}<span className="text-sm text-neutral-400">w</span>
                  </div>
                  <div className="text-[10px] text-neutral-400">{result.transactionSizeBytes} bytes envelope</div>
                </div>
              </div>

              {/* Safety warnings */}
              {result.warnings.length > 0 ? (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                    <AlertTriangle size={15} /> Safety warnings ({result.warnings.length})
                  </div>
                  <ul className="mt-2 list-disc list-inside space-y-1 text-xs text-amber-900">
                    {result.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex items-center gap-2.5 text-xs text-emerald-950">
                  <ShieldCheck size={16} className="text-emerald-600" />
                  <span>All recipients verified: trustlines initialized and allowances cover the batch.</span>
                </div>
              )}

              {/* Recipient verification */}
              <div className="rounded-xl border border-black/10 overflow-hidden">
                <div className="px-4 py-3 border-b border-black/10 flex items-center justify-between">
                  <span className="text-xs font-bold text-black">Recipient verification</span>
                  <span className="text-[10px] font-mono text-neutral-400">
                    {result.checks.length - issues.length}/{result.checks.length} clean
                  </span>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-neutral-50/80 text-neutral-500 uppercase tracking-wider font-semibold text-[10px] sticky top-0">
                      <tr>
                        <th className="py-2.5 px-4">Recipient</th>
                        <th className="py-2.5 px-4">Trustline</th>
                        <th className="py-2.5 px-4">Allowance</th>
                        <th className="py-2.5 px-4">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/5">
                      {result.checks.map((check) => (
                        <tr key={check.id} className={check.trustline !== "pass" || check.allowance !== "pass" ? "bg-amber-50/40" : ""}>
                          <td className="py-2.5 px-4">
                            <div className="font-semibold text-black">{check.name}</div>
                            <div className="font-mono text-[10px] text-neutral-400">
                              {check.walletAddress.slice(0, 6)}…{check.walletAddress.slice(-6)} · {check.amount.toFixed(2)} USDC
                            </div>
                          </td>
                          <td className="py-2.5 px-4">
                            <CheckPill state={check.trustline} label={check.trustline === "pass" ? "INITIALIZED" : "MISSING"} />
                          </td>
                          <td className="py-2.5 px-4">
                            <CheckPill state={check.allowance} label={check.allowance === "pass" ? "OK" : "LOW"} />
                          </td>
                          <td className="py-2.5 px-4 text-[11px] text-neutral-500">{check.message ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Secondary details */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px]">
                <div className="rounded-lg bg-neutral-50 border border-black/5 p-3">
                  <div className="text-neutral-400 uppercase tracking-wider text-[10px]">Min resource fee</div>
                  <div className="font-mono text-black mt-0.5">{result.minResourceFee} stroops</div>
                </div>
                <div className="rounded-lg bg-neutral-50 border border-black/5 p-3">
                  <div className="text-neutral-400 uppercase tracking-wider text-[10px]">Merchant allowance</div>
                  <div className="font-mono text-black mt-0.5">{result.merchantAllowance.toLocaleString("en-US")} USDC</div>
                </div>
                <div className="rounded-lg bg-neutral-50 border border-black/5 p-3">
                  <div className="text-neutral-400 uppercase tracking-wider text-[10px]">Latest ledger</div>
                  <div className="font-mono text-black mt-0.5">{result.latestLedger > 0 ? result.latestLedger : "—"}</div>
                </div>
              </div>

              <p className="text-[11px] text-neutral-400">
                Simulated {new Date(result.simulatedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.
                A dry run never prompts for a signature and cannot move funds.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-black/10 flex items-center justify-end shrink-0">
          <button onClick={onClose} className="button button-primary text-xs h-9 px-5">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
