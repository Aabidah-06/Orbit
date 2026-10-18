"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type FiatCurrency = "USD" | "EUR" | "GBP" | "JPY";
type Rates = Record<FiatCurrency, number>;
type FiatContextValue = { currency: FiatCurrency; setCurrency: (value: FiatCurrency) => void; rates: Rates | null; updatedAt: number | null; error: string | null; loading: boolean };
const PREFERENCE_KEY = "orbit_fiat_currency";
const RATES_KEY = "orbit_fiat_rates_v1";
const TTL = 5 * 60 * 1000;
const FiatContext = createContext<FiatContextValue | null>(null);
const validCurrencies: FiatCurrency[] = ["USD", "EUR", "GBP", "JPY"];

export function FiatRatesProvider({ children }: { children: ReactNode }) {
  const [currency, setPreferredCurrency] = useState<FiatCurrency>("USD");
  const [rates, setRates] = useState<Rates | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(PREFERENCE_KEY) as FiatCurrency | null;
      if (saved && validCurrencies.includes(saved)) setPreferredCurrency(saved);
      const cached = JSON.parse(localStorage.getItem(RATES_KEY) || "null") as { rates: Rates; timestamp: number } | null;
      if (cached && Number.isFinite(cached.timestamp) && validCurrencies.every(key => Number.isFinite(cached.rates[key]) && cached.rates[key] > 0)) {
        setRates(cached.rates);
        setUpdatedAt(cached.timestamp);
      }
    } catch { /* Invalid cache is ignored. */ }
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const cached = JSON.parse(localStorage.getItem(RATES_KEY) || "null") as { rates: Rates; timestamp: number } | null;
        if (cached && Date.now() - cached.timestamp < TTL) {
          if (alive) { setRates(cached.rates); setUpdatedAt(cached.timestamp); setLoading(false); }
          return;
        }
        const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd,eur,gbp,jpy", { cache: "no-store" });
        if (!response.ok) throw new Error("Exchange rate service unavailable");
        const data = await response.json() as { "usd-coin"?: Record<string, number> };
        const values = data["usd-coin"];
        if (!values) throw new Error("Missing USDC rates");
        const next: Rates = { USD: values.usd, EUR: values.eur, GBP: values.gbp, JPY: values.jpy };
        if (!validCurrencies.every(key => Number.isFinite(next[key]) && next[key] > 0)) throw new Error("Invalid exchange rates");
        const timestamp = Date.now();
        if (!alive) return;
        setRates(next); setUpdatedAt(timestamp); setError(null);
        try { localStorage.setItem(RATES_KEY, JSON.stringify({ rates: next, timestamp })); } catch { /* optional cache */ }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Unable to load exchange rates");
      } finally { if (alive) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, TTL);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const setCurrency = (value: FiatCurrency) => {
    if (!validCurrencies.includes(value)) return;
    setPreferredCurrency(value);
    try { localStorage.setItem(PREFERENCE_KEY, value); } catch { /* optional preference */ }
  };

  return <FiatContext.Provider value={{ currency, setCurrency, rates, updatedAt, error, loading }}>{children}</FiatContext.Provider>;
}

export function useFiatRates() {
  const context = useContext(FiatContext);
  if (!context) throw new Error("useFiatRates must be used within FiatRatesProvider");
  return context;
}
