import { useState } from "react";
import { FileText, FileUp, Search } from "lucide-react";
import { FolderNode, PdfEntry } from "../../App";

interface LibraryViewProps {
  folderTree: FolderNode[];
  selectedFolderId: string;
  selectedPdfId: string | null;
  onSelectPdf: (id: string) => void;
  onOpenPdf: (pdf: PdfEntry) => void;
  onAddPdf: () => void;
}

export function LibraryView({
  folderTree,
  selectedFolderId,
  selectedPdfId,
  onSelectPdf,
  onOpenPdf,
  onAddPdf,
}: LibraryViewProps) {
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
    <div className="flex-1 flex flex-col h-full bg-white relative">
      {/* Search Header */}
      <div className="h-14 border-b border-zinc-200 flex items-center px-6 shrink-0 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={16} />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search papers by title or author..."
            className="w-full pl-10 pr-4 py-2 bg-zinc-100 border-transparent focus:bg-white border focus:border-indigo-400 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-400/20 transition-all placeholder:text-zinc-400 shadow-sm"
          />
        </div>
      </div>

      {/* PDF Grid/List */}
      <div className="flex-1 overflow-y-auto p-6">
        {filteredPdfs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-zinc-400 space-y-4 mt-10">
            <div className="w-16 h-16 bg-zinc-50 rounded-2xl flex items-center justify-center border border-zinc-200/60 shadow-sm">
              <FileText size={32} className="opacity-40" />
            </div>
            <p className="text-sm">No PDFs in this folder</p>
            <button
              onClick={onAddPdf}
              className="flex items-center space-x-2 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors shadow-sm"
            >
              <FileUp size={16} />
              <span>Import PDF</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredPdfs.map(pdf => (
              <PdfCard
                key={pdf.id}
                pdf={pdf}
                isSelected={selectedPdfId === pdf.id}
                onSelect={() => onSelectPdf(pdf.id)}
                onOpen={() => onOpenPdf(pdf)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfCard({
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
      className={`group flex flex-col p-4 rounded-xl cursor-pointer transition-all select-none border shadow-sm ${
        isSelected
          ? "bg-indigo-50 border-indigo-200 shadow-indigo-100/50"
          : "bg-white border-zinc-200 hover:border-indigo-300 hover:shadow-md"
      }`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      title="Double-click to open"
    >
      <div className="flex items-start space-x-3 mb-2">
        <div className={`p-2 rounded-lg ${isSelected ? "bg-indigo-100 text-indigo-600" : "bg-zinc-100 text-zinc-500 group-hover:text-indigo-500 transition-colors"}`}>
          <FileText size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-zinc-800 line-clamp-2 leading-snug group-hover:text-indigo-900 transition-colors">
            {pdf.meta.title || pdf.name}
          </h3>
        </div>
      </div>
      
      <div className="mt-auto pt-2 flex flex-col space-y-1">
        <span className="text-xs font-medium text-zinc-500 truncate">
          {pdf.meta.authors !== "—" ? pdf.meta.authors : "Unknown Author"}
        </span>
        <span className="text-[11px] text-zinc-400">
          {pdf.meta.year !== "—" ? pdf.meta.year : "No Year"}
        </span>
      </div>
    </div>
  );
}
