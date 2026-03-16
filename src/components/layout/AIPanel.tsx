import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Loader2, Sparkles, X } from "lucide-react";
import { AiPaperSummary, LibraryItem } from "../../types";
import { useSettings } from "../../hooks/useSettings";
import { useI18n } from "../../hooks/useI18n";
import { useFeedback } from "../../hooks/useFeedback";

interface AIPanelProps {
  selectedItem: LibraryItem | null;
  isOpen: boolean;
  onClose: () => void;
  width: number;
  onResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void;
}

export function AIPanel({ selectedItem, isOpen, onClose, width, onResizeStart }: AIPanelProps) {
  const { settings } = useSettings();
  const { t } = useI18n();
  const feedback = useFeedback();
  const [paperSummary, setPaperSummary] = useState<AiPaperSummary | null>(null);
  const [isLoadingPaperSummary, setIsLoadingPaperSummary] = useState(false);

  const aiIsConfigured = Boolean(
    settings.aiApiKey.trim() &&
    settings.aiCompletionUrl.trim() &&
    settings.aiModel.trim()
  );

  useEffect(() => {
    setPaperSummary(null);
    setIsLoadingPaperSummary(false);
  }, [selectedItem?.id]);

  const handleGeneratePaperSummary = useCallback(async () => {
    if (!selectedItem || !aiIsConfigured) return;

    setIsLoadingPaperSummary(true);
    try {
      const summary = await invoke<AiPaperSummary>("summarize_document", {
        itemId: selectedItem.id,
        language: settings.aiSummaryLanguage,
      });
      setPaperSummary(summary);
    } catch (error) {
      console.error("Failed to generate paper summary", error);
      feedback.error({
        title: t("feedback.meta.paperSummaryError.title"),
        description: t("feedback.meta.paperSummaryError.description"),
      });
    } finally {
      setIsLoadingPaperSummary(false);
    }
  }, [aiIsConfigured, feedback, selectedItem, settings.aiSummaryLanguage, t]);

  useEffect(() => {
    if (!selectedItem || !isOpen || !settings.aiAutoSummarize || !aiIsConfigured || paperSummary || isLoadingPaperSummary) {
      return;
    }

    void handleGeneratePaperSummary();
  }, [aiIsConfigured, handleGeneratePaperSummary, isLoadingPaperSummary, isOpen, paperSummary, selectedItem, settings.aiAutoSummarize]);

  if (!isOpen) return null;

  return (
    <aside
      className="relative shrink-0 border-r border-zinc-200 bg-white flex flex-col h-full animate-slide-right"
      style={{ width }}
    >
      <div
        className="absolute top-0 right-0 h-full w-2 cursor-col-resize z-20 group"
        onMouseDown={onResizeStart}
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-indigo-300" />
      </div>
      <div className="h-14 border-b border-zinc-200 flex items-center justify-between px-4 shrink-0 bg-zinc-50/60">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-indigo-600" />
          <h2 className="font-semibold text-zinc-800 tracking-tight">{t("aiPanel.title")}</h2>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-md transition-colors"
          title={t("aiPanel.close")}
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <section className="space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-indigo-600" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-600">
                {t("aiPanel.summary.title")}
              </span>
            </div>
            <button
              onClick={() => void handleGeneratePaperSummary()}
              disabled={!selectedItem || !aiIsConfigured || isLoadingPaperSummary}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:border-indigo-200 hover:text-indigo-600 disabled:opacity-40"
            >
              {isLoadingPaperSummary ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {t("aiPanel.summary.refresh")}
            </button>
          </div>

          {!aiIsConfigured ? (
            <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-3 py-3 text-xs leading-relaxed text-zinc-500">
              {t("aiPanel.summary.notConfigured")}
            </div>
          ) : isLoadingPaperSummary ? (
            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-3 text-xs text-zinc-400 animate-pulse">
              {t("aiPanel.summary.loading")}
            </div>
          ) : paperSummary ? (
            <div className="space-y-3 rounded-xl bg-white p-3 border border-indigo-100">
              <div>
                <div className="text-sm font-semibold text-zinc-800">{paperSummary.title}</div>
                <div className="mt-1 text-sm leading-relaxed text-zinc-700">{paperSummary.summary}</div>
              </div>

              {paperSummary.keyPoints.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700">{t("aiPanel.summary.keyPoints")}</div>
                  <ul className="mt-1 space-y-1 text-xs leading-relaxed text-zinc-600">
                    {paperSummary.keyPoints.map((point, index) => (
                      <li key={`summary-point-${index}`}>• {point}</li>
                    ))}
                  </ul>
                </div>
              )}

              {paperSummary.limitations.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700">{t("aiPanel.summary.limitations")}</div>
                  <ul className="mt-1 space-y-1 text-xs leading-relaxed text-zinc-600">
                    {paperSummary.limitations.map((point, index) => (
                      <li key={`summary-limit-${index}`}>• {point}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-3 py-3 text-xs leading-relaxed text-zinc-500">
              {t("aiPanel.summary.empty")}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
