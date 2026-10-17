import type { PayrollRecipient } from "../components/dashboard/dashboard-types";

export type Contractor = Pick<PayrollRecipient, "name" | "role" | "walletAddress" | "amount">;
const SCALE = 10_000_000n;

export function parsePayrollAmount(value: string): number | null {
  if (!/^\d+(\.\d{1,7})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(7, "0"));
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const amount = Number(units) / Number(SCALE);
  const roundTrip = Math.round(amount * Number(SCALE));
  if (!Number.isSafeInteger(roundTrip) || BigInt(roundTrip) !== units) return null;
  return amount;
}

export function duplicateWallets(recipients: PayrollRecipient[]) {
  const counts = new Map<string, number>();
  for (const recipient of recipients) if (recipient.status === "ready") {
    counts.set(recipient.walletAddress, (counts.get(recipient.walletAddress) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([wallet]) => wallet));
}

export function mergeDuplicateRecipients(recipients: PayrollRecipient[]) {
  const merged = new Map<string, PayrollRecipient>();
  for (const recipient of recipients) {
    const key = recipient.status === "ready" ? recipient.walletAddress : recipient.id;
    const existing = merged.get(key);
    if (!existing) { merged.set(key, { ...recipient }); continue; }
    const units = BigInt(Math.round(existing.amount * Number(SCALE))) + BigInt(Math.round(recipient.amount * Number(SCALE)));
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Merged payout exceeds the supported amount. Split it into separate batches.");
    const amount = Number(units) / Number(SCALE);
    if (!Number.isSafeInteger(Math.round(amount * Number(SCALE))) || BigInt(Math.round(amount * Number(SCALE))) !== units) {
      throw new Error("Merged payout cannot be represented precisely. Split it into separate batches.");
    }
    merged.set(key, { ...existing, amount });
  }
  return [...merged.values()];
}

export function filterAndSortRecipients(recipients: PayrollRecipient[], search: string, column: "amount" | "name", direction: "asc" | "desc") {
  const query = search.trim().toLowerCase();
  return recipients.filter((row) => !query || row.name.toLowerCase().includes(query) || row.walletAddress.toLowerCase().includes(query))
    .sort((a, b) => (column === "amount" ? a.amount - b.amount : a.name.localeCompare(b.name)) * (direction === "asc" ? 1 : -1));
}
