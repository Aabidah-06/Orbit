import en from "./messages/en.json";
import es from "./messages/es.json";
import pt from "./messages/pt.json";
import fr from "./messages/fr.json";
import { Locale } from "./config";

export type Messages = typeof en;

type Dictionary = { [key: string]: string | Dictionary };

function isDictionary(value: unknown): value is Dictionary {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Overlay `override` on `base`, so any key missing from `override` keeps the base (English) text. */
function mergeWithFallback(base: Dictionary, override: Dictionary): Dictionary {
  const merged: Dictionary = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (isDictionary(value) && isDictionary(current)) {
      merged[key] = mergeWithFallback(current, value);
    } else if (value !== undefined && value !== "") {
      merged[key] = value;
    }
  }
  return merged;
}

const dictionaries: Record<Locale, Dictionary> = { en, es, pt, fr };

export function getMessages(locale: Locale): Messages {
  if (locale === "en") return en;
  return mergeWithFallback(en, dictionaries[locale]) as Messages;
}
