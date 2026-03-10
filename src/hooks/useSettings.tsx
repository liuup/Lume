import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface Setting {
  key: string;
  value: string;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  defaultPdfZoom: string;
  autoRenamePdf: boolean;
  renamePattern: string;
  defaultCitationFormat: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  defaultPdfZoom: 'page-fit',
  autoRenamePdf: true,
  renamePattern: '[Year] - [Author] - [Title]',
  defaultCitationFormat: 'apa',
};

interface SettingsContextType {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  isLoading: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadSettings() {
      try {
        const storedSettings = await invoke<Setting[]>("get_settings");
        const loaded: Partial<AppSettings> = {};
        
        for (const s of storedSettings) {
           if (s.key === 'autoRenamePdf') {
             loaded[s.key] = s.value === 'true';
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
    <SettingsContext.Provider value={{ settings, updateSetting, isLoading }}>
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
