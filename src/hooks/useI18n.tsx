import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSettings } from "./useSettings";

interface TranslationDictionary {
  [key: string]: string | TranslationDictionary;
}

type TranslationParams = Record<string, string | number>;

export interface LocaleDefinition {
  code: string;
  label: string;
  file: string;
  aliases?: string[];
}

interface I18nConfig {
  defaultLocale: string;
  fallbackLocale?: string;
  locales: LocaleDefinition[];
}

interface I18nContextType {
  locale: string;
  availableLocales: LocaleDefinition[];
  isLoading: boolean;
  t: (key: string, params?: TranslationParams, fallback?: string) => string;
}

const DEFAULT_I18N_CONFIG: I18nConfig = {
  defaultLocale: "en-US",
  fallbackLocale: "en-US",
  locales: [
    {
      code: "en-US",
      label: "English (US)",
      file: "/i18n/locales/en-US.json",
      aliases: ["en"],
    },
    {
      code: "zh-CN",
      label: "简体中文",
      file: "/i18n/locales/zh-CN.json",
      aliases: ["zh", "zh-Hans", "zh-SG"],
    },
  ],
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);
const translationCache = new Map<string, TranslationDictionary>();

function normalizeLocale(locale: string | null | undefined): string {
  return (locale ?? "").trim().toLowerCase();
}

function getBrowserLocaleCandidates(): string[] {
  if (typeof navigator === "undefined") return [];

  const rawLocales = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];

  const candidates = new Set<string>();

  for (const locale of rawLocales) {
    if (!locale) continue;
    candidates.add(locale);

    const base = locale.split("-")[0];
    if (base) {
      candidates.add(base);
    }
  }

  return Array.from(candidates);
}

function matchesLocale(locale: string, candidate: string, aliases: string[] = []): boolean {
  const normalizedLocale = normalizeLocale(locale);
  const normalizedCandidate = normalizeLocale(candidate);

  if (!normalizedLocale || !normalizedCandidate) return false;
  if (normalizedLocale === normalizedCandidate) return true;

  const localeBase = normalizedLocale.split("-")[0];
  const candidateBase = normalizedCandidate.split("-")[0];
  if (localeBase && localeBase === candidateBase) return true;

  return aliases.some((alias) => {
    const normalizedAlias = normalizeLocale(alias);
    return normalizedAlias === normalizedCandidate || normalizedAlias.split("-")[0] === candidateBase;
  });
}

function findLocaleDefinition(config: I18nConfig, requested: string[]): LocaleDefinition {
  for (const candidate of requested) {
    const match = config.locales.find((locale) => matchesLocale(locale.code, candidate, locale.aliases));
    if (match) {
      return match;
    }
  }

  return (
    config.locales.find((locale) => normalizeLocale(locale.code) === normalizeLocale(config.defaultLocale))
    ?? config.locales[0]
  );
}

function getMessage(messages: TranslationDictionary | null, key: string): string | undefined {
  if (!messages) return undefined;

  const value = key.split(".").reduce<string | TranslationDictionary | undefined>((current, part) => {
    if (!current || typeof current === "string") return undefined;
    return current[part];
  }, messages);

  return typeof value === "string" ? value : undefined;
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? `{${key}}`));
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function loadMessages(locale: LocaleDefinition): Promise<TranslationDictionary> {
  const cacheKey = `${locale.code}:${locale.file}`;
  const cached = translationCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const messages = await fetchJson<TranslationDictionary>(locale.file);
  translationCache.set(cacheKey, messages);
  return messages;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [config, setConfig] = useState<I18nConfig>(DEFAULT_I18N_CONFIG);
  const [locale, setLocale] = useState(DEFAULT_I18N_CONFIG.defaultLocale);
  const [messages, setMessages] = useState<TranslationDictionary | null>(null);
  const [fallbackMessages, setFallbackMessages] = useState<TranslationDictionary | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      try {
        const nextConfig = await fetchJson<I18nConfig>("/i18n/config.json");
        if (!cancelled) {
          setConfig(nextConfig);
        }
      } catch (error) {
        console.warn("Failed to load i18n config, using defaults.", error);
      }
    };

    loadConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadLocaleResources = async () => {
      setIsLoading(true);

      const requestedLocales = settings.language === "system"
        ? getBrowserLocaleCandidates()
        : [settings.language];

      const resolvedLocale = findLocaleDefinition(config, requestedLocales);
      const fallbackLocale = findLocaleDefinition(config, [config.fallbackLocale ?? config.defaultLocale]);

      try {
        const [primaryMessages, nextFallbackMessages] = await Promise.all([
          loadMessages(resolvedLocale),
          loadMessages(fallbackLocale),
        ]);

        if (cancelled) return;

        setLocale(resolvedLocale.code);
        setMessages(primaryMessages);
        setFallbackMessages(nextFallbackMessages);
      } catch (error) {
        console.error("Failed to load locale resources.", error);

        if (cancelled) return;

        setLocale(fallbackLocale.code);
        setMessages(null);
        setFallbackMessages(null);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadLocaleResources();

    return () => {
      cancelled = true;
    };
  }, [config, settings.language]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback((key: string, params?: TranslationParams, fallback?: string) => {
    const template = getMessage(messages, key) ?? getMessage(fallbackMessages, key) ?? fallback ?? key;
    return interpolate(template, params);
  }, [fallbackMessages, messages]);

  const value = useMemo<I18nContextType>(() => ({
    locale,
    availableLocales: config.locales,
    isLoading,
    t,
  }), [config.locales, isLoading, locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (context === undefined) {
    throw new Error("useI18n must be used within an I18nProvider");
  }

  return context;
}
