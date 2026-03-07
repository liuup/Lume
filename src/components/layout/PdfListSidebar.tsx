import { useState } from "react";
import { ChevronRight, Folder, FolderOpen, FileText, Plus, FileUp, Search } from "lucide-react";
import { FolderNode, PdfEntry } from "../../App";

interface PdfListSidebarProps {
  folderTree: FolderNode[];
  selectedFolderId: string;
  selectedPdfId: string | null;
  onSelectFolder: (id: string) => void;
  onSelectPdf: (id: string) => void;
  onOpenPdf: (pdf: PdfEntry) => void;
  onAddPdf: () => void;
  onAddFolder: (parentId: string) => void;
}

export function PdfListSidebar({
  folderTree,
  selectedFolderId,
  selectedPdfId,
  onSelectFolder,
  onSelectPdf,
  onOpenPdf,
  onAddPdf,
  onAddFolder,
}: PdfListSidebarProps) {
  const [query, setQuery] = useState("");

  // Collect PDFs from the selected folder
  function getSelectedFolderPdfs(nodes: FolderNode[]): PdfEntry[] {
    for (const n of nodes) {
      if (n.id === selectedFolderId) return n.pdfs;
      const nested = getSelectedFolderPdfs(n.children);
      if (nested.length > 0 || n.children.find(c => c.id === selectedFolderId)) {
        // recurse; but we need to also check nested
      }
      const fromChild = getDeepPdfs(n, selectedFolderId);
      if (fromChild !== null) return fromChild;
    }
    return [];
  }

  function getDeepPdfs(node: FolderNode, targetId: string): PdfEntry[] | null {
    if (node.id === targetId) return node.pdfs;
    for (const child of node.children) {
      const result = getDeepPdfs(child, targetId);
      if (result !== null) return result;
    }
    return null;
  }

  const folderPdfs = getSelectedFolderPdfs(folderTree);

  const filteredPdfs = query.trim()
    ? folderPdfs.filter(p =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.meta.authors.toLowerCase().includes(query.toLowerCase())
      )
    : folderPdfs;

  return (
    <aside className="w-64 bg-zinc-50 border-r border-zinc-200 flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="h-14 border-b border-zinc-200 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center space-x-2">
          <div className="w-6 h-6 bg-indigo-600 rounded-md flex items-center justify-center shadow-sm">
            <span className="text-white font-bold text-xs">L</span>
          </div>
          <h2 className="font-semibold text-zinc-800 tracking-tight">Lume</h2>
        </div>
        <button
          onClick={onAddPdf}
          className="p-1.5 text-zinc-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
          title="Open PDF"
        >
          <FileUp size={17} />
        </button>
      </div>

      {/* Search */}
      <div className="p-3 border-b border-zinc-200 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" size={13} />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search papers..."
            className="w-full pl-8 pr-3 py-1.5 bg-white border border-zinc-200 rounded-md text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 transition-all placeholder:text-zinc-400"
          />
        </div>
      </div>

      {/* Folder Tree */}
      <div className="shrink-0 border-b border-zinc-200 px-2 py-2 max-h-48 overflow-y-auto">
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

      {/* PDF List for selected folder */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {filteredPdfs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-24 text-zinc-400 text-xs space-y-2">
            <FileText size={22} className="opacity-40" />
            <span>No PDFs — use <FileUp size={11} className="inline" /> to add</span>
          </div>
        ) : (
          filteredPdfs.map(pdf => (
            <PdfRow
              key={pdf.id}
              pdf={pdf}
              isSelected={selectedPdfId === pdf.id}
              onSelect={() => onSelectPdf(pdf.id)}
              onOpen={() => onOpenPdf(pdf)}
            />
          ))
        )}
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

/* ── PDF row ── */
function PdfRow({
  pdf,
  isSelected,
  onSelect,
  onOpen,
}: {
  pdf: PdfEntry;
  isSelected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className={`group flex items-center space-x-2.5 px-3 py-2 rounded-md cursor-pointer transition-colors select-none ${
        isSelected
          ? "bg-indigo-50 text-indigo-700"
          : "text-zinc-600 hover:bg-zinc-100"
      }`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      title="Double-click to open"
    >
      <FileText
        size={15}
        className={`shrink-0 ${isSelected ? "text-indigo-500" : "text-zinc-400"}`}
      />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-[13px] font-medium truncate leading-tight">{pdf.meta.title || pdf.name}</span>
        {pdf.meta.authors !== "—" && (
          <span className="text-[10px] opacity-60 truncate leading-tight mt-0.5">
            {pdf.meta.authors}{pdf.meta.year !== "—" ? ` · ${pdf.meta.year}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}