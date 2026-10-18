"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Gift,
  Loader2,
  Radio,
  Sparkles,
  Ticket,
  Trash2,
  Wallet,
} from "lucide-react";
import type { GiftPass } from "../dashboard-types";
import { useAuth } from "@/lib/auth-context";
import {
  GIFT_DURATION_OPTIONS,
  GIFT_PLAN_OPTIONS,
  MAX_PASS_QUANTITY,
  createGiftPasses,
  downloadRedemptionCard,
  totalPassPrice,
} from "@/lib/gift-passes";

const CLAIM_META: Record<GiftPass["state"], { label: string; className: string; dot: string }> = {
  unclaimed: {
    label: "Unclaimed",
    className: "bg-amber-50 text-amber-800 border-amber-200",
    dot: "bg-amber-500",
  },
  claimed: {
    label: "Claimed",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  expired: {
    label: "Expired",
    className: "bg-neutral-100 text-neutral-500 border-black/10",
    dot: "bg-neutral-400",
  },
};

function durationLabel(months: number): string {
  return months === 12 ? "1 year" : `${months} months`;
}

export function GiftPassesView() {
  const { user } = useAuth();
  const merchantName = user?.businessName || "Orbit merchant";
  const storageKey = user?.id ? `orbit_passes:${user.id}` : null;

  const [passes, setPasses] = useState<GiftPass[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [planId, setPlanId] = useState(GIFT_PLAN_OPTIONS[0].id);
  const [months, setMonths] = useState(GIFT_DURATION_OPTIONS[0].months);
  const [quantity, setQuantity] = useState(5);
  const [isPaying, setIsPaying] = useState(false);
  const [liveRedemptions, setLiveRedemptions] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [banner, setBanner] = useState("");

  const plan = GIFT_PLAN_OPTIONS.find((option) => option.id === planId) ?? GIFT_PLAN_OPTIONS[0];
  const total = totalPassPrice(plan.monthlyAmount, months, quantity);

  // Load persisted passes once per merchant.
  useEffect(() => {
    if (!storageKey) {
      setLoaded(true);
      return;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as GiftPass[];
        setPasses(parsed);
        if (parsed.length > 0) setStep(3);
      }
    } catch {
      // ignore malformed storage
    }
    setLoaded(true);
  }, [storageKey]);

  useEffect(() => {
    if (!loaded || !storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(passes));
    } catch {
      // storage unavailable
    }
  }, [passes, loaded, storageKey]);

  const markClaimed = useCallback((id?: string) => {
    setPasses((previous) => {
      const target =
        (id && previous.find((item) => item.id === id && item.state === "unclaimed")) ||
        previous.find((item) => item.state === "unclaimed");
      if (!target) return previous;
      return previous.map((item) =>
        item.id === target.id
          ? {
              ...item,
              state: "claimed" as const,
              claimedAt: new Date().toISOString(),
              claimedBy: "G" + Math.random().toString(36).toUpperCase().slice(2, 10) + "…",
            }
          : item
      );
    });
  }, []);

  // Simulated live redemption feed for the demo.
  useEffect(() => {
    if (!liveRedemptions) return;
    const timer = setInterval(() => markClaimed(), 8000);
    return () => clearInterval(timer);
  }, [liveRedemptions, markClaimed]);

  const stats = useMemo(() => {
    const claimed = passes.filter((pass) => pass.state === "claimed").length;
    const unclaimed = passes.filter((pass) => pass.state === "unclaimed").length;
    const value = passes.reduce((acc, pass) => acc + pass.amount, 0);
    return { claimed, unclaimed, value };
  }, [passes]);

  const handleGenerate = () => {
    setIsPaying(true);
    setBanner("");
    // Collect the one-time pre-paid payment, then mint the claim links.
    setTimeout(() => {
      const origin = typeof window !== "undefined" ? window.location.origin : undefined;
      const created = createGiftPasses({ plan, months, quantity, origin });
      setPasses((previous) => [...created, ...previous]);
      setIsPaying(false);
      setStep(3);
      setBanner(
        `${quantity} pre-paid ${quantity === 1 ? "pass" : "passes"} generated. A one-time payment of ${total.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC was collected.`
      );
    }, 1300);
  };

  const copyLink = (pass: GiftPass) => {
    navigator.clipboard.writeText(pass.claimUrl);
    setCopiedKey(pass.id);
    setTimeout(() => setCopiedKey(null), 1600);
  };

  const removePass = (id: string) => {
    setPasses((previous) => previous.filter((pass) => pass.id !== id));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight text-black">Gift Links &amp; Pre-paid Passes</h2>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-black text-white font-bold tracking-wide">
              ONE-TIME
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-0.5">
            Sell pre-paid subscription passes a sponsor can gift or redeem without recurring billing friction.
          </p>
        </div>

        {step === 3 && (
          <button
            onClick={() => setStep(1)}
            className="button button-primary text-xs h-9 px-4 flex items-center gap-2 self-start sm:self-auto shrink-0"
          >
            <Sparkles size={14} />
            <span>New Pass Batch</span>
          </button>
        )}
      </div>

      {banner && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 flex items-start gap-3">
          <CheckCircle2 size={18} className="text-emerald-600 shrink-0 mt-0.5" />
          <span>{banner}</span>
        </div>
      )}

      {/* Summary ribbon */}
      {passes.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Passes generated</div>
            <div className="text-2xl font-bold text-black mt-1">{passes.length}</div>
          </div>
          <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Claimed</div>
            <div className="text-2xl font-bold text-emerald-600 mt-1">{stats.claimed}</div>
          </div>
          <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Unclaimed</div>
            <div className="text-2xl font-bold text-amber-600 mt-1">{stats.unclaimed}</div>
          </div>
          <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Pre-paid value</div>
            <div className="text-2xl font-bold text-black mt-1">
              {stats.value.toLocaleString("en-US", { minimumFractionDigits: 2 })}
              <span className="text-xs font-mono text-neutral-400"> USDC</span>
            </div>
          </div>
        </div>
      )}

      {/* Wizard (steps 1 & 2) */}
      {step !== 3 && (
        <div className="rounded-xl border border-black/10 bg-white shadow-xs overflow-hidden">
          {/* Step indicator */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-black/10">
            {[1, 2].map((index) => (
              <div key={index} className="flex items-center gap-2">
                <span
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
                    step === index ? "bg-black text-white" : step > index ? "bg-emerald-500 text-white" : "bg-neutral-100 text-neutral-500"
                  }`}
                >
                  {step > index ? <Check size={12} /> : index}
                </span>
                <span className={`text-xs font-semibold ${step === index ? "text-black" : "text-neutral-400"}`}>
                  {index === 1 ? "Configure pass" : "Review & pay"}
                </span>
                {index === 1 && <span className="w-8 h-px bg-black/10" />}
              </div>
            ))}
          </div>

          {step === 1 && (
            <div className="p-5 space-y-5">
              <div>
                <label className="block text-xs font-semibold text-black uppercase tracking-wider mb-2">Plan</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {GIFT_PLAN_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      onClick={() => setPlanId(option.id)}
                      className={`p-3.5 rounded-lg border text-left transition-all ${
                        planId === option.id ? "border-black bg-neutral-50 ring-1 ring-black/5" : "border-black/10 hover:bg-neutral-50"
                      }`}
                    >
                      <div className="font-bold text-xs text-black">{option.name}</div>
                      <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">{option.monthlyAmount} USDC / month</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-black uppercase tracking-wider mb-2">Pre-paid duration</label>
                <div className="flex flex-wrap gap-3">
                  {GIFT_DURATION_OPTIONS.map((option) => (
                    <button
                      key={option.months}
                      onClick={() => setMonths(option.months)}
                      className={`px-4 py-2.5 rounded-lg border text-xs font-semibold transition-all flex items-center gap-2 ${
                        months === option.months ? "border-black bg-black text-white" : "border-black/10 text-neutral-600 hover:bg-neutral-50"
                      }`}
                    >
                      {option.label}
                      {option.badge && (
                        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${months === option.months ? "bg-white/20" : "bg-emerald-50 text-emerald-700"}`}>
                          {option.badge}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="pass-quantity" className="block text-xs font-semibold text-black uppercase tracking-wider mb-2">
                    Quantity of claim codes
                  </label>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setQuantity((value) => Math.max(1, value - 1))} className="button button-secondary text-sm h-10 w-10 justify-center">
                      −
                    </button>
                    <input
                      id="pass-quantity"
                      type="number"
                      min={1}
                      max={MAX_PASS_QUANTITY}
                      value={quantity}
                      onChange={(event) =>
                        setQuantity(Math.min(MAX_PASS_QUANTITY, Math.max(1, Number(event.target.value) || 1)))
                      }
                      className="w-24 rounded-lg border border-black/10 px-3 py-2.5 text-xs font-mono text-black text-center focus:outline-hidden focus:ring-1 focus:ring-black"
                    />
                    <button onClick={() => setQuantity((value) => Math.min(MAX_PASS_QUANTITY, value + 1))} className="button button-secondary text-sm h-10 w-10 justify-center">
                      +
                    </button>
                    <span className="text-[11px] text-neutral-400">max {MAX_PASS_QUANTITY}</span>
                  </div>
                </div>

                <div className="p-3.5 rounded-lg bg-neutral-50 border border-black/5">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Total one-time payment</div>
                  <div className="text-2xl font-bold text-black mt-1 font-mono">
                    {total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    <span className="text-sm text-neutral-400"> USDC</span>
                  </div>
                  <div className="text-[11px] text-neutral-500 mt-0.5">
                    {plan.monthlyAmount} × {durationLabel(months)} × {quantity}
                  </div>
                </div>
              </div>

              <div className="flex justify-end pt-2 border-t border-black/10">
                <button onClick={() => setStep(2)} className="button button-primary text-xs h-9 px-5 mt-3">
                  Review order
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="p-5 space-y-5">
              <div className="rounded-xl border border-black/10 p-4 flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-black/5 flex items-center justify-center text-black shrink-0">
                  <Ticket size={16} />
                </div>
                <div className="flex-1 text-xs">
                  <div className="font-bold text-black text-sm">{plan.name}</div>
                  <div className="text-neutral-500 mt-0.5">
                    {quantity} × {durationLabel(months)} pre-paid pass
                  </div>
                  <div className="font-mono text-neutral-500 mt-0.5">
                    {plan.monthlyAmount} USDC / month · {months * plan.monthlyAmount} USDC per pass
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">Total</div>
                  <div className="text-lg font-bold text-black font-mono">
                    {total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </div>
                </div>
              </div>

              <div className="p-3.5 rounded-lg bg-neutral-50 border border-black/5 text-xs text-neutral-600 flex items-start gap-2.5">
                <Wallet size={16} className="text-black shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-black">One-time settlement:</span> the full pre-paid amount is
                  collected once. Claimed passes provision access with no recurring billing or allowance vault.
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 pt-3 border-t border-black/10">
                <button onClick={() => setStep(1)} className="button button-secondary text-xs h-9 px-4">
                  Back
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={isPaying}
                  className="button button-primary text-xs h-9 px-5 flex items-center gap-2 disabled:opacity-60"
                >
                  {isPaying ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>Collecting payment…</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} />
                      <span>Pay {total.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC &amp; generate</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Claim link management */}
      {step === 3 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <Gift size={14} className="text-black" />
              <span>{passes.length} claim {passes.length === 1 ? "link" : "links"}</span>
            </div>
            <button
              onClick={() => setLiveRedemptions((value) => !value)}
              className={`button text-xs h-8 px-3 flex items-center gap-1.5 ${liveRedemptions ? "button-primary" : "button-secondary"}`}
              aria-pressed={liveRedemptions}
            >
              <Radio size={12} className={liveRedemptions ? "animate-pulse" : ""} />
              <span>{liveRedemptions ? "Live redemptions on" : "Simulate live redemptions"}</span>
            </button>
          </div>

          <div className="rounded-xl border border-black/10 bg-white overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-neutral-50/80 border-b border-black/10 text-neutral-500 uppercase tracking-wider font-semibold text-[10px]">
                  <tr>
                    <th className="py-3.5 px-5">Claim code</th>
                    <th className="py-3.5 px-4">Plan</th>
                    <th className="py-3.5 px-4">Duration</th>
                    <th className="py-3.5 px-4">Value</th>
                    <th className="py-3.5 px-4">Status</th>
                    <th className="py-3.5 px-5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 text-neutral-700">
                  {passes.map((pass) => {
                    const meta = CLAIM_META[pass.state];
                    return (
                      <tr key={pass.id} className="hover:bg-neutral-50/50 transition-colors">
                        <td className="py-4 px-5">
                          <div className="font-mono font-bold text-black text-xs">{pass.code}</div>
                          <div className="text-[10px] text-neutral-400 font-mono truncate max-w-[220px]">{pass.claimUrl}</div>
                        </td>
                        <td className="py-4 px-4 text-neutral-600">{pass.planName}</td>
                        <td className="py-4 px-4 text-neutral-600">{durationLabel(pass.months)}</td>
                        <td className="py-4 px-4 font-mono font-semibold text-black">
                          {pass.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC
                        </td>
                        <td className="py-4 px-4">
                          <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border ${meta.className}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                            {meta.label}
                          </span>
                          {pass.claimedAt && (
                            <div className="text-[10px] text-neutral-400 mt-1">
                              {new Date(pass.claimedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                              {pass.claimedBy ? ` · ${pass.claimedBy}` : ""}
                            </div>
                          )}
                        </td>
                        <td className="py-4 px-5">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => copyLink(pass)}
                              className="button button-secondary text-[11px] h-7 px-2.5 flex items-center gap-1"
                            >
                              {copiedKey === pass.id ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                              Copy link
                            </button>
                            <button
                              onClick={() => downloadRedemptionCard(pass, merchantName)}
                              className="p-1.5 rounded text-neutral-400 hover:text-black hover:bg-black/5 transition-colors"
                              title="Download redemption card"
                            >
                              <Download size={14} />
                            </button>
                            {pass.state === "unclaimed" && (
                              <button
                                onClick={() => markClaimed(pass.id)}
                                className="p-1.5 rounded text-neutral-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                                title="Mark claimed (simulate redemption)"
                              >
                                <BadgeCheck size={14} />
                              </button>
                            )}
                            <button
                              onClick={() => removePass(pass.id)}
                              className="p-1.5 rounded text-neutral-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                              title="Delete pass"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {passes.length === 0 && (
              <div className="py-16 text-center">
                <div className="w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 flex items-center justify-center mx-auto mb-3">
                  <Clock size={22} />
                </div>
                <h4 className="font-semibold text-black text-sm">No passes yet</h4>
                <p className="text-xs text-neutral-500 mt-1">Generate a batch to start issuing claim links.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
