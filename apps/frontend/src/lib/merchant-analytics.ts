import { ORBIT_API_URL } from "@/lib/api";

export type AnalyticsRange = "7D" | "30D" | "90D" | "1Y";
export interface AnalyticsDay {
  date: string; // UTC YYYY-MM-DD
  amount_usdc_units: string; // exact decimal integer, 7-decimal USDC units
}
export interface MerchantAnalytics {
  range: AnalyticsRange;
  period_start: string;
  period_end: string;
  active_subscribers: number;
  new_subscribers: number;
  previous_new_subscribers: number;
  mrr_usdc_units: string;
  mrr_incomplete: boolean;
  settled_volume_usdc_units: string;
  period_settled_usdc_units: string;
  points: AnalyticsDay[];
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, ORBIT_API_URL), {
    cache: "no-store", ...init,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(typeof result?.error === "string" ? result.error : `Analytics request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function getAnalyticsChallenge(wallet: string) {
  return jsonRequest<{ challenge_id: string; message: string }>("/analytics/challenge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet_address: wallet }),
  });
}
export function verifyAnalyticsSignature(challengeId: string, signature: string) {
  return jsonRequest<{ token: string; expires_in_seconds: number }>("/analytics/session", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge_id: challengeId, signature }),
  });
}
export function fetchMerchantAnalytics(token: string, range: AnalyticsRange, signal?: AbortSignal) {
  return jsonRequest<MerchantAnalytics>(`/analytics/overview?range=${range}`, {
    headers: { Authorization: `Bearer ${token}` }, signal,
  });
}

// Keep exact amounts as integers until the final display boundary.
export function formatRawUsdc(value: string | undefined): string {
  if (value === undefined || !/^-?\d+$/.test(value)) return "—";
  const units = BigInt(value), negative = units < 0n;
  const cents = ((negative ? -units : units) + 50_000n) / 100_000n;
  return `${negative ? "-" : ""}${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")}`;
}

export interface PlotPoint { date: string; x: number; y: number; amount: number; units: string; }
export function plotVerifiedRevenue(points: AnalyticsDay[], start: string, end: string): PlotPoint[] {
  const byDay = new Map(points.map(p => [p.date, p.amount_usdc_units]));
  const startDay = Math.floor(Date.parse(start) / 86400000);
  const lastDay = Math.floor((Date.parse(end) - 1) / 86400000);
  if (!Number.isFinite(startDay) || !Number.isFinite(lastDay) || lastDay < startDay) return [];
  const days = Math.min(lastDay - startDay + 1, 366);
  const amounts = Array.from({ length: days }, (_, i) => {
    const date = new Date((startDay + i) * 86400000).toISOString().slice(0, 10);
    const units = byDay.get(date) || "0";
    // Visualization only; never use floats for accounting totals.
    const amount = Number(units) / 10_000_000;
    return { date, units, amount: Number.isFinite(amount) && amount >= 0 ? amount : 0 };
  });
  const maximum = Math.max(1, ...amounts.map(item => item.amount));
  return amounts.map((item, i) => ({
    ...item,
    x: 20 + (days === 1 ? 180 : (i / (days - 1)) * 360),
    y: 140 - (item.amount / maximum) * 125,
  }));
}
