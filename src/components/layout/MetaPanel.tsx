import { Tag, Calendar, User, AlignLeft, X, FileText, Fingerprint, Orbit } from "lucide-react";
import { LibraryItem } from "../../App";

interface MetaPanelProps {
  selectedItem: LibraryItem | null;
  isOpen: boolean;
  onClose: () => void;
}

export function MetaPanel({ selectedItem, isOpen, onClose }: MetaPanelProps) {
  if (!isOpen) return null;

  return (
    <aside className="w-72 bg-white border-l border-zinc-200 flex flex-col h-full shrink-0 transition-all duration-300">
      {/* Header */}
      <div className="h-14 border-b border-zinc-200 flex items-center justify-between px-4 shrink-0 bg-zinc-50/50">
        <h2 className="font-semibold text-zinc-800 tracking-tight">Info</h2>
        <button
          onClick={onClose}
          className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-md transition-colors"
          title="Close panel"
        >
          <X size={15} />
        </button>
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
                {selectedItem.authors !== "—" ? selectedItem.authors : (
                  <span className="text-zinc-400 italic">Unknown</span>
                )}
              </MetaRow>

              {/* Year */}
              <MetaRow icon={<Calendar size={15} className="text-zinc-400" />} label="Year">
                {selectedItem.year !== "—" ? selectedItem.year : (
                  <span className="text-zinc-400 italic">Unknown</span>
                )}
              </MetaRow>

              {/* Abstract */}
              {selectedItem.abstract ? (
                <MetaRow icon={<AlignLeft size={15} className="text-zinc-400" />} label="Abstract">
                  <p className="text-sm text-zinc-600 leading-relaxed">{selectedItem.abstract}</p>
                </MetaRow>
              ) : null}

              {/* DOI */}
              {selectedItem.doi ? (
                <MetaRow icon={<Fingerprint size={15} className="text-zinc-400" />} label="DOI">
                  <span className="text-zinc-600 break-all">{selectedItem.doi}</span>
                </MetaRow>
              ) : null}

              {/* arXiv */}
              {selectedItem.arxiv_id ? (
                <MetaRow icon={<Orbit size={15} className="text-zinc-400" />} label="arXiv">
                  <span className="text-zinc-600 break-all">{selectedItem.arxiv_id}</span>
                </MetaRow>
              ) : null}

              {/* Filename */}
              <MetaRow icon={<Tag size={15} className="text-zinc-400" />} label="File">
                <span className="text-zinc-500 text-xs font-mono break-all">{selectedItem.attachments[0]?.name || "None"}</span>
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
      <div className="min-w-0">
        <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-0.5">{label}</p>
        <div className="text-sm text-zinc-800 leading-snug">{children}</div>
      </div>
    </div>
  );
}