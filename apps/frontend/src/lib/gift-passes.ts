import type { GiftPass } from "@/components/dashboard/dashboard-types";

export interface GiftPlanOption {
  id: string;
  name: string;
  monthlyAmount: number;
}

export const GIFT_PLAN_OPTIONS: GiftPlanOption[] = [
  { id: "plan_mailkit_pro", name: "MailKit Pro", monthlyAmount: 29 },
  { id: "plan_ai_starter", name: "AI Engine Starter", monthlyAmount: 15 },
  { id: "plan_dao_retainer", name: "DAO Builder Pass", monthlyAmount: 100 },
];

export interface GiftDurationOption {
  months: number;
  label: string;
  badge?: string;
}

export const GIFT_DURATION_OPTIONS: GiftDurationOption[] = [
  { months: 3, label: "3 months" },
  { months: 6, label: "6 months" },
  { months: 12, label: "1 year", badge: "Best value" },
];

/** Quantity is capped so a single wizard run stays within one ledger batch. */
export const MAX_PASS_QUANTITY = 100;

const CLAIM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomChunk(length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += CLAIM_CODE_ALPHABET[Math.floor(Math.random() * CLAIM_CODE_ALPHABET.length)];
  }
  return out;
}

export function generateClaimCode(): string {
  return `ORB-${randomChunk(4)}-${randomChunk(4)}`;
}

export function totalPassPrice(monthlyAmount: number, months: number, quantity: number): number {
  return Math.round(monthlyAmount * months * quantity * 100) / 100;
}

/** Pre-paid passes never expire sooner than 12 months from issuance. */
export function passExpiry(months: number, from: Date = new Date()): string {
  const expiry = new Date(from);
  expiry.setUTCMonth(expiry.getUTCMonth() + Math.max(months, 12));
  return expiry.toISOString();
}

export function buildClaimUrl(code: string, origin?: string): string {
  const base = origin || "https://orbit.network";
  return `${base.replace(/\/$/, "")}/claim/${code}`;
}

export function createGiftPasses(input: {
  plan: GiftPlanOption;
  months: number;
  quantity: number;
  origin?: string;
}): GiftPass[] {
  const { plan, months, quantity, origin } = input;
  const now = new Date();
  return Array.from({ length: quantity }, () => {
    const code = generateClaimCode();
    return {
      id: `gift_${Math.random().toString(36).slice(2, 10)}`,
      code,
      claimUrl: buildClaimUrl(code, origin),
      planId: plan.id,
      planName: plan.name,
      monthlyAmount: plan.monthlyAmount,
      months,
      amount: Math.round(plan.monthlyAmount * months * 100) / 100,
      state: "unclaimed" as const,
      createdAt: now.toISOString(),
      expiresAt: passExpiry(months, now),
    };
  });
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => {
    switch (character) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}

/**
 * Builds an SVG redemption card for a pass and triggers a download. Rendered as
 * SVG so it stays crisp and dependency-free, and can be dropped into a welcome
 * email or printed by the recipient.
 */
export function downloadRedemptionCard(pass: GiftPass, merchantName: string): void {
  const duration = pass.months === 12 ? "1 year" : `${pass.months} months`;
  const expires = new Date(pass.expiresAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif">
  <rect width="640" height="360" rx="24" fill="#09090b"/>
  <rect x="24" y="24" width="592" height="312" rx="16" fill="none" stroke="#26262b" stroke-width="2"/>
  <text x="56" y="86" fill="#a1a1aa" font-size="15" letter-spacing="4">ORBIT PRE-PAID PASS</text>
  <text x="56" y="140" fill="#ffffff" font-size="34" font-weight="700">${escapeXml(pass.planName)}</text>
  <text x="56" y="178" fill="#d4d4d8" font-size="20">${escapeXml(duration)} subscription</text>
  <text x="56" y="252" fill="#a1a1aa" font-size="14" letter-spacing="3">CLAIM CODE</text>
  <text x="56" y="292" fill="#ffffff" font-size="32" font-weight="700" font-family="ui-monospace, Menlo, monospace">${escapeXml(pass.code)}</text>
  <text x="56" y="326" fill="#71717a" font-size="14">Issued by ${escapeXml(merchantName || "Orbit merchant")} · Redeem by ${expires}</text>
  <circle cx="556" cy="292" r="34" fill="#ffffff"/>
  <text x="556" y="300" fill="#09090b" font-size="20" font-weight="700" text-anchor="middle">O</text>
</svg>`;
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `orbit-pass-${pass.code}.svg`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
