"use client";
import { useFiatRates, type FiatCurrency } from "@/lib/fiat-rates";

type Props = { amount: number; currency?: FiatCurrency; className?: string; compact?: boolean };
export function PriceDisplay({ amount, currency: override, className, compact = false }: Props) {
  const { currency: preferred, rates, loading, error, updatedAt } = useFiatRates();
  const currency = override || preferred;
  const amountValid = Number.isFinite(amount);
  const fiat = amountValid && rates ? amount * rates[currency] : null;
  return <span className={className} title={fiat === null ? error || (loading ? "Loading live conversion" : "Exchange rate unavailable") : `Estimated using USDC rates at ${new Date(updatedAt || 0).toLocaleString()}`}>
    {amountValid ? amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"} USDC
    {fiat !== null && <span className="text-neutral-600 dark:text-neutral-300"> {compact ? "≈" : "(≈"}{new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: currency === "JPY" ? 0 : 2 }).format(fiat)}{compact ? "" : ")"}</span>}
    {!rates && <span className="sr-only"> Fiat estimate unavailable</span>}
  </span>;
}
