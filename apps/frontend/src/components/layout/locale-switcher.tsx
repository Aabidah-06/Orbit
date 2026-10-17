"use client";

import { Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { LOCALE_LABELS, isLocale, locales } from "@/i18n/config";
import { useLocaleSwitcher } from "@/i18n/provider";

export function LocaleSwitcher({ className = "" }: { className?: string }) {
  const t = useTranslations("Locale");
  const { locale, setLocale } = useLocaleSwitcher();

  return (
    <label
      className={`inline-flex items-center gap-1.5 text-xs text-neutral-600 hover:text-black transition-colors ${className}`}
    >
      <Globe size={14} aria-hidden="true" />
      <span className="sr-only">{t("label")}</span>
      <select
        value={locale}
        onChange={(e) => isLocale(e.target.value) && setLocale(e.target.value)}
        className="bg-transparent text-xs font-medium cursor-pointer focus:outline-hidden focus-visible:ring-1 focus-visible:ring-black rounded"
        data-testid="locale-switcher"
      >
        {locales.map((code) => (
          <option key={code} value={code}>
            {LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
