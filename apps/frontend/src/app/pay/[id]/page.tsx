"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink, Lock, ShieldCheck, Wallet } from "lucide-react";
import { Brand } from "@/components/layout/brand";
import { connectFreighter } from "@/lib/freighter";
import { ORBIT_API_URL } from "@/lib/api";
import { createCheckoutVault } from "@/lib/checkout-soroban";

interface Plan {
  id: string; name: string; description?: string; usdc_amount: number; interval_seconds: number;
  active?: boolean; type?: "recurring" | "one_time"; return_url?: string; merchants: { name: string; wallet_address: string; active?: boolean };
}

export default function HostedCheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [processing, setProcessing] = useState(false);
  const [txHash, setTxHash] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${ORBIT_API_URL}/plans/${id}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) { setNotFound(true); return null; }
        if (!response.ok) throw new Error("This checkout could not be loaded.");
        return response.json();
      })
      .then((data) => data?.plan && setPlan(data.plan))
      .catch((reason) => reason.name !== "AbortError" && setError(reason.message))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [id]);

  const connect = async () => {
    setError(""); const result = await connectFreighter();
    if (result.ok) setAddress(result.address); else setError(result.error);
  };

  const authorize = async () => {
    if (!plan) return;
    setProcessing(true); setError("");
    try {
      const recurring = plan.type !== "one_time";
      const result = await createCheckoutVault({ address, merchant: plan.merchants.wallet_address,
        amount: Number(plan.usdc_amount), interval: Number(plan.interval_seconds), cycles: recurring ? 12 : 1 });
      const response = await fetch(`${ORBIT_API_URL}/subscriptions`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: plan.id, customer_wallet_address: address }) });
      if (!response.ok) throw new Error((await response.json()).error || "The subscription could not be recorded.");
      setTxHash(result.vaultHash);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Authorization failed."); }
    finally { setProcessing(false); }
  };

  if (loading) return <main className="min-h-screen grid place-items-center">Loading secure checkout…</main>;
  if (notFound || !plan || plan.active === false || plan.merchants?.active === false) return <main className="min-h-screen grid place-items-center p-6"><div className="text-center"><h1 className="text-2xl font-bold">Checkout unavailable</h1><p className="mt-2 text-neutral-500">This payment link does not exist or is no longer active.</p></div></main>;
  const recurring = plan.type !== "one_time";
  const amount = Number(plan.usdc_amount) / 10_000_000;

  return <div className="min-h-screen bg-[#fafafb] text-[#09090b]">
    <header className="h-16 px-6 sm:px-12 border-b border-black/10 bg-white flex items-center justify-between"><Brand variant="black" /><div className="flex items-center gap-2 text-xs text-neutral-600"><Lock size={13} /> Soroban secured</div></header>
    <main className="p-5 sm:p-10 grid place-items-center"><section className="w-full max-w-lg bg-white border border-black/10 rounded-2xl shadow-xl overflow-hidden">
      <div className="p-6 border-b bg-neutral-50"><p className="text-[10px] uppercase tracking-wider text-neutral-400">Merchant</p><h1 className="font-bold">{plan.merchants.name}</h1></div>
      <div className="p-7 space-y-6">
        {txHash ? <div className="text-center space-y-4"><CheckCircle2 className="mx-auto text-emerald-600" size={52} /><h2 className="text-xl font-bold">Authorization confirmed</h2><p className="text-sm text-neutral-500">Your {recurring ? "recurring vault" : "one-time allowance"} is active on Stellar testnet.</p><a className="button button-primary inline-flex gap-2" target="_blank" rel="noreferrer" href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}>View transaction <ExternalLink size={14} /></a><br/><Link className="text-sm underline" href={plan.return_url || "/"}>Return to merchant</Link></div> : <>
          <div><h2 className="text-xl font-bold">{plan.name}</h2><p className="text-sm text-neutral-500 mt-1">{plan.description || "Non-custodial payment authorization on Stellar."}</p></div>
          <div className="flex justify-between items-end border-y py-4"><span className="text-xs uppercase text-neutral-500">{recurring ? "Recurring subscription" : "One-time payment"}</span><strong className="font-mono text-2xl">${amount.toFixed(2)} USDC</strong></div>
          <div className="p-4 rounded-xl bg-neutral-50 text-xs text-neutral-600"><p className="font-bold text-black flex gap-2"><ShieldCheck size={16} className="text-emerald-600" /> Non-custodial authorization</p><p className="mt-2">You approve the token allowance and create the vault in your wallet before Orbit records the subscription.</p></div>
          {!address ? <button onClick={connect} className="button button-primary w-full h-12 flex items-center justify-center gap-2"><Wallet size={16}/> Connect Freighter</button> : <><p className="text-xs text-neutral-500">Connected: <span className="font-mono text-black">{address.slice(0, 8)}…{address.slice(-5)}</span></p><button disabled={processing} onClick={authorize} className="button button-primary w-full h-12">{processing ? "Confirm both wallet transactions…" : "Approve & activate vault"}</button></>}
          {error && <p role="alert" className="text-sm text-red-600 text-center">{error}</p>}
        </>}
      </div></section></main>
  </div>;
}
