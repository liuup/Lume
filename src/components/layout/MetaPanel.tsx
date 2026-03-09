import { Tag, Calendar, User, AlignLeft, X, FileText, Fingerprint, Orbit, Edit2, Check, Book, Building, Link2 } from "lucide-react";
import { LibraryItem } from "../../App";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface MetaPanelProps {
  selectedItem: LibraryItem | null;
  isOpen: boolean;
  onClose: () => void;
  onItemUpdated?: () => void;
}

export function MetaPanel({ selectedItem, isOpen, onClose, onItemUpdated }: MetaPanelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<LibraryItem>>({});
  const [isSaving, setIsSaving] = useState(false);

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

  const handleTagsChange = (value: string) => {
    // Basic comma-separated tagging for now
    const tagsArray = value.split(',').map(t => t.trim()).filter(t => t.length > 0);
    setEditFormData(prev => ({ ...prev, tags: tagsArray }));
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

            <EditField label="Tags" value={(editFormData.tags || []).join(', ')} onChange={handleTagsChange} placeholder="Comma-separated tags" />

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
                  {selectedItem.tags.map(tag => (
                    <span
                      key={tag}
                      className="px-2 py-0.5 bg-indigo-50 text-indigo-700 text-[10px] font-semibold rounded-full uppercase tracking-wider"
                    >
                      {tag}
                    </span>
                  ))}
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