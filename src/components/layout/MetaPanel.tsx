import { Tag, Calendar, User, AlignLeft, X, FileText, Fingerprint, Orbit, Edit2, Check, Book, Building, Link2, Copy, Quote } from "lucide-react";
import { LibraryItem } from "../../types";
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CitationFormat } from "./ExportModal";

const CITE_FORMATS: { id: CitationFormat; label: string }[] = [
  { id: "apa",     label: "APA" },
  { id: "mla",     label: "MLA" },
  { id: "chicago", label: "Chicago" },
  { id: "gbt",     label: "GB/T" },
  { id: "bibtex",  label: "BibTeX" },
  { id: "ris",     label: "RIS" },
];

interface MetaPanelProps {
  selectedItem: LibraryItem | null;
  isOpen: boolean;
  onClose: () => void;
  onItemUpdated?: () => void;
  tagColors?: Record<string, string>;
}

export function MetaPanel({ selectedItem, isOpen, onClose, onItemUpdated, tagColors = {} }: MetaPanelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<LibraryItem>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const tagInputRef = useRef<HTMLInputElement>(null);

  // ── Citation state ───────────────────────────────────────────────────────
  const [citeFormat, setCiteFormat] = useState<CitationFormat>("apa");
  const [citeText, setCiteText] = useState("");
  const [citeCopied, setCiteCopied] = useState(false);

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
    } catch (error) {
      console.error("Failed to update metadata", error);
      alert("Failed to save changes.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleStringChange = (field: keyof LibraryItem, value: string) => {
    setEditFormData(prev => ({ ...prev, [field]: value }));
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
    <aside className="w-80 bg-white border-l border-zinc-200 flex flex-col h-full shrink-0 transition-all duration-300">
      {/* Header */}
      <div className="h-14 border-b border-zinc-200 flex items-center justify-between px-4 shrink-0 bg-zinc-50/50">
        <h2 className="font-semibold text-zinc-800 tracking-tight">Info</h2>
        <div className="flex items-center space-x-1">
          {selectedItem && (
            isEditing ? (
               <button
                 onClick={handleSave}
                 disabled={isSaving}
                 className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-md transition-colors flex items-center gap-1 text-xs font-medium"
                 title="Save changes"
               >
                 <Check size={14} />
                 {isSaving ? "Saving" : "Save"}
               </button>
            ) : (
               <button
                 onClick={() => setIsEditing(true)}
                 className="p-1.5 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded-md transition-colors flex items-center gap-1 text-xs font-medium"
                 title="Edit metadata"
               >
                 <Edit2 size={14} />
                 Edit
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
            title={isEditing ? "Cancel edit" : "Close panel"}
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
              Select a paper from the list to view its info
            </p>
          </div>
        ) : isEditing ? (
          <div className="p-5 space-y-4">
            <EditField label="Title" value={editFormData.title || ""} onChange={v => handleStringChange('title', v)} isTextArea />
            <EditField label="Authors" value={editFormData.authors || ""} onChange={v => handleStringChange('authors', v)} placeholder="Comma-separated authors" />
            
            <div className="grid grid-cols-2 gap-3">
              <EditField label="Year" value={editFormData.year || ""} onChange={v => handleStringChange('year', v)} />
              <EditField label="Language" value={editFormData.language || ""} onChange={v => handleStringChange('language', v)} />
            </div>

            {/* Pill tag editor */}
            <div className="flex flex-col space-y-1">
              <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Tags</label>
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
                  placeholder={(editFormData.tags || []).length === 0 ? "Type a tag, press Enter or comma" : ""}
                  className="flex-1 min-w-[120px] text-sm bg-transparent outline-none placeholder:text-zinc-300"
                />
              </div>
              <p className="text-[10px] text-zinc-400">Press Enter or comma to add · Backspace to remove last</p>
            </div>

            <div className="border-t border-zinc-100 pt-4 mt-2 space-y-4">
              <EditField label="Publication" value={editFormData.publication || ""} onChange={v => handleStringChange('publication', v)} />
              
              <div className="grid grid-cols-3 gap-3">
                <EditField label="Vol." value={editFormData.volume || ""} onChange={v => handleStringChange('volume', v)} />
                <EditField label="Issue" value={editFormData.issue || ""} onChange={v => handleStringChange('issue', v)} />
                <EditField label="Pages" value={editFormData.pages || ""} onChange={v => handleStringChange('pages', v)} />
              </div>

              <EditField label="Publisher" value={editFormData.publisher || ""} onChange={v => handleStringChange('publisher', v)} />
              
              <div className="grid grid-cols-2 gap-3">
                <EditField label="DOI" value={editFormData.doi || ""} onChange={v => handleStringChange('doi', v)} />
                <EditField label="arXiv" value={editFormData.arxiv_id || ""} onChange={v => handleStringChange('arxiv_id', v)} />
              </div>
              
              <EditField label="ISBN" value={editFormData.isbn || ""} onChange={v => handleStringChange('isbn', v)} />
              <EditField label="URL" value={editFormData.url || ""} onChange={v => handleStringChange('url', v)} />
            </div>

            <div className="border-t border-zinc-100 pt-4 mt-2">
              <EditField label="Abstract" value={editFormData.abstract || ""} onChange={v => handleStringChange('abstract', v)} isTextArea rows={8} />
            </div>

            <div className="flex justify-end pt-4 pb-8 space-x-2">
              <button 
                onClick={() => setIsEditing(false)}
                className="px-3 py-1.5 text-xs font-medium text-zinc-600 bg-white border border-zinc-200 rounded hover:bg-zinc-50 transition-colors"
                disabled={isSaving}
              >
                Cancel
              </button>
              <button 
                onClick={handleSave}
                className="px-3 py-1.5 text-xs font-medium text-white bg-zinc-800 rounded hover:bg-zinc-900 transition-colors"
                disabled={isSaving}
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-6">
            {/* Title & tags */}
            <div>
              <h3 className="text-base font-bold text-zinc-900 leading-tight">
                {selectedItem.title || selectedItem.attachments[0]?.name || "Untitled"}
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
              <MetaRow icon={<User size={15} className="text-zinc-400" />} label="Authors">
                {selectedItem.authors && selectedItem.authors !== "—" ? selectedItem.authors : (
                  <span className="text-zinc-400 italic">Unknown</span>
                )}
              </MetaRow>

              {/* Year */}
              <MetaRow icon={<Calendar size={15} className="text-zinc-400" />} label="Year">
                {selectedItem.year && selectedItem.year !== "—" ? selectedItem.year : (
                  <span className="text-zinc-400 italic">Unknown</span>
                )}
              </MetaRow>

              {/* Abstract */}
              {selectedItem.abstract ? (
                <MetaRow icon={<AlignLeft size={15} className="text-zinc-400" />} label="Abstract">
                  <p className="text-sm text-zinc-600 leading-relaxed max-w-full overflow-hidden text-ellipsis">{selectedItem.abstract}</p>
                </MetaRow>
              ) : null}

              {/* Publication Info */}
              {selectedItem.publication ? (
                <MetaRow icon={<Book size={15} className="text-zinc-400" />} label="Publication">
                  <span className="text-zinc-600">
                    <em className="font-serif">{selectedItem.publication}</em>
                    {selectedItem.volume ? ` vol. ${selectedItem.volume}` : ''}
                    {selectedItem.issue ? ` no. ${selectedItem.issue}` : ''}
                    {selectedItem.pages ? ` pp. ${selectedItem.pages}` : ''}
                  </span>
                </MetaRow>
              ) : null}

              {/* Publisher */}
              {selectedItem.publisher ? (
                <MetaRow icon={<Building size={15} className="text-zinc-400" />} label="Publisher">
                   <span className="text-zinc-600">{selectedItem.publisher}</span>
                </MetaRow>
              ) : null}

              {/* DOI */}
              {selectedItem.doi ? (
                <MetaRow icon={<Fingerprint size={15} className="text-zinc-400" />} label="DOI">
                  <a href={`https://doi.org/${selectedItem.doi}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline break-all">
                    {selectedItem.doi}
                  </a>
                </MetaRow>
              ) : null}

              {/* arXiv */}
              {selectedItem.arxiv_id ? (
                <MetaRow icon={<Orbit size={15} className="text-zinc-400" />} label="arXiv">
                  <a href={`https://arxiv.org/abs/${selectedItem.arxiv_id}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline break-all">
                    {selectedItem.arxiv_id}
                  </a>
                </MetaRow>
              ) : null}

              {/* URL */}
              {selectedItem.url ? (
                <MetaRow icon={<Link2 size={15} className="text-zinc-400" />} label="URL">
                  <a href={selectedItem.url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline break-all line-clamp-2" title={selectedItem.url}>
                    {selectedItem.url}
                  </a>
                </MetaRow>
              ) : null}

              {/* Filename */}
              <MetaRow icon={<Tag size={15} className="text-zinc-400" />} label="File">
                <span className="text-zinc-500 text-xs font-mono break-all line-clamp-2" title={selectedItem.attachments[0]?.name}>{selectedItem.attachments[0]?.name || "None"}</span>
              </MetaRow>
            </div>

            {/* ── Cite section ─────────────────────────────────────────── */}
            <div className="border-t border-zinc-100 pt-5">
              <div className="flex items-center gap-1.5 mb-3">
                <Quote size={14} className="text-zinc-400" />
                <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Cite</span>
              </div>
              {/* Format tabs */}
              <div className="flex flex-wrap gap-1 mb-3">
                {CITE_FORMATS.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setCiteFormat(f.id)}
                    className={[
                      "px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors",
                      citeFormat === f.id
                        ? "bg-indigo-600 text-white border-indigo-600"
                        : "bg-white text-zinc-500 border-zinc-200 hover:border-indigo-300 hover:text-indigo-600",
                    ].join(" ")}
                  >
                    {f.label}
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
                  title="Copy citation"
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