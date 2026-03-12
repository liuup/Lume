import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface Setting {
  key: string;
  value: string;
}

export type AppTheme = 'light' | 'dark' | 'auto';

export interface AppSettings {
  theme: AppTheme;
  language: string;
  defaultPdfZoom: string;
  autoRenamePdf: boolean;
  renamePattern: string;
  defaultCitationFormat: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'auto',
  language: 'system',
  defaultPdfZoom: 'page-fit',
  autoRenamePdf: true,
  renamePattern: '[Year] - [Author] - [Title]',
  defaultCitationFormat: 'apa',
};

function normalizeTheme(value: string | undefined): AppTheme {
  if (value === 'dark' || value === 'light' || value === 'auto') {
    return value;
  }

  if (value === 'system') {
    return 'auto';
  }

  return DEFAULT_SETTINGS.theme;
}

function resolveTheme(theme: AppTheme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'auto') {
    return prefersDark ? 'dark' : 'light';
  }

  return theme;
}

interface SettingsContextType {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  isLoading: boolean;
  resolvedTheme: 'light' | 'dark';
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    async function loadSettings() {
      try {
        const storedSettings = await invoke<Setting[]>("get_settings");
        const loaded: Partial<AppSettings> = {};
        
        for (const s of storedSettings) {
           if (s.key === 'autoRenamePdf') {
             loaded[s.key] = s.value === 'true';
           } else if (s.key === 'theme') {
             loaded.theme = normalizeTheme(s.value);
           } else {
             loaded[s.key as keyof AppSettings] = s.value as any;
           }
        }
        
        setSettings(prev => ({ ...prev, ...loaded }));
      } catch (err) {
        console.error("Failed to load settings:", err);
      } finally {
        setIsLoading(false);
      }
    }
    loadSettings();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = () => {
      const nextResolvedTheme = resolveTheme(settings.theme, mediaQuery.matches);
      const root = document.documentElement;

      root.classList.toggle('dark', nextResolvedTheme === 'dark');
      root.dataset.theme = settings.theme;
      root.style.colorScheme = nextResolvedTheme;
      setResolvedTheme(nextResolvedTheme);
    };

    applyTheme();

    const handleSystemThemeChange = () => {
      if (settings.theme === 'auto') {
        applyTheme();
      }
    };

    mediaQuery.addEventListener('change', handleSystemThemeChange);
    return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
  }, [settings.theme]);

  const updateSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const stringValue = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    
    // Update local state optimistically
    setSettings(prev => ({ ...prev, [key]: value }));
    
    // Persist to backend
    try {
      await invoke("save_setting", { key: String(key), value: stringValue });
    } catch (err) {
      console.error(`Failed to save setting ${String(key)}:`, err);
    }
  };

  return (
    <SettingsContext.Provider value={{ settings, updateSetting, isLoading, resolvedTheme }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
}
