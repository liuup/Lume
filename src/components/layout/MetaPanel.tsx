import { Tag, Calendar, User, AlignLeft, X, FileText, Fingerprint, Orbit, Edit2, Check, Book, Building, Link2, Copy, Quote, StickyNote, Wand2, Highlighter } from "lucide-react";
import { LibraryItem, SavedPdfAnnotationsDocument } from "../../types";
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

export function MetaPanel({ selectedItem, isOpen, onClose, onItemUpdated, tagColors = {}, onPageJump, annotationsRefreshKey = 0 }: MetaPanelProps) {
  const { t } = useI18n();
  const feedback = useFeedback();
  const [isEditing, setIsEditing] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<LibraryItem>>({});
  const [isSaving, setIsSaving] = useState(false);
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

  // ── Annotations list state ───────────────────────────────────────────────────
  const [pdfAnnotations, setPdfAnnotations] = useState<SavedPdfAnnotationsDocument | null>(null);
  const [isLoadingAnnotations, setIsLoadingAnnotations] = useState(false);
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

  return (
    <aside className="w-80 bg-white border-l border-zinc-200 flex flex-col h-full shrink-0 animate-slide-left">
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
               <button
                 onClick={() => setIsEditing(true)}
                 className="p-1.5 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded-md transition-colors flex items-center gap-1 text-xs font-medium"
                 title={t("metaPanel.actions.editMetadata")}
               >
                 <Edit2 size={14} />
                 {t("metaPanel.actions.edit")}
               </button>
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

            {/* ── Notes section ───────────────────────────────────────── */}
            <div className="border-t border-zinc-100 pt-5 space-y-2">
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <StickyNote size={14} className="text-zinc-400" />
                  <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{t("metaPanel.notes.title")}</span>
                </div>
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
              <div className="flex items-center gap-1.5">
                <Highlighter size={14} className="text-zinc-400" />
                 <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{t("metaPanel.annotations.title")}</span>
              </div>
              
                {isLoadingAnnotations && !pdfAnnotations ? (
                  <div className="py-4 text-center text-xs text-zinc-400 animate-pulse">{t("metaPanel.annotations.loading")}</div>
              ) : !pdfAnnotations || Object.keys(pdfAnnotations.pages).length === 0 || !Object.values(pdfAnnotations.pages).some(p => (p.textAnnotations?.length ?? 0) > 0 || (p.paths?.length ?? 0) > 0) ? (
                 <div className="py-4 text-center text-xs text-zinc-400 bg-zinc-50 rounded-lg border border-dashed border-zinc-200">
                    {t("metaPanel.annotations.empty")}
                 </div>
              ) : (
                <div className="space-y-3">
                  {Object.entries(pdfAnnotations.pages)
                    .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))
                    .map(([pageKey, pageData]) => {
                      const pageIdx = parseInt(pageKey, 10);
                      const displayPage = pageIdx + 1;
                      const textAnnotations = pageData.textAnnotations ?? [];
                      const paths = pageData.paths ?? [];
                      
                      const hasItems = textAnnotations.length > 0 || paths.length > 0;
                      if (!hasItems) return null;

                      // Sort text annotations top to bottom
                      const sortedTextAnns = [...textAnnotations].sort((a, b) => a.y - b.y);

                      return (
                        <div key={pageKey} className="text-sm">
                          <div 
                            className="font-semibold text-xs text-indigo-600 mb-1 cursor-pointer hover:underline inline-block"
                            onClick={() => onPageJump && onPageJump(displayPage)}
                          >
                            {t("metaPanel.annotations.page", { page: displayPage })}
                          </div>
                          <div className="space-y-2">
                            {/* Render Text Annotations */}
                            {sortedTextAnns.map((ta, i) => (
                              <div 
                                key={`ta-${i}`} 
                                className="pl-3 border-l-2 border-indigo-200 py-0.5 text-zinc-700 bg-zinc-50/50 rounded-r-md cursor-pointer hover:bg-zinc-100 transition-colors"
                                onClick={() => onPageJump && onPageJump(displayPage)}
                              >
                                {ta.text}
                              </div>
                            ))}
                            {/* Render Draw/Highlight summaries (if any, keeping it compact) */}
                            {paths.length > 0 && (
                               <div 
                                 className="pl-3 py-0.5 flex items-center gap-2 cursor-pointer hover:opacity-80"
                                 onClick={() => onPageJump && onPageJump(displayPage)}
                               >
                                  <div className="w-4 h-4 rounded bg-yellow-200/50 flex items-center justify-center border border-yellow-300">
                                    <Highlighter size={10} className="text-yellow-600" />
                                  </div>
                                  <span className="text-xs text-zinc-500">{paths.length === 1
                                    ? t("metaPanel.annotations.actions.one", { count: paths.length })
                                    : t("metaPanel.annotations.actions.other", { count: paths.length })}</span>
                               </div>
                            )}
                          </div>
                        </div>
                      );
                  })}
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