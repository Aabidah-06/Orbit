import type { CustomDomain, DomainSslState, VanitySlug } from "@/components/dashboard/dashboard-types";
import { hashString } from "@/lib/utils";

export const CNAME_TARGET = "cname.orbit.network";
export const ROOT_DOMAIN = "orbit.network";

/** Number of DNS polls that must succeed before a certificate is issued. */
export const REQUIRED_VERIFICATION_CHECKS = 3;

/** Plans a vanity slug can be mapped to (mirrors the sample plan catalog). */
export const SLUG_PLAN_OPTIONS = [
  { id: "plan_mailkit_pro", name: "MailKit Pro", amount: 29 },
  { id: "plan_ai_starter", name: "AI Engine Starter", amount: 15 },
  { id: "plan_dao_retainer", name: "DAO Builder Pass", amount: 100 },
];

const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "dashboard",
  "pay",
  "checkout",
  "docs",
  "signin",
  "signup",
  "get-started",
  "pricing",
  "_next",
  "www",
]);

const HOSTNAME_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** Normalises user input: trims, lowercases and strips scheme/path/trailing dots. */
export function normalizeHostname(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.+$/, "");
}

export function hostnameError(input: string): string | null {
  const hostname = normalizeHostname(input);
  if (!hostname) return "Enter a domain or subdomain.";
  if (hostname.length > 253) return "That hostname is too long.";
  if (hostname.includes(" ")) return "Hostnames cannot contain spaces.";
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return "Enter a valid hostname such as pay.merchant.com.";
  }
  if (hostname.endsWith(`.${ROOT_DOMAIN}`) || hostname === ROOT_DOMAIN) {
    return `${ROOT_DOMAIN} is reserved for Orbit.`;
  }
  return null;
}

export function slugError(slug: string, existing: VanitySlug[]): string | null {
  const value = slug.trim().toLowerCase().replace(/^\/+/, "");
  if (!value) return "Enter a slug.";
  if (RESERVED_SLUGS.has(value)) return `"${value}" is reserved.`;
  if (!SLUG_PATTERN.test(value)) {
    return "Use lowercase letters, numbers and hyphens (max 30 characters).";
  }
  if (existing.some((item) => item.slug === value)) return "That slug is already mapped.";
  return null;
}

export function buildVanityUrl(hostname: string, slug: string): string {
  return `https://${hostname}/${slug.replace(/^\/+/, "")}`;
}

function verificationToken(hostname: string): string {
  const seed = hashString(hostname).toString(16).padStart(8, "0");
  const salt = hashString(`orbit:${hostname}`).toString(16).padStart(8, "0");
  return `${seed}${salt}`.repeat(2).slice(0, 32);
}

export function createDomain(hostname: string): CustomDomain {
  const clean = normalizeHostname(hostname);
  const token = verificationToken(clean);
  return {
    id: `dom_${Math.random().toString(36).slice(2, 9)}`,
    hostname: clean,
    cnameTarget: CNAME_TARGET,
    txtName: `_orbit-verify.${clean}`,
    txtValue: `orbit-verify=${token}`,
    verificationToken: token,
    sslState: "pending_dns",
    vanitySlugs: [],
    createdAt: new Date().toISOString(),
    verificationChecks: 0,
  };
}

/** Deterministic DNS/SSL state for a given number of successful polls. */
export function deriveDomainState(hostname: string, checks: number): DomainSslState {
  if (checks <= 0) return "pending_dns";
  // A small, stable slice of hostnames never propagate so the error state is
  // exercised without a backend.
  if (hashString(hostname) % 13 === 0 && checks >= 2) return "error";
  if (checks >= REQUIRED_VERIFICATION_CHECKS) return "active";
  if (checks >= REQUIRED_VERIFICATION_CHECKS - 1) return "issuing";
  return "pending_dns";
}

/** Advances a domain by one verification poll. */
export function advanceDomain(domain: CustomDomain): CustomDomain {
  const settled = domain.sslState === "active" || domain.sslState === "error";
  const checks = settled ? domain.verificationChecks : domain.verificationChecks + 1;
  return {
    ...domain,
    verificationChecks: checks,
    sslState: deriveDomainState(domain.hostname, checks),
    lastCheckedAt: new Date().toISOString(),
    error:
      deriveDomainState(domain.hostname, checks) === "error"
        ? "CNAME record was not found. Confirm the record is saved with no proxy enabled."
        : undefined,
  };
}

export const SSL_STATE_META: Record<
  DomainSslState,
  { label: string; className: string; dot: string }
> = {
  active: {
    label: "SSL active",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  issuing: {
    label: "Issuing certificate",
    className: "bg-indigo-50 text-indigo-700 border-indigo-200",
    dot: "bg-indigo-500",
  },
  pending_dns: {
    label: "Pending DNS",
    className: "bg-amber-50 text-amber-800 border-amber-200",
    dot: "bg-amber-500",
  },
  error: {
    label: "Error",
    className: "bg-red-50 text-red-700 border-red-200",
    dot: "bg-red-500",
  },
};
