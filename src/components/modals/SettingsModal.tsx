import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  X, Moon, Sun, Monitor, Type, FileArchive, Settings, Bot, Languages, Palette, Info
} from "lucide-react";
import { AppTheme, useSettings } from "../../hooks/useSettings";
import { useI18n } from "../../hooks/useI18n";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type SettingsSection = "appearance" | "language" | "library" | "export" | "ai";

interface AboutInfo {
  name: string;
  version: string;
  repository: string;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { settings, updateSetting, isLoading, resolvedTheme } = useSettings();
  const { t, availableLocales, locale } = useI18n();
  const [activeSection, setActiveSection] = useState<SettingsSection | "about">("appearance");
  const [aboutInfo, setAboutInfo] = useState<AboutInfo>({
    name: "Lume",
    version: "0.1.0",
    repository: "https://github.com/liuup/Lume",
  });

  const themeOptions: { value: AppTheme; label: string }[] = [
    { value: "light", label: t("settings.theme.light") },
    { value: "dark", label: t("settings.theme.dark") },
    { value: "auto", label: t("settings.theme.auto") },
  ];
  const fontScaleOptions = [
    { value: "90", label: t("settings.fontScale.small") },
    { value: "100", label: t("settings.fontScale.medium") },
    { value: "110", label: t("settings.fontScale.large") },
    { value: "120", label: t("settings.fontScale.extraLarge") },
  ];

  const sections = useMemo(() => ([
    { id: "appearance" as const, label: t("settings.sections.appearance"), icon: Palette },
    { id: "language" as const, label: t("settings.sections.language"), icon: Languages },
    { id: "library" as const, label: t("settings.sections.library"), icon: FileArchive },
    { id: "export" as const, label: t("settings.sections.export"), icon: Type },
    { id: "ai" as const, label: t("settings.sections.ai"), icon: Bot },
    { id: "about" as const, label: t("settings.sections.about"), icon: Info },
  ]), [t]);

  const currentLocaleLabel = availableLocales.find((item) => item.code === locale)?.label ?? locale;
  const themeSuffix = settings.theme === "auto"
    ? t("settings.theme.following", { theme: t(`settings.theme.${resolvedTheme}`) })
    : "";

  useEffect(() => {
    let cancelled = false;

    void Promise.allSettled([getName(), getVersion()]).then((results) => {
      if (cancelled) return;

      setAboutInfo({
        name: results[0].status === "fulfilled" ? results[0].value : "Lume",
        version: results[1].status === "fulfilled" ? results[1].value : "0.1.0",
        repository: "https://github.com/liuup/Lume",
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/20 backdrop-blur-sm animate-backdrop" onClick={onClose}>
      <div
        className="w-[980px] max-w-[calc(100vw-2rem)] h-[min(86vh,780px)] bg-white rounded-2xl shadow-xl flex pointer-events-auto animate-modal overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="w-64 shrink-0 border-r border-zinc-100 bg-zinc-50/70 flex flex-col">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-100">
            <Settings size={18} className="text-zinc-500" />
            <h2 className="text-base font-semibold text-zinc-800">{t("settings.title")}</h2>
          </div>
          <nav className="p-3 space-y-1">
            {sections.map((section) => {
              const Icon = section.icon;
              const isActive = activeSection === section.id;

              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={[
                    "w-full flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors text-left",
                    isActive
                      ? "bg-white text-zinc-900 shadow-sm border border-zinc-200"
                      : "text-zinc-500 hover:bg-white/80 hover:text-zinc-800"
                  ].join(" ")}
                >
                  <Icon size={16} />
                  <span className="truncate">{section.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-100 bg-white/95 backdrop-blur-sm">
            <div className="text-sm font-semibold text-zinc-800">
              {sections.find((section) => section.id === activeSection)?.label}
            </div>
            <button onClick={onClose} className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {isLoading ? (
              <div className="p-8 text-center text-sm text-zinc-500 animate-pulse">{t("settings.loading")}</div>
            ) : (
              <div className="space-y-3">
                {activeSection === "appearance" && (
                  <>
                    <SettingCard title={t("settings.theme.label")} description={`${t("settings.theme.description")}${themeSuffix}`}>
                      <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-900 p-1">
                        {themeOptions.map(({ value, label }) => (
                          <button
                            key={value}
                            onClick={() => updateSetting("theme", value)}
                            className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                              settings.theme === value
                                ? "border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm"
                                : "border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100 hover:bg-white/70 dark:hover:bg-zinc-800/80"
                            }`}
                          >
                            {value === "light" && <Sun size={14} />}
                            {value === "dark" && <Moon size={14} />}
                            {value === "auto" && <Monitor size={14} />}
                            {label}
                          </button>
                        ))}
                      </div>
                    </SettingCard>

                    <SettingCard title={t("settings.fontScale.label")} description={t("settings.fontScale.description")}>
                      <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-900 p-1">
                        {fontScaleOptions.map(({ value, label }) => (
                          <button
                            key={value}
                            onClick={() => updateSetting("uiFontScale", value)}
                            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                              settings.uiFontScale === value
                                ? "border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm"
                                : "border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100 hover:bg-white/70 dark:hover:bg-zinc-800/80"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </SettingCard>

                    <SettingCard title={t("settings.defaultPdfZoom.label")} description={t("settings.defaultPdfZoom.description")}>
                      <select
                        value={settings.defaultPdfZoom}
                        onChange={(e) => updateSetting("defaultPdfZoom", e.target.value)}
                        className="text-sm border-zinc-200 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 py-1.5 px-3 bg-white border"
                      >
                        <option value="page-fit">{t("settings.defaultPdfZoom.pageFit")}</option>
                        <option value="page-width">{t("settings.defaultPdfZoom.pageWidth")}</option>
                        <option value="100%">100%</option>
                        <option value="150%">150%</option>
                      </select>
                    </SettingCard>
                  </>
                )}

                {activeSection === "language" && (
                  <SettingCard
                    title={t("settings.language.label")}
                    description={`${t("settings.language.description")} · ${t("settings.language.current", { language: currentLocaleLabel })}`}
                  >
                    <select
                      value={settings.language}
                      onChange={(e) => updateSetting("language", e.target.value)}
                      className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-indigo-500 min-w-44"
                    >
                      <option value="system">{t("settings.language.systemOption")}</option>
                      {availableLocales.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </SettingCard>
                )}

                {activeSection === "library" && (
                  <>
                    <SettingCard title={t("settings.autoRenamePdf.label")} description={t("settings.autoRenamePdf.description")}>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={settings.autoRenamePdf} onChange={(e) => updateSetting("autoRenamePdf", e.target.checked)} />
                        <div className="w-9 h-5 bg-zinc-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                      </label>
                    </SettingCard>

                    {settings.autoRenamePdf && (
                      <SettingCard title={t("settings.renamePattern.label")} description="">
                        <input
                          type="text"
                          value={settings.renamePattern}
                          onChange={(e) => updateSetting("renamePattern", e.target.value)}
                          className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 w-72 focus:ring-1 focus:ring-indigo-500 outline-none"
                          placeholder={t("settings.renamePattern.placeholder")}
                        />
                      </SettingCard>
                    )}
                  </>
                )}

                {activeSection === "export" && (
                  <SettingCard title={t("settings.defaultCitationFormat.label")} description={t("settings.defaultCitationFormat.description")}>
                    <select
                      value={settings.defaultCitationFormat}
                      onChange={(e) => updateSetting("defaultCitationFormat", e.target.value)}
                      className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-indigo-500"
                    >
                      <option value="apa">{t("settings.citationFormats.apa")}</option>
                      <option value="mla">{t("settings.citationFormats.mla")}</option>
                      <option value="chicago">{t("settings.citationFormats.chicago")}</option>
                      <option value="gbt">{t("settings.citationFormats.gbt")}</option>
                      <option value="bibtex">{t("settings.citationFormats.bibtex")}</option>
                    </select>
                  </SettingCard>
                )}

                {activeSection === "ai" && (
                  <>
                    <SettingCard title={t("settings.ai.apiKey.label")} description={t("settings.ai.apiKey.description")}>
                      <input
                        type="password"
                        value={settings.aiApiKey}
                        onChange={(e) => updateSetting("aiApiKey", e.target.value)}
                        className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 w-80 focus:ring-1 focus:ring-indigo-500 outline-none"
                        placeholder={t("settings.ai.apiKey.placeholder")}
                      />
                    </SettingCard>

                    <SettingCard title={t("settings.ai.completionUrl.label")} description={t("settings.ai.completionUrl.description")}>
                      <input
                        type="text"
                        value={settings.aiCompletionUrl}
                        onChange={(e) => updateSetting("aiCompletionUrl", e.target.value)}
                        className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 w-full max-w-[420px] focus:ring-1 focus:ring-indigo-500 outline-none"
                        placeholder={t("settings.ai.completionUrl.placeholder")}
                      />
                    </SettingCard>

                    <SettingCard title={t("settings.ai.model.label")} description={t("settings.ai.model.description")}>
                      <input
                        type="text"
                        value={settings.aiModel}
                        onChange={(e) => updateSetting("aiModel", e.target.value)}
                        className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 w-72 focus:ring-1 focus:ring-indigo-500 outline-none"
                        placeholder={t("settings.ai.model.placeholder")}
                      />
                    </SettingCard>

                    <SettingCard title={t("settings.ai.autoSummarize.label")} description={t("settings.ai.autoSummarize.description")}>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={settings.aiAutoSummarize} onChange={(e) => updateSetting("aiAutoSummarize", e.target.checked)} />
                        <div className="w-9 h-5 bg-zinc-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                      </label>
                    </SettingCard>

                    <SettingCard title={t("settings.ai.summaryLanguage.label")} description={t("settings.ai.summaryLanguage.description")}>
                      <input
                        type="text"
                        value={settings.aiSummaryLanguage}
                        onChange={(e) => updateSetting("aiSummaryLanguage", e.target.value)}
                        className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 w-48 focus:ring-1 focus:ring-indigo-500 outline-none"
                        placeholder={t("settings.ai.summaryLanguage.placeholder")}
                      />
                    </SettingCard>

                    <SettingCard title={t("settings.ai.summarySystemPrompt.label")} description={t("settings.ai.summarySystemPrompt.description")}>
                      <textarea
                        value={settings.aiSummarySystemPrompt}
                        onChange={(e) => updateSetting("aiSummarySystemPrompt", e.target.value)}
                        className="text-sm border border-zinc-200 rounded-lg px-3 py-2 w-full max-w-[620px] min-h-28 focus:ring-1 focus:ring-indigo-500 outline-none resize-y"
                        placeholder={t("settings.ai.summarySystemPrompt.placeholder")}
                      />
                    </SettingCard>

                    <SettingCard title={t("settings.ai.translateEngine.label")} description={t("settings.ai.translateEngine.description")}>
                      <select
                        value={settings.aiTranslateEngine}
                        onChange={(e) => updateSetting("aiTranslateEngine", e.target.value)}
                        className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-indigo-500 min-w-44"
                      >
                        <option value="google">{t("settings.ai.translateEngine.google")}</option>
                        <option value="llm">{t("settings.ai.translateEngine.llm")}</option>
                      </select>
                    </SettingCard>

                    <SettingCard title={t("settings.ai.translateLanguage.label")} description={t("settings.ai.translateLanguage.description")}>
                      <input
                        type="text"
                        value={settings.aiTranslateTargetLanguage}
                        onChange={(e) => updateSetting("aiTranslateTargetLanguage", e.target.value)}
                        className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 w-48 focus:ring-1 focus:ring-indigo-500 outline-none"
                        placeholder={t("settings.ai.translateLanguage.placeholder")}
                      />
                    </SettingCard>

                    <SettingCard title={t("settings.ai.translateSystemPrompt.label")} description={t("settings.ai.translateSystemPrompt.description")}>
                      <textarea
                        value={settings.aiTranslateSystemPrompt}
                        onChange={(e) => updateSetting("aiTranslateSystemPrompt", e.target.value)}
                        className="text-sm border border-zinc-200 rounded-lg px-3 py-2 w-full max-w-[620px] min-h-28 focus:ring-1 focus:ring-indigo-500 outline-none resize-y"
                        placeholder={t("settings.ai.translateSystemPrompt.placeholder")}
                      />
                    </SettingCard>
                  </>
                )}

                {activeSection === "about" && (
                  <section className="flex min-h-[420px] items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50/50 px-8 py-10">
                    <div className="flex max-w-md flex-col items-center text-center">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                        <Info size={24} />
                      </div>
                      <h3 className="mt-4 text-2xl font-semibold text-zinc-900">{aboutInfo.name}</h3>
                      <p className="mt-1 text-sm text-zinc-500">{t("settings.about.tagline")}</p>

                      <div className="mt-8 w-full space-y-3">
                        <AboutStat label={t("settings.about.version")} value={aboutInfo.version} />
                        <AboutStat
                          label={t("settings.about.repository")}
                          value={aboutInfo.repository}
                          linkLabel={t("settings.about.openRepository")}
                          isLink
                        />
                      </div>
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AboutStat({
  label,
  value,
  isLink = false,
  linkLabel,
}: {
  label: string;
  value: string;
  isLink?: boolean;
  linkLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-center">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      {isLink ? (
        <button
          type="button"
          onClick={() => {
            void openUrl(value);
          }}
          className="mt-1 inline-flex max-w-full items-center justify-center text-center text-sm font-medium text-indigo-600 hover:text-indigo-500"
        >
          {linkLabel ?? value}
        </button>
      ) : (
        <div className="mt-1 break-all text-sm font-medium text-zinc-800">{value}</div>
      )}
    </div>
  );
}

function SettingCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-zinc-800">{title}</div>
          {description ? <div className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{description}</div> : null}
        </div>
        <div className="shrink-0 max-w-[65%]">{children}</div>
      </div>
    </section>
  );
}
