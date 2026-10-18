"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  Check,
  Copy,
  Globe2,
  Link2,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { CustomDomain } from "../dashboard-types";
import { useAuth } from "@/lib/auth-context";
import {
  CNAME_TARGET,
  SSL_STATE_META,
  SLUG_PLAN_OPTIONS,
  advanceDomain,
  buildVanityUrl,
  createDomain,
  hostnameError,
  normalizeHostname,
  slugError,
} from "@/lib/domains";

const SEED_DOMAINS: CustomDomain[] = [
  {
    id: "dom_seed_pay",
    hostname: "pay.acme.store",
    cnameTarget: CNAME_TARGET,
    txtName: "_orbit-verify.pay.acme.store",
    txtValue: "orbit-verify=9f1c2d4a6b8e0f135792468acebdf024",
    verificationToken: "9f1c2d4a6b8e0f135792468acebdf024",
    sslState: "active",
    verificationChecks: 3,
    vanitySlugs: [
      {
        id: "slug_pro",
        slug: "pro",
        planId: "plan_mailkit_pro",
        planName: "MailKit Pro",
        createdAt: "2026-10-10T12:00:00Z",
      },
    ],
    createdAt: "2026-10-09T09:00:00Z",
    lastCheckedAt: "2026-10-16T18:20:00Z",
  },
];

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="rounded-lg border border-black/10 bg-neutral-50/70 p-2.5">
      <div className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">{label}</div>
      <div className="flex items-center gap-2 mt-1">
        <code className="flex-1 min-w-0 truncate font-mono text-[11px] text-neutral-800">{value}</code>
        <button onClick={copy} className="p-1 rounded hover:bg-black/5 text-neutral-400 hover:text-black transition-colors" title={`Copy ${label}`}>
          {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}

export function DomainsView() {
  const { user } = useAuth();
  const storageKey = user?.id ? `orbit_domains:${user.id}` : null;

  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newHostname, setNewHostname] = useState("");
  const [hostError, setHostError] = useState("");
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [slugDrafts, setSlugDrafts] = useState<Record<string, { slug: string; planId: string }>>({});
  const [slugErrors, setSlugErrors] = useState<Record<string, string>>({});

  // Load persisted domains (or the seeded example) once per merchant.
  useEffect(() => {
    if (!storageKey) {
      setDomains(SEED_DOMAINS);
      setLoaded(true);
      return;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      setDomains(raw ? (JSON.parse(raw) as CustomDomain[]) : SEED_DOMAINS);
    } catch {
      setDomains(SEED_DOMAINS);
    }
    setLoaded(true);
  }, [storageKey]);

  useEffect(() => {
    if (!loaded || !storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(domains));
    } catch {
      // storage unavailable; keep in-memory state
    }
  }, [domains, loaded, storageKey]);

  // Poll DNS verification for every domain that has not settled yet.
  useEffect(() => {
    const timer = setInterval(() => {
      setDomains((previous) => {
        const hasPending = previous.some(
          (domain) => domain.sslState === "pending_dns" || domain.sslState === "issuing"
        );
        if (!hasPending) return previous;
        return previous.map((domain) =>
          domain.sslState === "pending_dns" || domain.sslState === "issuing"
            ? advanceDomain(domain)
            : domain
        );
      });
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const stats = useMemo(() => {
    const active = domains.filter((domain) => domain.sslState === "active").length;
    const slugs = domains.reduce((acc, domain) => acc + domain.vanitySlugs.length, 0);
    return { active, slugs };
  }, [domains]);

  const handleAddDomain = (event: React.FormEvent) => {
    event.preventDefault();
    const error = hostnameError(newHostname);
    if (error) {
      setHostError(error);
      return;
    }
    const clean = normalizeHostname(newHostname);
    if (domains.some((domain) => domain.hostname === clean)) {
      setHostError("That domain is already registered.");
      return;
    }
    setDomains((previous) => [createDomain(clean), ...previous]);
    setNewHostname("");
    setHostError("");
    setShowForm(false);
  };

  const verifyNow = useCallback((id: string) => {
    setCheckingId(id);
    setDomains((previous) => previous.map((domain) => (domain.id === id ? advanceDomain(domain) : domain)));
    setTimeout(() => setCheckingId(null), 700);
  }, []);

  const removeDomain = (id: string) => {
    setDomains((previous) => previous.filter((domain) => domain.id !== id));
  };

  const addSlug = (domain: CustomDomain) => {
    const draft = slugDrafts[domain.id] ?? { slug: "", planId: SLUG_PLAN_OPTIONS[0].id };
    const error = slugError(draft.slug, domain.vanitySlugs);
    if (error) {
      setSlugErrors((previous) => ({ ...previous, [domain.id]: error }));
      return;
    }
    const plan = SLUG_PLAN_OPTIONS.find((option) => option.id === draft.planId) ?? SLUG_PLAN_OPTIONS[0];
    const slug = draft.slug.trim().toLowerCase().replace(/^\/+/, "");
    setDomains((previous) =>
      previous.map((item) =>
        item.id === domain.id
          ? {
              ...item,
              vanitySlugs: [
                ...item.vanitySlugs,
                {
                  id: `slug_${Math.random().toString(36).slice(2, 9)}`,
                  slug,
                  planId: plan.id,
                  planName: plan.name,
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : item
      )
    );
    setSlugDrafts((previous) => ({ ...previous, [domain.id]: { slug: "", planId: draft.planId } }));
    setSlugErrors((previous) => ({ ...previous, [domain.id]: "" }));
  };

  const removeSlug = (domainId: string, slugId: string) => {
    setDomains((previous) =>
      previous.map((domain) =>
        domain.id === domainId
          ? { ...domain, vanitySlugs: domain.vanitySlugs.filter((slug) => slug.id !== slugId) }
          : domain
      )
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-black">Custom Domains &amp; SSL</h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Serve white-labeled checkout links on your own branded subdomains with automatic TLS.
          </p>
        </div>
        <button
          onClick={() => setShowForm((value) => !value)}
          className="button button-primary text-xs h-9 px-4 flex items-center gap-2 self-start sm:self-auto shrink-0"
        >
          <Plus size={15} />
          <span>Add Domain</span>
        </button>
      </div>

      {/* Add domain form */}
      {showForm && (
        <form onSubmit={handleAddDomain} className="rounded-xl border border-black/15 bg-white p-5 space-y-3 shadow-xs animate-in fade-in duration-150">
          <label htmlFor="domain-hostname" className="block text-xs font-semibold text-black uppercase tracking-wider">
            Custom domain or subdomain
          </label>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Globe2 size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                id="domain-hostname"
                type="text"
                autoFocus
                placeholder="pay.merchant.com"
                value={newHostname}
                onChange={(event) => {
                  setNewHostname(event.target.value);
                  setHostError("");
                }}
                className="w-full rounded-lg border border-black/10 pl-9 pr-3.5 py-2.5 text-xs font-mono text-black focus:outline-hidden focus:ring-1 focus:ring-black"
              />
            </div>
            <button type="submit" className="button button-primary text-xs h-10 px-5 flex items-center justify-center gap-1.5">
              <span>Register domain</span>
              <ArrowRight size={13} />
            </button>
          </div>
          {hostError ? (
            <p role="alert" className="text-[11px] text-red-700 flex items-center gap-1.5">
              <AlertCircle size={12} /> {hostError}
            </p>
          ) : (
            <p className="text-[11px] text-neutral-500">
              We will give you a CNAME and a TXT verification record to add at your DNS provider.
            </p>
          )}
        </form>
      )}

      {/* Summary ribbon */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Registered domains</div>
          <div className="text-2xl font-bold text-black mt-1">{domains.length}</div>
          <div className="text-xs text-neutral-500 mt-0.5">Across all your storefronts</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">SSL active</div>
          <div className={`text-2xl font-bold mt-1 ${stats.active > 0 ? "text-emerald-600" : "text-black"}`}>{stats.active}</div>
          <div className="text-xs text-neutral-500 mt-0.5 flex items-center gap-1.5">
            <Lock size={11} /> Auto-issued certificates
          </div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-black/10 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Vanity slugs</div>
          <div className="text-2xl font-bold text-black mt-1">{stats.slugs}</div>
          <div className="text-xs text-neutral-500 mt-0.5">Mapped to active plans</div>
        </div>
      </div>

      {/* Domain list */}
      {domains.length === 0 ? (
        <div className="rounded-xl border border-black/10 bg-white py-16 text-center">
          <div className="w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 flex items-center justify-center mx-auto mb-3">
            <Globe2 size={22} />
          </div>
          <h4 className="font-semibold text-black text-sm">No custom domains yet</h4>
          <p className="text-xs text-neutral-500 max-w-sm mx-auto mt-1 leading-relaxed">
            Register a branded subdomain to host your payment links under your own name.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {domains.map((domain) => {
            const meta = SSL_STATE_META[domain.sslState];
            const draft = slugDrafts[domain.id] ?? { slug: "", planId: SLUG_PLAN_OPTIONS[0].id };
            return (
              <div key={domain.id} className="rounded-xl border border-black/10 bg-white shadow-xs overflow-hidden">
                <div className="p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-lg bg-black/5 flex items-center justify-center text-black shrink-0">
                        <Globe2 size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-bold text-black font-mono truncate">{domain.hostname}</h3>
                          <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border ${meta.className}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot} ${domain.sslState === "issuing" ? "animate-pulse" : ""}`} />
                            {meta.label}
                          </span>
                        </div>
                        <div className="text-[11px] text-neutral-400 mt-0.5">
                          {domain.lastCheckedAt
                            ? `Last checked ${new Date(domain.lastCheckedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                            : "Awaiting first verification poll"}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => verifyNow(domain.id)}
                        disabled={checkingId === domain.id || domain.sslState === "active"}
                        className="button button-secondary text-xs h-8 px-3 flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {checkingId === domain.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        <span>Check now</span>
                      </button>
                      <button
                        onClick={() => removeDomain(domain.id)}
                        className="p-1.5 rounded text-neutral-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        title="Remove domain"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {domain.error && (
                    <div role="alert" className="rounded-lg bg-red-50 border border-red-200 p-3 text-[11px] text-red-800 flex items-start gap-2">
                      <AlertCircle size={14} className="text-red-600 shrink-0 mt-0.5" />
                      <span>{domain.error}</span>
                    </div>
                  )}

                  {/* DNS instructions */}
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                      <ShieldCheck size={12} /> DNS records to add
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                      <CopyField label="Type" value="CNAME" />
                      <CopyField label="Name" value={domain.hostname} />
                      <CopyField label="Value" value={domain.cnameTarget} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mt-2.5">
                      <CopyField label="TXT name" value={domain.txtName} />
                      <CopyField label="TXT value" value={domain.txtValue} />
                    </div>
                  </div>

                  {/* Vanity slugs */}
                  <div className="pt-3 border-t border-black/5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                      <Link2 size={12} /> Vanity payment slugs
                    </div>
                    {domain.vanitySlugs.length > 0 ? (
                      <div className="space-y-2">
                        {domain.vanitySlugs.map((slug) => (
                          <div key={slug.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-black/10 px-3 py-2">
                            <BadgeCheck size={14} className="text-emerald-600 shrink-0" />
                            <code className="font-mono text-[11px] text-black font-semibold">/{slug.slug}</code>
                            <span className="text-[11px] text-neutral-400">→ {slug.planName}</span>
                            <code className="text-[11px] text-neutral-500 truncate flex-1 min-w-0">{buildVanityUrl(domain.hostname, slug.slug)}</code>
                            <button onClick={() => removeSlug(domain.id, slug.id)} className="p-1 rounded text-neutral-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="Remove slug">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-neutral-500">No slugs yet. Map one to a plan below.</p>
                    )}

                    <div className="flex flex-col sm:flex-row gap-2.5 mt-3">
                      <div className="relative flex-1">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 font-mono text-xs">/</span>
                        <input
                          type="text"
                          placeholder="pro"
                          value={draft.slug}
                          onChange={(event) =>
                            setSlugDrafts((previous) => ({ ...previous, [domain.id]: { ...draft, slug: event.target.value } }))
                          }
                          className="w-full rounded-lg border border-black/10 pl-6 pr-3 py-2 text-xs font-mono text-black focus:outline-hidden focus:ring-1 focus:ring-black"
                        />
                      </div>
                      <select
                        value={draft.planId}
                        onChange={(event) =>
                          setSlugDrafts((previous) => ({ ...previous, [domain.id]: { ...draft, planId: event.target.value } }))
                        }
                        className="rounded-lg border border-black/10 px-3 py-2 text-xs text-black bg-white focus:outline-hidden focus:ring-1 focus:ring-black"
                      >
                        {SLUG_PLAN_OPTIONS.map((plan) => (
                          <option key={plan.id} value={plan.id}>
                            {plan.name} · {plan.amount} USDC
                          </option>
                        ))}
                      </select>
                      <button onClick={() => addSlug(domain)} className="button button-secondary text-xs h-9 px-4 flex items-center justify-center gap-1.5">
                        <Plus size={13} /> Map slug
                      </button>
                    </div>
                    {slugErrors[domain.id] && (
                      <p role="alert" className="text-[11px] text-red-700 mt-1.5 flex items-center gap-1.5">
                        <AlertCircle size={12} /> {slugErrors[domain.id]}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
