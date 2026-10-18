"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
export type ThemePreference = "light" | "dark" | "system";
const KEY = "orbit_dashboard_theme";
const ThemeContext = createContext<{ theme: ThemePreference; setTheme: (value: ThemePreference) => void } | null>(null);
export function DashboardThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeValue] = useState<ThemePreference>("system");
  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark" || saved === "system") setThemeValue(saved);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const isDark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  const setTheme = (value: ThemePreference) => {
    setThemeValue(value);
    try { localStorage.setItem(KEY, value); } catch { /* preference is optional */ }
  };
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}
export function useDashboardTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useDashboardTheme requires DashboardThemeProvider");
  return context;
}
