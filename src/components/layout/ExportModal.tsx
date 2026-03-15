/**
 * ExportModal — batch citation/bibliography export dialog.
 * Supports APA, MLA, Chicago, GB/T 7714, BibTeX, RIS, and CSL JSON.
 */
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Copy, Download, Check, Loader2 } from "lucide-react";
import { LibraryItem } from "../../types";
import { useI18n } from "../../hooks/useI18n";
import { useFeedback } from "../../hooks/useFeedback";

export type CitationFormat = "apa" | "mla" | "chicago" | "gbt" | "bibtex" | "ris" | "csljson";

interface FormatOption {
  id: CitationFormat;
  ext: string;
  mime: string;
}

const FORMATS: FormatOption[] = [
  { id: "apa", ext: ".txt",  mime: "text/plain" },
  { id: "mla", ext: ".txt",  mime: "text/plain" },
  { id: "chicago", ext: ".txt",  mime: "text/plain" },
  { id: "gbt", ext: ".txt",  mime: "text/plain" },
  { id: "bibtex", ext: ".bib",  mime: "application/x-bibtex" },
  { id: "ris", ext: ".ris",  mime: "application/x-research-info-systems" },
  { id: "csljson", ext: ".json", mime: "application/json" },
];

interface Props {
  items: LibraryItem[];
  isOpen: boolean;
  onClose: () => void;
  scopeLabel?: string;
}

export function ExportModal({ items, isOpen, onClose, scopeLabel }: Props) {
  const { t } = useI18n();
  const feedback = useFeedback();
  const [format, setFormat] = useState<CitationFormat>("bibtex");
  const [output, setOutput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(async (fmt: CitationFormat) => {
    if (items.length === 0) { setOutput(""); return; }
    setIsGenerating(true);
    try {
      const ids = items.map(i => i.id);
      const result = await invoke<string>("export_items", { itemIds: ids, format: fmt });
      setOutput(result);
    } catch (err) {
      setOutput(t("exportModal.error", { error: String(err) }));
      feedback.error({
        title: t("feedback.export.error.title"),
        description: t("feedback.export.error.description"),
      });
    } finally {
      setIsGenerating(false);
    }
  }, [feedback, items, t]);

  // Re-generate whenever items or format change (but only if open)
  useEffect(() => {
    if (isOpen) generate(format);
  }, [isOpen, format, generate]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const fmt = FORMATS.find(f => f.id === format)!;
    const blob = new Blob([output], { type: fmt.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `references${fmt.ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  const selectedFmt = FORMATS.find(f => f.id === format)!;
  const selectedLabel = t(`exportModal.formats.${selectedFmt.id}.label`);

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-[720px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden border border-zinc-200 animate-modal">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 shrink-0">
          <div>
            <h2 className="font-semibold text-zinc-900">{t("exportModal.title")}</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {scopeLabel
                ? scopeLabel
                : (items.length === 1
                  ? t("exportModal.scope.one", { count: items.length })
                  : t("exportModal.scope.other", { count: items.length }))}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Format picker */}
        <div className="px-6 py-4 border-b border-zinc-100 shrink-0">
          <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">{t("exportModal.outputFormat")}</p>
          <div className="flex flex-wrap gap-2">
            {FORMATS.map(f => (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                className={[
                  "flex flex-col items-start px-3 py-2 rounded-xl border text-left transition-all",
                  format === f.id
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm"
                    : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50",
                ].join(" ")}
              >
                <span className={`text-xs font-semibold leading-none ${format === f.id ? "text-indigo-700" : "text-zinc-700"}`}>
                  {t(`exportModal.formats.${f.id}.label`)}
                </span>
                <span className="text-[10px] mt-1 leading-none text-zinc-400">{t(`exportModal.formats.${f.id}.description`)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 overflow-hidden flex flex-col px-6 py-4 min-h-0">
          <div className="flex items-center justify-between mb-2 shrink-0">
            <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
              {items.length === 1
                ? t("exportModal.preview.one", { format: selectedLabel, count: items.length })
                : t("exportModal.preview.other", { format: selectedLabel, count: items.length })}
            </p>
            {isGenerating && (
              <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Loader2 size={12} className="animate-spin" /> {t("exportModal.generating")}
              </span>
            )}
          </div>
          <textarea
            readOnly
            value={isGenerating ? t("exportModal.generating") : output}
            className="flex-1 min-h-0 w-full p-3 rounded-xl border border-zinc-200 bg-zinc-50 text-xs font-mono text-zinc-700 outline-none resize-none leading-relaxed"
            spellCheck={false}
          />
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-100 bg-zinc-50/50 shrink-0">
          <p className="text-xs text-zinc-400">
            {items.length === 0
              ? t("exportModal.noItems")
              : (items.length === 1
                ? t("exportModal.footer.one", { count: items.length, ext: selectedFmt.ext })
                : t("exportModal.footer.other", { count: items.length, ext: selectedFmt.ext }))}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleCopy}
              disabled={isGenerating || !output}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 transition-colors disabled:opacity-40"
            >
              {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              {copied ? t("exportModal.copied") : t("exportModal.copyAll")}
            </button>
            <button
              onClick={handleDownload}
              disabled={isGenerating || !output}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-40"
            >
              <Download size={14} />
              {t("exportModal.download", { ext: selectedFmt.ext })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
