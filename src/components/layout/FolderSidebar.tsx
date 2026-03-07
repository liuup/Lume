import { useState } from "react";
import { ChevronRight, Folder, FolderOpen, Plus, FileUp } from "lucide-react";
import { FolderNode } from "../../App";

interface FolderSidebarProps {
  folderTree: FolderNode[];
  selectedFolderId: string;
  onSelectFolder: (id: string) => void;
  onAddFolder: (parentId: string) => void;
  onAddPdf: () => void;
}

export function FolderSidebar({
  folderTree,
  selectedFolderId,
  onSelectFolder,
  onAddFolder,
  onAddPdf,
}: FolderSidebarProps) {
  return (
    <aside className="w-64 bg-zinc-50 border-r border-zinc-200 flex flex-col h-full shrink-0">
      <div className="p-4 border-b border-zinc-200 shrink-0 font-semibold text-zinc-700 text-sm">
        Library Folders
      </div>

      {/* Folder Tree */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {folderTree.map(node => (
          <FolderTreeItem
            key={node.id}
            node={node}
            depth={0}
            selectedFolderId={selectedFolderId}
            onSelectFolder={onSelectFolder}
            onAddFolder={onAddFolder}
          />
        ))}
      </div>

      {/* Bottom Action Bar */}
      <div className="p-3 border-t border-zinc-200 shrink-0">
        <button
          onClick={onAddPdf}
          className="w-full flex items-center justify-center space-x-2 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 transition-colors shadow-sm active:scale-[0.98]"
        >
          <FileUp size={15} />
          <span>Import PDF</span>
        </button>
      </div>
    </aside>
  );
}

/* ── Folder tree item (recursive) ── */
function FolderTreeItem({
  node,
  depth,
  selectedFolderId,
  onSelectFolder,
  onAddFolder,
}: {
  node: FolderNode;
  depth: number;
  selectedFolderId: string;
  onSelectFolder: (id: string) => void;
  onAddFolder: (parentId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const isSelected = node.id === selectedFolderId;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={`group flex items-center space-x-1.5 px-2 py-1.5 rounded-md cursor-pointer select-none transition-colors ${
          isSelected
            ? "bg-indigo-50 text-indigo-700"
            : "text-zinc-600 hover:bg-zinc-100"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => { onSelectFolder(node.id); }}
      >
        {/* Chevron toggle */}
        <button
          className={`shrink-0 text-zinc-400 hover:text-zinc-600 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
        >
          <ChevronRight size={13} />
        </button>

        {open && hasChildren ? (
          <FolderOpen size={14} className="shrink-0 text-indigo-400" />
        ) : (
          <Folder size={14} className={`shrink-0 ${isSelected ? "text-indigo-500" : "text-zinc-400"}`} />
        )}

        <span className="text-[13px] font-medium flex-1 truncate">{node.name}</span>

        {/* Add sub-folder button shown on hover */}
        <button
          className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-indigo-500 transition-opacity shrink-0"
          title="New sub-folder"
          onClick={e => { e.stopPropagation(); onAddFolder(node.id); }}
        >
          <Plus size={12} />
        </button>
      </div>

      {open && hasChildren && (
        <div>
          {node.children.map(child => (
            <FolderTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              onSelectFolder={onSelectFolder}
              onAddFolder={onAddFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
}