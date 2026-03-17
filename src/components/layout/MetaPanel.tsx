import { Tag, Calendar, User, AlignLeft, X, FileText, Fingerprint, Orbit, Edit2, Check, Book, Building, Link2, Copy, Quote, StickyNote, Wand2, Highlighter, Search, Download, Loader2 } from "lucide-react";
import {
  AiAnnotationDigest,
  LibraryItem,
  MetadataFetchReport,
  RetrieveMetadataResult,
  SavedPdfAnnotationsDocument,
} from "../../types";
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CitationFormat } from "./ExportModal";
import { useSettings } from "../../hooks/useSettings";
import { useI18n } from "../../hooks/useI18n";
import { useFeedback } from "../../hooks/useFeedback";

const CITE_FORMATS: CitationFormat[] = ["apa", "mla", "chicago", "gbt", "bibtex", "ris"];

interface MetaPanelProps {
  selectedItem: LibraryItem | null;
  isOpen: boolean;
  onClose: () => void;
  width?: number;
  onResizeStart?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onItemUpdated?: () => void;
  tagColors?: Record<string, string>;
  onPageJump?: (page: number) => void;
  annotationsRefreshKey?: number;
}

type RawSavedTextAnnotation = {
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  font_size?: number;
};

type RawSavedPdfPageAnnotations = {
  paths?: SavedPdfAnnotationsDocument["pages"][string]["paths"];
  textAnnotations?: RawSavedTextAnnotation[];
  text_annotations?: RawSavedTextAnnotation[];
};

type RawSavedPdfAnnotationsDocument = {
  version?: number;
  pages?: Record<string, RawSavedPdfPageAnnotations>;
};

type AnnotationEntryType = "text" | "highlight" | "ink";
type AnnotationFilter = "all" | AnnotationEntryType;

interface AnnotationEntry {
  id: string;
  page: number;
  type: AnnotationEntryType;
  preview: string;
  searchText: string;
  sequence: number | null;
}

const ANNOTATION_FILTERS: Array<{ id: AnnotationFilter; labelKey: string }> = [
  { id: "all", labelKey: "metaPanel.annotations.filters.all" },
  { id: "text", labelKey: "metaPanel.annotations.filters.text" },
  { id: "highlight", labelKey: "metaPanel.annotations.filters.highlight" },
  { id: "ink", labelKey: "metaPanel.annotations.filters.ink" },
];

function normalizePdfAnnotations(document: RawSavedPdfAnnotationsDocument | null | undefined): SavedPdfAnnotationsDocument | null {
  if (!document) return null;

  const normalizedPages = Object.fromEntries(
    Object.entries(document.pages ?? {}).map(([pageKey, pageData]) => {
      const rawTextAnnotations = Array.isArray(pageData?.textAnnotations)
        ? pageData.textAnnotations
        : Array.isArray(pageData?.text_annotations)
          ? pageData.text_annotations
          : [];

      return [
        pageKey,
        {
          paths: Array.isArray(pageData?.paths) ? pageData.paths : [],
          textAnnotations: rawTextAnnotations.map((annotation) => ({
            x: annotation.x,
            y: annotation.y,
            text: annotation.text,
            fontSize: annotation.fontSize ?? annotation.font_size ?? 13,
          })),
        },
      ];
    }),
  );

  return {
    version: document.version ?? 1,
    pages: normalizedPages,
  };
}

function getPathMinY(path: { points: Array<{ y: number }> }): number {
  if (!path.points || path.points.length === 0) return Number.MAX_SAFE_INTEGER;
  return path.points.reduce((minY, point) => Math.min(minY, point.y), Number.MAX_SAFE_INTEGER);
}

function flattenPdfAnnotations(document: SavedPdfAnnotationsDocument | null): AnnotationEntry[] {
  if (!document) return [];

  const entries: AnnotationEntry[] = [];
  const sortedPages = Object.entries(document.pages ?? {})
    .map(([pageKey, pageData]) => ({
      pageIndex: parseInt(pageKey, 10),
      pageData,
    }))
    .filter(({ pageIndex }) => !Number.isNaN(pageIndex))
    .sort((a, b) => a.pageIndex - b.pageIndex);

  for (const { pageIndex, pageData } of sortedPages) {
    const rawEntries: Array<{
      type: AnnotationEntryType;
      y: number;
      preview: string;
      searchText: string;
    }> = [];

    for (const annotation of pageData.textAnnotations ?? []) {
      const trimmed = annotation.text.trim();
      if (!trimmed) continue;

      rawEntries.push({
        type: "text",
        y: annotation.y,
        preview: trimmed.split(/\r?\n/, 1)[0] || trimmed,
        searchText: trimmed.toLowerCase(),
      });
    }

    for (const path of pageData.paths ?? []) {
      rawEntries.push({
        type: path.tool === "highlight" ? "highlight" : "ink",
        y: getPathMinY(path),
        preview: "",
        searchText: "",
      });
    }

    rawEntries.sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      const typeOrder: Record<AnnotationEntryType, number> = {
        text: 0,
        highlight: 1,
        ink: 2,
      };
      return typeOrder[a.type] - typeOrder[b.type];
    });

    let highlightSequence = 0;
    let inkSequence = 0;

    rawEntries.forEach((entry, index) => {
      let sequence: number | null = null;
      if (entry.type === "highlight") {
        highlightSequence += 1;
        sequence = highlightSequence;
      } else if (entry.type === "ink") {
        inkSequence += 1;
        sequence = inkSequence;
      }

      entries.push({
        id: `${pageIndex}-${entry.type}-${index}`,
        page: pageIndex + 1,
        type: entry.type,
        preview: entry.preview,
        searchText: entry.searchText,
        sequence,
      });
    });
  }

  return entries;
}

function sanitizeDownloadFileName(name: string): string {
  return name
    .replace(/\.pdf$/i, "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
}

function downloadTextFile(content: string, fileName: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function MetaPanel({ selectedItem, isOpen, onClose, width = 320, onResizeStart, onItemUpdated, tagColors = {}, onPageJump, annotationsRefreshKey = 0 }: MetaPanelProps) {
  const { t } = useI18n();
  const feedback = useFeedback();
  const [isEditing, setIsEditing] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<LibraryItem>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isRetrievingMetadata, setIsRetrievingMetadata] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const tagInputRef = useRef<HTMLInputElement>(null);

  const { settings } = useSettings();

  // ── Citation state ───────────────────────────────────────────────────────
  const [citeFormat, setCiteFormat] = useState<CitationFormat>(settings.defaultCitationFormat as CitationFormat);
  const [citeText, setCiteText] = useState("");
  const [citeCopied, setCiteCopied] = useState(false);

  // Update citation format when the default setting changes (only if we're basically resetting)
  useEffect(() => {
    setCiteFormat(settings.defaultCitationFormat as CitationFormat);
  }, [settings.defaultCitationFormat]);

  // ── Notes state ─────────────────────────────────────────────────────────────
  const [noteText, setNoteText] = useState("");
  const [isLoadingNote, setIsLoadingNote] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [annotationDigest, setAnnotationDigest] = useState<AiAnnotationDigest | null>(null);
  const [isGeneratingAnnotationDigest, setIsGeneratingAnnotationDigest] = useState(false);
  const [isApplyingAnnotationDigest, setIsApplyingAnnotationDigest] = useState(false);
  const [metadataFetchReport, setMetadataFetchReport] = useState<MetadataFetchReport | null>(null);
  const [isLoadingMetadataFetchReport, setIsLoadingMetadataFetchReport] = useState(false);

  // ── Annotations list state ───────────────────────────────────────────────────
  const [pdfAnnotations, setPdfAnnotations] = useState<SavedPdfAnnotationsDocument | null>(null);
  const [isLoadingAnnotations, setIsLoadingAnnotations] = useState(false);
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilter>("all");
  const [annotationSearchQuery, setAnnotationSearchQuery] = useState("");
  const [isExportingAnnotations, setIsExportingAnnotations] = useState(false);
  const hasLoadedAnnotationsRef = useRef(false);
  const citationFormatLabel = (format: CitationFormat) => {
    if (format === "ris") {
      return t("metaPanel.cite.formats.ris");
    }

    return t(`settings.citationFormats.${format}`);
  };

  const generateCite = useCallback(async (itemId: string, fmt: CitationFormat) => {
    try {
      const text = await invoke<string>("generate_citation", { itemId, format: fmt });
      setCiteText(text);
    } catch {
      setCiteText("");
    }
  }, []);

  useEffect(() => {
    if (selectedItem && !isEditing) {
      generateCite(selectedItem.id, citeFormat);
    } else {
      setCiteText("");
    }
  }, [selectedItem?.id, citeFormat, isEditing, generateCite]);

  useEffect(() => {
    const loadMetadataFetchReport = async () => {
      if (!selectedItem || !isOpen) {
        setMetadataFetchReport(null);
        return;
      }

      setIsLoadingMetadataFetchReport(true);
      try {
        const result = await invoke<MetadataFetchReport | null>("get_item_metadata_fetch_report", {
          itemId: selectedItem.id,
        });
        setMetadataFetchReport(result);
      } catch (error) {
        console.error("Failed to load metadata fetch report", error);
        setMetadataFetchReport(null);
      } finally {
        setIsLoadingMetadataFetchReport(false);
      }
    };

    loadMetadataFetchReport();
  }, [selectedItem?.id, isOpen]);

  // Sync form data when selection changes or editing toggles
  useEffect(() => {
    if (selectedItem && isEditing) {
      setEditFormData({
        id: selectedItem.id,
        title: selectedItem.title,
        authors: selectedItem.authors,
        year: selectedItem.year,
        abstract: selectedItem.abstract,
        doi: selectedItem.doi,
        arxiv_id: selectedItem.arxiv_id,
        publication: selectedItem.publication,
        volume: selectedItem.volume,
        issue: selectedItem.issue,
        pages: selectedItem.pages,
        publisher: selectedItem.publisher,
        isbn: selectedItem.isbn,
        url: selectedItem.url,
        language: selectedItem.language,
        tags: [...selectedItem.tags],
      });
    } else {
      setEditFormData({});
    }
  }, [selectedItem, isEditing]);

  // Reset edit mode when selecting a different item
  useEffect(() => {
    setIsEditing(false);
  }, [selectedItem?.id]);

  useEffect(() => {
    setPdfAnnotations(null);
    hasLoadedAnnotationsRef.current = false;
  }, [selectedItem?.attachments?.[0]?.path]);

  useEffect(() => {
    setAnnotationFilter("all");
    setAnnotationSearchQuery("");
  }, [selectedItem?.id]);

  useEffect(() => {
    setAnnotationDigest(null);
    setIsGeneratingAnnotationDigest(false);
    setIsApplyingAnnotationDigest(false);
  }, [selectedItem?.id]);

  const metadataReportStateLabel = metadataFetchReport?.metadataCompleted
    ? t("metaPanel.metadataFlow.states.complete")
    : metadataFetchReport?.isPreprint
      ? t("metaPanel.metadataFlow.states.preprint")
      : t("metaPanel.metadataFlow.states.partial");

  const metadataReportStateClassName = metadataFetchReport?.metadataCompleted
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : metadataFetchReport?.isPreprint
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-zinc-200 bg-zinc-100 text-zinc-700";

  const metadataStepStatusClassName = (status: string) => {
    if (status === "hit") {
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    }
    if (status === "error") {
      return "border-rose-200 bg-rose-50 text-rose-700";
    }
    if (status === "redundant") {
      return "border-sky-200 bg-sky-50 text-sky-700";
    }
    return "border-zinc-200 bg-zinc-100 text-zinc-600";
  };

  const metadataStepStatusLabel = (status: string) => {
    const key = `metaPanel.metadataFlow.statuses.${status}`;
    const translated = t(key);
    return translated === key ? status : translated;
  };

  const metadataStepStageLabel = (stage: string) => {
    const key = `metaPanel.metadataFlow.stages.${stage}`;
    const translated = t(key);
    return translated === key ? stage : translated;
  };

  const metadataStepProviderLabel = (provider: string) => {
    const key = `metaPanel.metadataFlow.providers.${provider}`;
    const translated = t(key);
    return translated === key ? provider : translated;
  };

  // Load note when selection changes
  useEffect(() => {
    const loadNote = async () => {
      if (!selectedItem) {
        setNoteText("");
        return;
      }
      setIsLoadingNote(true);
      try {
        const result = await invoke<{ id: string; item_id: string; content: string } | null>("get_item_note", {
          itemId: selectedItem.id,
        });
        setNoteText(result?.content ?? "");
      } catch {
        setNoteText("");
      } finally {
        setIsLoadingNote(false);
      }
    };

    loadNote();
  }, [selectedItem?.id, isOpen]);

  // Load annotations when selection changes or annotations are updated
  useEffect(() => {
    const loadAnnotations = async () => {
      if (!selectedItem || !selectedItem.attachments?.[0]?.path) {
        setPdfAnnotations(null);
        return;
      }

      const shouldShowLoadingState = !hasLoadedAnnotationsRef.current;
      if (shouldShowLoadingState) {
        setIsLoadingAnnotations(true);
      }

      try {
        const result = await invoke<RawSavedPdfAnnotationsDocument>("get_all_annotations", {
          path: selectedItem.attachments?.[0]?.path,
        });
        setPdfAnnotations(normalizePdfAnnotations(result));
        hasLoadedAnnotationsRef.current = true;
      } catch (err) {
        console.error("Failed to load full annotations array:", err);
        if (shouldShowLoadingState) {
          setPdfAnnotations(null);
        }
      } finally {
        if (shouldShowLoadingState) {
          setIsLoadingAnnotations(false);
        }
      }
    };

    // Use setTimeout or a background queue to not block the main note loading UI immediately
    const t = setTimeout(loadAnnotations, 100);
    return () => clearTimeout(t);
  }, [selectedItem?.id, selectedItem?.attachments?.[0]?.path, isOpen, annotationsRefreshKey]);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!selectedItem) return;
    setIsSaving(true);
    try {
      await invoke("update_item_metadata", {
        payload: {
          id: selectedItem.id,
          title: editFormData.title || "",
          authors: editFormData.authors || "",
          year: editFormData.year || "",
          abstract: editFormData.abstract || "",
          doi: editFormData.doi || "",
          arxivId: editFormData.arxiv_id || "", 
          publication: editFormData.publication || "",
          volume: editFormData.volume || "",
          issue: editFormData.issue || "",
          pages: editFormData.pages || "",
          publisher: editFormData.publisher || "",
          isbn: editFormData.isbn || "",
          url: editFormData.url || "",
          language: editFormData.language || "",
          tags: editFormData.tags || [],
        }
      });
      setIsEditing(false);
      if (onItemUpdated) {
        onItemUpdated();
      }
      feedback.success({
        title: t("feedback.meta.saveSuccess.title"),
        description: t("feedback.meta.saveSuccess.description"),
      });
    } catch (error) {
      console.error("Failed to update metadata", error);
      feedback.error({
        title: t("feedback.meta.saveError.title"),
        description: t("feedback.meta.saveError.description"),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleRetrieveMetadata = async () => {
    if (!selectedItem || isEditing) return;

    setIsRetrievingMetadata(true);
    try {
      const result = await invoke<RetrieveMetadataResult>("retrieve_item_metadata", {
        itemId: selectedItem.id,
      });
      setMetadataFetchReport(result.report);
      if (onItemUpdated) {
        onItemUpdated();
      }
      feedback.success({
        title: t("feedback.meta.retrieveSuccess.title"),
        description: result.report.summary
          ? `${t("feedback.meta.retrieveSuccess.description")}\n${result.report.summary}`
          : t("feedback.meta.retrieveSuccess.description"),
      });
    } catch (error) {
      console.error("Failed to retrieve item metadata", error);
      feedback.error({
        title: t("feedback.meta.retrieveError.title"),
        description: t("feedback.meta.retrieveError.description"),
      });
    } finally {
      setIsRetrievingMetadata(false);
    }
  };

  const handleStringChange = (field: keyof LibraryItem, value: string) => {
    setEditFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSaveNote = async () => {
    if (!selectedItem) return;
    setIsSavingNote(true);
    try {
      await invoke("upsert_item_note", {
        itemId: selectedItem.id,
        content: noteText,
      });
      feedback.success({
        title: t("feedback.meta.noteSaveSuccess.title"),
        description: t("feedback.meta.noteSaveSuccess.description"),
      });
    } catch (error) {
      console.error("Failed to save note", error);
      feedback.error({
        title: t("feedback.meta.noteSaveError.title"),
        description: t("feedback.meta.noteSaveError.description"),
      });
    } finally {
      setIsSavingNote(false);
    }
  };

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    setEditFormData(prev => {
      const current = prev.tags || [];
      if (current.includes(tag)) return prev;
      return { ...prev, tags: [...current, tag] };
    });
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setEditFormData(prev => ({ ...prev, tags: (prev.tags || []).filter(t => t !== tag) }));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === "Backspace" && tagInput === "") {
      const tags = editFormData.tags || [];
      if (tags.length > 0) removeTag(tags[tags.length - 1]);
    }
  };

  const annotationEntries = flattenPdfAnnotations(pdfAnnotations);
  const annotationSearchTerm = annotationSearchQuery.trim().toLowerCase();
  const filteredAnnotationEntries = annotationEntries.filter((entry) => {
    if (annotationFilter !== "all" && entry.type !== annotationFilter) {
      return false;
    }

    if (annotationSearchTerm) {
      return entry.type === "text" && entry.searchText.includes(annotationSearchTerm);
    }

    return true;
  });
  const hasAnnotations = annotationEntries.length > 0;
  const hasActiveAnnotationFilters = annotationFilter !== "all" || annotationSearchTerm.length > 0;

  const handleExportAnnotations = async () => {
    if (!selectedItem) return;

    setIsExportingAnnotations(true);
    const itemLabel = selectedItem.title || selectedItem.attachments?.[0]?.name || t("metaPanel.untitled");

    try {
      const markdown = await invoke<string>("generate_item_annotations_markdown", {
        itemId: selectedItem.id,
      });

      if (!markdown.trim()) {
        feedback.info({
          title: t("feedback.meta.annotationsEmpty.title"),
          description: t("feedback.meta.annotationsEmpty.description"),
        });
        return;
      }

      const baseFileName = sanitizeDownloadFileName(
        selectedItem.title
          || selectedItem.attachments?.[0]?.name
          || selectedItem.id.split("/").pop()
          || t("metaPanel.annotations.exportFallbackFileName"),
      ) || t("metaPanel.annotations.exportFallbackFileName");

      downloadTextFile(markdown, `${baseFileName}.md`, "text/markdown;charset=utf-8");
      feedback.success({
        title: t("feedback.meta.annotationsExportSuccess.title"),
        description: t("feedback.meta.annotationsExportSuccess.description", { title: itemLabel }),
      });
    } catch (error) {
      console.error("Failed to export annotations markdown", error);
      feedback.error({
        title: t("feedback.meta.annotationsExportError.title"),
        description: t("feedback.meta.annotationsExportError.description"),
      });
    } finally {
      setIsExportingAnnotations(false);
    }
  };

  const annotationEntryTitle = (entry: AnnotationEntry) => {
    if (entry.type === "text") {
      return t("metaPanel.annotations.items.text");
    }

    return t(`metaPanel.annotations.items.${entry.type}`, {
      index: entry.sequence ?? 1,
    });
  };

  const annotationEntryPreview = (entry: AnnotationEntry) => {
    if (entry.type === "text") {
      return entry.preview;
    }

    return t(`metaPanel.annotations.previews.${entry.type}`);
  };

  const handleGenerateAnnotationDigest = async () => {
    if (!selectedItem) return;

    setIsGeneratingAnnotationDigest(true);
    try {
      const digest = await invoke<AiAnnotationDigest>("generate_annotation_digest", {
        itemId: selectedItem.id,
      });
      setAnnotationDigest(digest);
      feedback.success({
        title: t("feedback.meta.digestSuccess.title"),
        description: t("feedback.meta.digestSuccess.description"),
      });
    } catch (error) {
      console.error("Failed to generate annotation digest", error);
      feedback.error({
        title: t("feedback.meta.digestError.title"),
        description: t("feedback.meta.digestError.description"),
      });
    } finally {
      setIsGeneratingAnnotationDigest(false);
    }
  };

  const handleApplyAnnotationDigest = async (mode: "append" | "replace") => {
    if (!selectedItem || !annotationDigest) return;

    setIsApplyingAnnotationDigest(true);
    try {
      const nextContent = mode === "replace"
        ? annotationDigest.markdown
        : [noteText.trim(), annotationDigest.markdown].filter(Boolean).join("\n\n---\n\n");

      await invoke("upsert_item_note", {
        itemId: selectedItem.id,
        content: nextContent,
      });
      setNoteText(nextContent);
      feedback.success({
        title: t("feedback.meta.digestApplySuccess.title"),
        description: t("feedback.meta.digestApplySuccess.description"),
      });
    } catch (error) {
      console.error("Failed to apply annotation digest", error);
      feedback.error({
        title: t("feedback.meta.digestApplyError.title"),
        description: t("feedback.meta.digestApplyError.description"),
      });
    } finally {
      setIsApplyingAnnotationDigest(false);
    }
  };

  return (
    <aside className="relative bg-white border-l border-zinc-200 flex flex-col h-full shrink-0 animate-slide-left" style={{ width }}>
      <div
        className="absolute top-0 left-0 h-full w-2 cursor-col-resize z-20 group"
        onMouseDown={onResizeStart}
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-indigo-300" />
      </div>
      {/* Header */}
      <div className="h-14 border-b border-zinc-200 flex items-center justify-between px-4 shrink-0 bg-zinc-50/50">
        <h2 className="font-semibold text-zinc-800 tracking-tight">{t("metaPanel.title")}</h2>
        <div className="flex items-center space-x-1">
          {selectedItem && (
            isEditing ? (
               <button
                 onClick={handleSave}
                 disabled={isSaving}
                 className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-md transition-colors flex items-center gap-1 text-xs font-medium"
                 title={t("metaPanel.actions.saveChanges")}
               >
                 <Check size={14} />
                 {isSaving ? t("metaPanel.actions.saving") : t("metaPanel.actions.save")}
               </button>
            ) : (
              <>
                <button
                  onClick={handleRetrieveMetadata}
                  disabled={isRetrievingMetadata}
                  className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors flex items-center gap-1 text-xs font-medium disabled:cursor-wait disabled:text-indigo-300"
                  title={t("metaPanel.actions.retrieveMetadata")}
                >
                  {isRetrievingMetadata ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                  {isRetrievingMetadata ? t("metaPanel.actions.retrievingMetadata") : t("metaPanel.actions.retrieve")}
                </button>
                <button
                  onClick={() => setIsEditing(true)}
                  className="p-1.5 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded-md transition-colors flex items-center gap-1 text-xs font-medium"
                  title={t("metaPanel.actions.editMetadata")}
                >
                  <Edit2 size={14} />
                  {t("metaPanel.actions.edit")}
                </button>
              </>
            )
          )}
          <button
            onClick={() => {
              if (isEditing) {
                setIsEditing(false); // cancel edit instead of closing panel if editing
              } else {
                onClose();
              }
            }}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-md transition-colors ml-1"
            title={isEditing ? t("metaPanel.actions.cancelEdit") : t("metaPanel.actions.closePanel")}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!selectedItem ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full text-zinc-300 space-y-3 px-6">
            <FileText size={36} className="opacity-40" />
            <p className="text-sm text-center text-zinc-400 leading-snug">
              {t("metaPanel.empty")}
            </p>
          </div>
        ) : isEditing ? (
          <div className="p-5 space-y-4">
            <EditField label={t("metaPanel.fields.title")} value={editFormData.title || ""} onChange={v => handleStringChange('title', v)} isTextArea />
            <EditField label={t("metaPanel.fields.authors")} value={editFormData.authors || ""} onChange={v => handleStringChange('authors', v)} placeholder={t("metaPanel.placeholders.authors")} />
            
            <div className="grid grid-cols-2 gap-3">
              <EditField label={t("metaPanel.fields.year")} value={editFormData.year || ""} onChange={v => handleStringChange('year', v)} />
              <EditField label={t("metaPanel.fields.language")} value={editFormData.language || ""} onChange={v => handleStringChange('language', v)} />
            </div>

            {/* Pill tag editor */}
            <div className="flex flex-col space-y-1">
              <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{t("metaPanel.fields.tags")}</label>
              <div
                className="flex flex-wrap gap-1.5 p-2 border border-zinc-200 rounded-md bg-white min-h-[36px] cursor-text focus-within:border-zinc-400 focus-within:ring-1 focus-within:ring-zinc-400 transition-shadow"
                onClick={() => tagInputRef.current?.focus()}
              >
                {(editFormData.tags || []).map(tag => {
                  const color = tagColors[tag] || "#6366f1";
                  return (
                    <span
                      key={tag}
                      className="flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-full text-[11px] font-medium bg-zinc-100 text-zinc-700 border border-zinc-200"
                    >
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      {tag}
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); removeTag(tag); }}
                        className="ml-0.5 text-zinc-400 hover:text-red-500 transition-colors leading-none"
                      >×</button>
                    </span>
                  );
                })}
                <input
                  ref={tagInputRef}
                  type="text"
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={handleTagKeyDown}
                  onBlur={() => { if (tagInput.trim()) addTag(tagInput); }}
                  placeholder={(editFormData.tags || []).length === 0 ? t("metaPanel.placeholders.tagInput") : ""}
                  className="flex-1 min-w-[120px] text-sm bg-transparent outline-none placeholder:text-zinc-300"
                />
              </div>
              <p className="text-[10px] text-zinc-400">{t("metaPanel.tagsHelp")}</p>
            </div>

            <div className="border-t border-zinc-100 pt-4 mt-2 space-y-4">
              <EditField label={t("metaPanel.fields.publication")} value={editFormData.publication || ""} onChange={v => handleStringChange('publication', v)} />
              
              <div className="grid grid-cols-3 gap-3">
                <EditField label={t("metaPanel.fields.volume")} value={editFormData.volume || ""} onChange={v => handleStringChange('volume', v)} />
                <EditField label={t("metaPanel.fields.issue")} value={editFormData.issue || ""} onChange={v => handleStringChange('issue', v)} />
                <EditField label={t("metaPanel.fields.pages")} value={editFormData.pages || ""} onChange={v => handleStringChange('pages', v)} />
              </div>

              <EditField label={t("metaPanel.fields.publisher")} value={editFormData.publisher || ""} onChange={v => handleStringChange('publisher', v)} />
              
              <div className="grid grid-cols-2 gap-3">
                <EditField label={t("metaPanel.fields.doi")} value={editFormData.doi || ""} onChange={v => handleStringChange('doi', v)} />
                <EditField label={t("metaPanel.fields.arxiv")} value={editFormData.arxiv_id || ""} onChange={v => handleStringChange('arxiv_id', v)} />
              </div>
              
              <EditField label={t("metaPanel.fields.isbn")} value={editFormData.isbn || ""} onChange={v => handleStringChange('isbn', v)} />
              <EditField label={t("metaPanel.fields.url")} value={editFormData.url || ""} onChange={v => handleStringChange('url', v)} />
            </div>

            <div className="border-t border-zinc-100 pt-4 mt-2">
              <EditField label={t("metaPanel.fields.abstract")} value={editFormData.abstract || ""} onChange={v => handleStringChange('abstract', v)} isTextArea rows={8} />
            </div>

            <div className="flex justify-end pt-4 pb-8 space-x-2">
              <button 
                onClick={() => setIsEditing(false)}
                className="px-3 py-1.5 text-xs font-medium text-zinc-600 bg-white border border-zinc-200 rounded hover:bg-zinc-50 transition-colors"
                disabled={isSaving}
              >
                {t("metaPanel.actions.cancel")}
              </button>
              <button 
                onClick={handleSave}
                className="px-3 py-1.5 text-xs font-medium text-white bg-zinc-800 rounded hover:bg-zinc-900 transition-colors"
                disabled={isSaving}
              >
                {isSaving ? t("metaPanel.actions.savingWithDots") : t("metaPanel.actions.saveChanges")}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-6">
            {/* Title & tags */}
            <div>
              <h3 className="text-base font-bold text-zinc-900 leading-tight">
                {selectedItem.title || selectedItem.attachments?.[0]?.name || t("metaPanel.untitled")}
              </h3>
              {selectedItem.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {selectedItem.tags.map(tag => {
                    const color = tagColors[tag] || "#6366f1";
                    return (
                      <span
                        key={tag}
                        className="flex items-center gap-1 px-2 py-0.5 bg-zinc-100 text-zinc-700 text-[10px] font-semibold rounded-full border border-zinc-200"
                      >
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                        {tag}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-4">
              {/* Authors */}
              <MetaRow icon={<User size={15} className="text-zinc-400" />} label={t("metaPanel.fields.authors")}>
                {selectedItem.authors && selectedItem.authors !== "—" ? selectedItem.authors : (
                  <span className="text-zinc-400 italic">{t("metaPanel.unknown")}</span>
                )}
              </MetaRow>

              {/* Year */}
              <MetaRow icon={<Calendar size={15} className="text-zinc-400" />} label={t("metaPanel.fields.year")}>
                {selectedItem.year && selectedItem.year !== "—" ? selectedItem.year : (
                  <span className="text-zinc-400 italic">{t("metaPanel.unknown")}</span>
                )}
              </MetaRow>

              {/* Abstract */}
              {selectedItem.abstract ? (
                <MetaRow icon={<AlignLeft size={15} className="text-zinc-400" />} label={t("metaPanel.fields.abstract")}>
                  <p className="text-sm text-zinc-600 leading-relaxed max-w-full overflow-hidden text-ellipsis">{selectedItem.abstract}</p>
                </MetaRow>
              ) : null}

              {/* Publication Info */}
              {selectedItem.publication ? (
                <MetaRow icon={<Book size={15} className="text-zinc-400" />} label={t("metaPanel.fields.publication")}>
                  <span className="text-zinc-600">
                    <em className="font-serif">{selectedItem.publication}</em>
                    {selectedItem.volume ? ` ${t("metaPanel.publication.volume", { value: selectedItem.volume })}` : ''}
                    {selectedItem.issue ? ` ${t("metaPanel.publication.issue", { value: selectedItem.issue })}` : ''}
                    {selectedItem.pages ? ` ${t("metaPanel.publication.pages", { value: selectedItem.pages })}` : ''}
                  </span>
                </MetaRow>
              ) : null}

              {/* Publisher */}
              {selectedItem.publisher ? (
                <MetaRow icon={<Building size={15} className="text-zinc-400" />} label={t("metaPanel.fields.publisher")}>
                   <span className="text-zinc-600">{selectedItem.publisher}</span>
                </MetaRow>
              ) : null}

              {/* DOI */}
              {selectedItem.doi ? (
                <MetaRow icon={<Fingerprint size={15} className="text-zinc-400" />} label={t("metaPanel.fields.doi")}>
                  <a href={`https://doi.org/${selectedItem.doi}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline break-all">
                    {selectedItem.doi}
                  </a>
                </MetaRow>
              ) : null}

              {/* arXiv */}
              {selectedItem.arxiv_id ? (
                <MetaRow icon={<Orbit size={15} className="text-zinc-400" />} label={t("metaPanel.fields.arxiv")}>
                  <a href={`https://arxiv.org/abs/${selectedItem.arxiv_id}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline break-all">
                    {selectedItem.arxiv_id}
                  </a>
                </MetaRow>
              ) : null}

              {/* URL */}
              {selectedItem.url ? (
                <MetaRow icon={<Link2 size={15} className="text-zinc-400" />} label={t("metaPanel.fields.url")}>
                  <a href={selectedItem.url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline break-all line-clamp-2" title={selectedItem.url}>
                    {selectedItem.url}
                  </a>
                </MetaRow>
              ) : null}

              {/* Filename */}
              <MetaRow icon={<Tag size={15} className="text-zinc-400" />} label={t("metaPanel.fields.file")}>
                <span className="text-zinc-500 text-xs font-mono break-all line-clamp-2" title={selectedItem.attachments?.[0]?.name}>{selectedItem.attachments?.[0]?.name || t("metaPanel.none")}</span>
              </MetaRow>
            </div>
            {(isLoadingMetadataFetchReport || metadataFetchReport) && (
              <div className="border border-zinc-200 rounded-xl bg-zinc-50/80 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Search size={14} className="text-zinc-500" />
                    <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">
                      {t("metaPanel.metadataFlow.title")}
                    </span>
                  </div>
                  {metadataFetchReport ? (
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide ${metadataReportStateClassName}`}>
                      {metadataReportStateLabel}
                    </span>
                  ) : null}
                </div>

                {isLoadingMetadataFetchReport && !metadataFetchReport ? (
                  <p className="text-xs text-zinc-500">{t("metaPanel.metadataFlow.loading")}</p>
                ) : null}

                {metadataFetchReport ? (
                  <>
                    {metadataFetchReport.summary ? (
                      <p className="text-xs text-zinc-600 leading-relaxed">
                        {metadataFetchReport.summary}
                      </p>
                    ) : null}

                    {!metadataFetchReport.networkComplete ? (
                      <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-2">
                        {t("metaPanel.metadataFlow.networkGaps")}
                      </p>
                    ) : null}

                    {metadataFetchReport.titleQueries.length > 0 ? (
                      <div className="space-y-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          {t("metaPanel.metadataFlow.titleQueries")}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {metadataFetchReport.titleQueries.map((query) => (
                            <span
                              key={query}
                              className="px-2 py-0.5 rounded-full bg-white border border-zinc-200 text-[10px] text-zinc-600 max-w-full truncate"
                              title={query}
                            >
                              {query}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {metadataFetchReport.steps.length > 0 ? (
                      <div className="space-y-2">
                        {metadataFetchReport.steps.map((step, index) => (
                          <div key={`${step.provider}-${step.query}-${index}`} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] font-semibold text-zinc-700">
                                {metadataStepProviderLabel(step.provider)}
                              </span>
                              <span className="px-1.5 py-0.5 rounded border border-zinc-200 bg-zinc-50 text-[10px] uppercase tracking-wide text-zinc-500">
                                {metadataStepStageLabel(step.stage)}
                              </span>
                              <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${metadataStepStatusClassName(step.status)}`}>
                                {metadataStepStatusLabel(step.status)}
                              </span>
                              {typeof step.score === "number" ? (
                                <span className="text-[10px] text-zinc-400">
                                  {t("metaPanel.metadataFlow.score", { value: step.score.toFixed(2) })}
                                </span>
                              ) : null}
                            </div>
                            <div className="text-[11px] text-zinc-500 font-mono break-all">
                              {step.query}
                            </div>
                            {step.fieldsChanged.length > 0 ? (
                              <div className="text-[11px] text-zinc-600">
                                {t("metaPanel.metadataFlow.fieldsChanged", {
                                  fields: step.fieldsChanged.join(", "),
                                })}
                              </div>
                            ) : null}
                            {step.note ? (
                              <div className="text-[11px] text-rose-600 break-words">
                                {t("metaPanel.metadataFlow.note", { note: step.note })}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-zinc-500">{t("metaPanel.metadataFlow.empty")}</p>
                    )}
                  </>
                ) : null}
              </div>
            )}
            {/* ── Notes section ───────────────────────────────────────── */}
            <div className="border-t border-zinc-100 pt-5 space-y-2">
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <StickyNote size={14} className="text-zinc-400" />
                  <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{t("metaPanel.notes.title")}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleGenerateAnnotationDigest}
                    disabled={!selectedItem || isGeneratingAnnotationDigest}
                    className="px-2 py-1 text-[10px] font-medium flex items-center gap-1 text-zinc-500 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors disabled:opacity-50"
                    title={t("metaPanel.notes.digestTitle")}
                  >
                    {isGeneratingAnnotationDigest ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                    {t("metaPanel.notes.digest")}
                  </button>
                  <button
                    onClick={async () => {
                      if (!selectedItem) return;
                      try {
                        const updatedNote = await invoke<{content: string} | null>("append_annotations_to_note", { itemId: selectedItem.id });
                        if (updatedNote) {
                          setNoteText(updatedNote.content);
                          feedback.success({
                            title: t("feedback.meta.extractSuccess.title"),
                            description: t("feedback.meta.extractSuccess.description"),
                          });
                        }
                      } catch (e) {
                        console.error("Failed to extract annotations", e);
                        feedback.error({
                          title: t("feedback.meta.extractError.title"),
                          description: t("feedback.meta.extractError.description"),
                        });
                      }
                    }}
                    className="px-2 py-1 text-[10px] font-medium flex items-center gap-1 text-zinc-500 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                    title={t("metaPanel.notes.extractTitle")}
                  >
                    <Wand2 size={12} />
                    {t("metaPanel.notes.extract")}
                  </button>
                </div>
              </div>
              {annotationDigest && (
                <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-3 space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700">
                        {t("metaPanel.notes.digestPreview")}
                      </span>
                      <span className="text-[10px] text-indigo-500">
                        {t("metaPanel.notes.digestStats", {
                          text: annotationDigest.stats.textAnnotations,
                          highlight: annotationDigest.stats.highlightStrokes,
                          ink: annotationDigest.stats.inkStrokes,
                        })}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed text-zinc-700">{annotationDigest.overview}</p>
                    <p className="text-xs leading-relaxed text-zinc-500">{annotationDigest.coverageNote}</p>
                  </div>
                  <div className="space-y-2">
                    {annotationDigest.sections.filter((section) => section.entries.length > 0).map((section) => (
                      <div key={section.id} className="rounded-lg border border-white/80 bg-white/80 p-2.5">
                        <div className="text-[11px] font-semibold text-zinc-700">{section.title}</div>
                        <div className="mt-1 text-[11px] text-zinc-500">{section.summary}</div>
                        <div className="mt-2 space-y-1.5">
                          {section.entries.slice(0, 3).map((entry, index) => (
                            <div key={`${section.id}-${entry.page}-${index}`} className="text-xs leading-relaxed text-zinc-600">
                              <span className="font-medium text-indigo-600">{t("metaPanel.annotations.page", { page: entry.page })}</span>
                              {" · "}
                              {entry.text}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      onClick={() => setAnnotationDigest(null)}
                      className="px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
                    >
                      {t("metaPanel.actions.cancel")}
                    </button>
                    <button
                      onClick={() => handleApplyAnnotationDigest("append")}
                      disabled={isApplyingAnnotationDigest}
                      className="px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                    >
                      {t("metaPanel.notes.digestAppend")}
                    </button>
                    <button
                      onClick={() => handleApplyAnnotationDigest("replace")}
                      disabled={isApplyingAnnotationDigest}
                      className="px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {isApplyingAnnotationDigest ? t("metaPanel.actions.savingWithDots") : t("metaPanel.notes.digestReplace")}
                    </button>
                  </div>
                </div>
              )}
              <textarea
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                rows={8}
                  placeholder={t("metaPanel.notes.placeholder")}
                className="w-full p-2.5 text-sm text-zinc-800 bg-zinc-50 border border-zinc-200 rounded-lg resize-y leading-relaxed outline-none focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400"
                spellCheck={false}
              />
              <div className="flex justify-end">
                <button
                  onClick={handleSaveNote}
                  disabled={isSavingNote || isLoadingNote || !selectedItem}
                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                >
                  {isSavingNote ? t("metaPanel.actions.savingWithDots") : t("metaPanel.notes.save")}
                </button>
              </div>
            </div>

            {/* ── Annotations section ─────────────────────────────────────── */}
            <div className="border-t border-zinc-100 pt-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Highlighter size={14} className="text-zinc-400" />
                  <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{t("metaPanel.annotations.title")}</span>
                </div>
                <button
                  onClick={handleExportAnnotations}
                  disabled={!hasAnnotations || isExportingAnnotations}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:border-indigo-200 hover:text-indigo-600 disabled:opacity-40"
                  title={t("metaPanel.annotations.export")}
                >
                  {isExportingAnnotations ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  {t("metaPanel.annotations.export")}
                </button>
              </div>
              
              {isLoadingAnnotations && !pdfAnnotations ? (
                <div className="py-4 text-center text-xs text-zinc-400 animate-pulse">{t("metaPanel.annotations.loading")}</div>
              ) : !hasAnnotations ? (
                <div className="py-4 text-center text-xs text-zinc-400 bg-zinc-50 rounded-lg border border-dashed border-zinc-200">
                  {t("metaPanel.annotations.empty")}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {ANNOTATION_FILTERS.map((filter) => (
                        <button
                          key={filter.id}
                          onClick={() => setAnnotationFilter(filter.id)}
                          className={[
                            "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                            annotationFilter === filter.id
                              ? "border-indigo-600 bg-indigo-600 text-white"
                              : "border-zinc-200 bg-white text-zinc-500 hover:border-indigo-300 hover:text-indigo-600",
                          ].join(" ")}
                        >
                          {t(filter.labelKey)}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="relative min-w-0 flex-1">
                        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                        <input
                          type="text"
                          value={annotationSearchQuery}
                          onChange={(event) => setAnnotationSearchQuery(event.target.value)}
                          placeholder={t("metaPanel.annotations.searchPlaceholder")}
                          className="w-full rounded-lg border border-transparent bg-white py-2 pl-9 pr-3 text-sm text-zinc-700 outline-none transition-colors focus:border-indigo-300 focus:ring-2 focus:ring-indigo-400/15"
                        />
                      </div>
                      <span className="shrink-0 text-[11px] font-medium text-zinc-400">
                        {t("metaPanel.annotations.results", {
                          visible: filteredAnnotationEntries.length,
                          total: annotationEntries.length,
                        })}
                      </span>
                    </div>
                  </div>

                  {filteredAnnotationEntries.length === 0 ? (
                    <div className="py-4 text-center text-xs text-zinc-400 bg-zinc-50 rounded-lg border border-dashed border-zinc-200">
                      {hasActiveAnnotationFilters
                        ? t("metaPanel.annotations.emptyFiltered")
                        : t("metaPanel.annotations.empty")}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filteredAnnotationEntries.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => onPageJump && onPageJump(entry.page)}
                          className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-left transition-colors hover:border-indigo-200 hover:bg-indigo-50/40"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600">
                                  {t("metaPanel.annotations.page", { page: entry.page })}
                                </span>
                                <span className={[
                                  "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                                  entry.type === "text"
                                    ? "bg-indigo-50 text-indigo-600"
                                    : entry.type === "highlight"
                                      ? "bg-amber-50 text-amber-700"
                                      : "bg-sky-50 text-sky-700",
                                ].join(" ")}>
                                  {annotationEntryTitle(entry)}
                                </span>
                              </div>
                              <p className="text-sm leading-relaxed text-zinc-700">
                                {annotationEntryPreview(entry)}
                              </p>
                            </div>
                            <span className="text-[10px] text-zinc-400">{entry.type === "text" ? t("metaPanel.annotations.jump") : t("metaPanel.annotations.jumpToPage")}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Cite section ─────────────────────────────────────────── */}
            <div className="border-t border-zinc-100 pt-5">
              <div className="flex items-center gap-1.5 mb-3">
                <Quote size={14} className="text-zinc-400" />
                <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{t("metaPanel.cite.title")}</span>
              </div>
              {/* Format tabs */}
              <div className="flex flex-wrap gap-1 mb-3">
                {CITE_FORMATS.map(f => (
                  <button
                    key={f}
                    onClick={() => setCiteFormat(f)}
                    className={[
                      "px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors",
                      citeFormat === f
                        ? "bg-indigo-600 text-white border-indigo-600"
                        : "bg-white text-zinc-500 border-zinc-200 hover:border-indigo-300 hover:text-indigo-600",
                    ].join(" ")}
                  >
                    {citationFormatLabel(f)}
                  </button>
                ))}
              </div>
              {/* Citation output */}
              <div className="relative">
                <textarea
                  readOnly
                  value={citeText}
                  rows={4}
                  className="w-full p-2.5 text-xs font-mono text-zinc-700 bg-zinc-50 border border-zinc-200 rounded-lg resize-none leading-relaxed outline-none"
                  spellCheck={false}
                />
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(citeText);
                    setCiteCopied(true);
                    setTimeout(() => setCiteCopied(false), 2000);
                  }}
                  disabled={!citeText}
                  className="absolute top-2 right-2 p-1 rounded bg-white border border-zinc-200 text-zinc-400 hover:text-indigo-600 hover:border-indigo-300 transition-colors disabled:opacity-30"
                  title={t("metaPanel.cite.copyTitle")}
                >
                  {citeCopied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function MetaRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start space-x-3">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-0.5">{label}</p>
        <div className="text-sm text-zinc-800 leading-snug">{children}</div>
      </div>
    </div>
  );
}

function EditField({ 
  label, 
  value, 
  onChange, 
  isTextArea = false, 
  rows = 3,
  placeholder = ""
}: { 
  label: string, 
  value: string, 
  onChange: (v: string) => void,
  isTextArea?: boolean,
  rows?: number,
  placeholder?: string
}) {
  return (
    <div className="flex flex-col space-y-1">
      <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{label}</label>
      {isTextArea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          className="w-full text-sm p-2 border border-zinc-200 rounded-md bg-white text-zinc-800 placeholder:text-zinc-300 focus:outline-none focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 transition-shadow resize-y min-h-[60px]"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full text-sm p-1.5 border border-zinc-200 rounded-md bg-white text-zinc-800 placeholder:text-zinc-300 focus:outline-none focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 transition-shadow"
        />
      )}
    </div>
  );
}
