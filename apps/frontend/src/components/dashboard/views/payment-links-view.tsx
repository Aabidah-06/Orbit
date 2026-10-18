"use client";
import { useEffect, useState } from "react";
import { ORBIT_API_URL, merchantRequestHeaders } from "@/lib/api";
import { CreatePaymentLinkModal, type HostedLink } from "../modals/create-payment-link-modal";

export function PaymentLinksView({ businessName }: { businessName: string }) {
  const [links, setLinks] = useState<HostedLink[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${ORBIT_API_URL}/payment-links`, { headers: merchantRequestHeaders(), signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("Could not load payment links. Verify merchant API key."); return response.json(); })
      .then((data: { links: HostedLink[] }) => setLinks(data.links))
      .catch(reason => { if (reason.name !== "AbortError") setError(reason.message); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);
  return <section className="space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-bold">Payment Links</h2><p className="text-sm text-neutral-600">Share customized checkout links for {businessName}.</p></div><button onClick={() => setCreating(true)} className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white">Create link</button></header>
    <label className="block text-sm">Search links<input className="mt-1 block w-full max-w-sm rounded border p-2" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name" /></label>
    {loading && <p role="status">Loading payment links…</p>}{error && <p role="alert" className="text-red-700">{error}</p>}
    <div className="overflow-x-auto rounded-lg border border-black/10 bg-white"><table className="w-full text-left text-sm"><thead className="bg-neutral-100"><tr><th className="p-3">Checkout</th><th className="p-3">Plan</th><th className="p-3">Status</th><th className="p-3">Share</th></tr></thead><tbody>{links.filter(link => link.title.toLowerCase().includes(search.toLowerCase())).map(link => { const url = typeof window !== "undefined" ? `${window.location.origin}/pay/${link.id}` : `/pay/${link.id}`;return <tr key={link.id} className="border-t"><td className="p-3 font-semibold">{link.title}</td><td className="p-3">{link.plans?.name || link.plan_id}</td><td className="p-3">{link.active ? "Active" : "Disabled"}</td><td className="p-3"><button className="rounded border px-3 py-1" onClick={() => void navigator.clipboard.writeText(url)}>Copy URL</button></td></tr>;})}</tbody></table>{!loading && links.length === 0 && <p className="p-6 text-center text-neutral-600">No saved payment links. Create one to get started.</p>}</div>
    <CreatePaymentLinkModal isOpen={creating} onClose={() => setCreating(false)} onCreateLink={link => setLinks(prev => [link, ...prev])} />
  </section>;
}
