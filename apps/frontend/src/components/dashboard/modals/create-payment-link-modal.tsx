"use client";
import { useEffect, useState, type FormEvent } from "react";
import { ORBIT_API_URL, merchantRequestHeaders } from "@/lib/api";

interface Plan { id: string; name: string; usdc_amount: number; interval_seconds: number; currency?: string }
export interface HostedLink { id: string; plan_id: string; title: string; cta_text: string; accent_color: string; redirect_url: string | null; collect_email: boolean; collect_discord: boolean; active: boolean; plans?: Plan }
interface Props { isOpen: boolean; onClose: () => void; onCreateLink: (link: HostedLink) => void; }

export function CreatePaymentLinkModal({ isOpen, onClose, onCreateLink }: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planId, setPlanId] = useState("");
  const [title, setTitle] = useState("");
  const [cta, setCta] = useState("Pay with USDC");
  const [accent, setAccent] = useState("#111827");
  const [redirect, setRedirect] = useState("");
  const [email, setEmail] = useState(false);
  const [discord, setDiscord] = useState(false);
  const [mode, setMode] = useState<"desktop" | "mobile">("desktop");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<HostedLink | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    fetch(`${ORBIT_API_URL}/payment-links/plans`, { headers: merchantRequestHeaders(), signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("Unable to load merchant plans. Connect a valid merchant API key."); return response.json(); })
      .then((data: { plans: Plan[] }) => { setPlans(data.plans); setPlanId(previous => previous || data.plans[0]?.id || ""); })
      .catch(reason => { if (reason.name !== "AbortError") setError(reason.message); });
    return () => controller.abort();
  }, [isOpen]);

  if (!isOpen) return null;
  const currentPlan = plans.find(p => p.id === planId);
  const url = created && typeof window !== "undefined" ? `${window.location.origin}/pay/${created.id}` : "";
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    if (!currentPlan) { setError("Select a valid existing plan."); return; }
    setWorking(true);
    try {
      const response = await fetch(`${ORBIT_API_URL}/payment-links`, { method: "POST", headers: merchantRequestHeaders(), body: JSON.stringify({
        plan_id: planId, title: title.trim(), cta_text: cta.trim(), accent_color: accent,
        redirect_url: redirect || null, collect_email: email, collect_discord: discord,
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save payment link");
      const link: HostedLink = { ...result.link, plans: currentPlan };
      onCreateLink(link); setCreated(link);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save link"); }
    finally { setWorking(false); }
  };

  const qrImage = (format: "png" | "svg") => `https://api.qrserver.com/v1/create-qr-code/?size=600x600&format=${format}&data=${encodeURIComponent(url)}`;
  const copy = (text: string) => void navigator.clipboard.writeText(text);
  return <div role="presentation" className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4">
    <div role="dialog" aria-modal="true" aria-labelledby="payment-link-title" className="mx-auto my-8 w-full max-w-4xl rounded-xl bg-white p-6 text-black shadow-xl" onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <div className="mb-5 flex justify-between gap-4"><h2 id="payment-link-title" className="text-xl font-bold">{created ? "Share payment link" : "Create branded checkout"}</h2><button type="button" onClick={onClose} aria-label="Close payment link wizard" className="rounded border px-3 py-1">Close</button></div>
      {created ? <div className="space-y-4">
        <p className="text-sm">Your link is saved on Orbit and ready to share.</p>
        <input readOnly value={url} aria-label="Hosted checkout URL" className="w-full rounded border p-3 font-mono text-xs" />
        <div className="flex flex-wrap gap-2"><button className="rounded bg-black px-4 py-2 text-white" onClick={() => copy(url)}>Copy URL</button><button className="rounded border px-4 py-2" onClick={() => copy(`<a href="${url}">Pay with Orbit</a>`)}>Copy embed snippet</button><a className="rounded border px-4 py-2" href={qrImage("svg")} download="orbit-checkout.svg" target="_blank" rel="noreferrer">Download SVG QR</a><a className="rounded border px-4 py-2" href={qrImage("png")} download="orbit-checkout.png" target="_blank" rel="noreferrer">Download PNG QR</a></div>
        {/* QR generation is delegated to a third party: only the publicly shareable URL is sent. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrImage("png")} width={160} height={160} alt="QR code for hosted checkout" />
      </div> : <div className="grid gap-6 md:grid-cols-2">
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm font-semibold">Linked plan<select required value={planId} onChange={e => setPlanId(e.target.value)} className="mt-1 block w-full rounded border p-2"><option value="">Select plan</option>{plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="block text-sm font-semibold">Checkout title<input required maxLength={140} value={title} onChange={e => setTitle(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
          <label className="block text-sm font-semibold">Button text<input required maxLength={80} value={cta} onChange={e => setCta(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
          <label className="block text-sm font-semibold">Brand accent color<input type="color" value={accent} onChange={e => setAccent(e.target.value)} className="ml-3 align-middle" /></label>
          <label className="block text-sm font-semibold">Completion redirect (HTTPS)<input type="url" pattern="https://.*" placeholder="https://example.com/thank-you" value={redirect} onChange={e => setRedirect(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={email} onChange={e => setEmail(e.target.checked)} />Collect customer email</label>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={discord} onChange={e => setDiscord(e.target.checked)} />Collect Discord handle</label>
          <button type="submit" disabled={working || !planId} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">{working ? "Saving…" : "Create payment link"}</button>
        </form>
        <section aria-label="Live checkout preview" className="rounded-lg bg-slate-100 p-4"><div className="mb-3 flex gap-2"><button type="button" onClick={() => setMode("desktop")} aria-pressed={mode === "desktop"} className="rounded border px-3 py-1 text-xs">Desktop</button><button type="button" onClick={() => setMode("mobile")} aria-pressed={mode === "mobile"} className="rounded border px-3 py-1 text-xs">Mobile</button></div><div className={`mx-auto rounded-lg bg-white p-6 shadow ${mode === "mobile" ? "max-w-[280px]" : "w-full"}`}><div className="mb-5 text-xs font-medium uppercase text-slate-500">Secure Orbit checkout</div><h3 className="text-xl font-bold">{title || "Your checkout title"}</h3><p className="my-4 text-sm">{currentPlan?.name || "Select a plan"} — {currentPlan ? (Number(currentPlan.usdc_amount) / 1e7).toFixed(2) : "0.00"} USDC</p>{email && <input disabled placeholder="Customer email" className="mb-2 block w-full rounded border p-2 text-xs" />}{discord && <input disabled placeholder="Discord handle" className="mb-2 block w-full rounded border p-2 text-xs" />}<button type="button" style={{ backgroundColor: accent }} className="w-full rounded p-3 font-semibold text-white">{cta || "Pay with USDC"}</button><p className="mt-3 text-center text-xs text-slate-500">Non-custodial Stellar payment</p></div></section>
      </div>}
      {error && <p role="alert" className="mt-4 rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    </div>
  </div>;
}
