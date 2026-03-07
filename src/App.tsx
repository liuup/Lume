import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toolbar } from "./components/Toolbar";
import { PdfViewer } from "./components/PdfViewer";
import { PdfListSidebar } from "./components/layout/PdfListSidebar";
import { MetaPanel } from "./components/layout/MetaPanel";

export type PageDimension = { width: number; height: number };
export type ToolType = 'none' | 'draw' | 'highlight' | 'text-highlight';

export interface PdfMeta {
  title: string;
  authors: string;
  year: string;
  abstract: string;
  tags: string[];
}

export interface PdfEntry {
  id: string;
  name: string;
  path: string;
  meta: PdfMeta;
}

export interface FolderNode {
  id: string;
  name: string;
  children: FolderNode[];
  pdfs: PdfEntry[];
}

// Generate a simple unique id
function uid(): string {
  return Math.random().toString(36).slice(2);
}

const DEFAULT_FOLDER: FolderNode = {
  id: "root",
  name: "My Library",
  children: [],
  pdfs: [],
};

function App() {
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [dimensions, setDimensions] = useState<PageDimension[]>([]);
  const [scale, setScale] = useState<number>(1.5);
  const [activeTool, setActiveTool] = useState<ToolType>('none');
  const [isLoading, setIsLoading] = useState(false);

  // Library state
  const [folderTree, setFolderTree] = useState<FolderNode[]>([DEFAULT_FOLDER]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("root");
  const [selectedPdfId, setSelectedPdfId] = useState<string | null>(null);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);

  const zoomIn = () => setScale(s => Math.min(s + 0.25, 4.0));
  const zoomOut = () => setScale(s => Math.max(s - 0.25, 0.5));

  // Find a folder by id (recursive)
  function findFolder(nodes: FolderNode[], id: string): FolderNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      const found = findFolder(n.children, id);
      if (found) return found;
    }
    return null;
  }

  // Add a PDF entry into the selected folder
  function addPdfToFolder(path: string) {
    const fileName = path.split("/").pop() ?? path;
    const newPdf: PdfEntry = {
      id: uid(),
      name: fileName.replace(/\.pdf$/i, ""),
      path,
      meta: {
        title: fileName.replace(/\.pdf$/i, ""),
        authors: "—",
        year: "—",
        abstract: "",
        tags: [],
      },
    };

    setFolderTree(prev => {
      const clone = JSON.parse(JSON.stringify(prev)) as FolderNode[];
      const folder = findFolder(clone, selectedFolderId);
      if (folder) folder.pdfs.push(newPdf);
      return clone;
    });

    setSelectedPdfId(newPdf.id);
  }

  // Handle adding a PDF via the open dialog (called from sidebar)
  const handleAddPdf = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (selected && typeof selected === "string") {
        setIsLoading(true);
        const pages: number = await invoke("load_pdf", { path: selected });
        const dims: PageDimension[] = await invoke("get_pdf_dimensions");
        addPdfToFolder(selected);
        // Also open it immediately
        setPdfPath(selected);
        setTotalPages(pages);
        setDimensions(dims);
        setIsLoading(false);
      }
    } catch (err) {
      console.error("Failed to open PDF", err);
      setIsLoading(false);
    }
  };

  // Called when user double-clicks a PDF in the list — opens it in the viewer
  const handleOpenPdf = async (pdf: PdfEntry) => {
    try {
      setIsLoading(true);
      const pages: number = await invoke("load_pdf", { path: pdf.path });
      const dims: PageDimension[] = await invoke("get_pdf_dimensions");
      setPdfPath(pdf.path);
      setTotalPages(pages);
      setDimensions(dims);
      setIsLoading(false);
    } catch (err) {
      console.error("Failed to open PDF", err);
      setIsLoading(false);
    }
  };

  // Find the currently selected PDF across all folders
  function findPdf(nodes: FolderNode[], id: string): PdfEntry | null {
    for (const n of nodes) {
      const found = n.pdfs.find(p => p.id === id);
      if (found) return found;
      const deep = findPdf(n.children, id);
      if (deep) return deep;
    }
    return null;
  }

  const selectedPdf = selectedPdfId ? findPdf(folderTree, selectedPdfId) : null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-50">
      <PdfListSidebar
        folderTree={folderTree}
        selectedFolderId={selectedFolderId}
        selectedPdfId={selectedPdfId}
        onSelectFolder={setSelectedFolderId}
        onSelectPdf={setSelectedPdfId}
        onOpenPdf={handleOpenPdf}
        onAddPdf={handleAddPdf}
        onAddFolder={(parentId) => {
          const name = window.prompt("Folder name:");
          if (!name?.trim()) return;
          const newFolder: FolderNode = { id: uid(), name: name.trim(), children: [], pdfs: [] };
          setFolderTree(prev => {
            const clone = JSON.parse(JSON.stringify(prev)) as FolderNode[];
            const parent = findFolder(clone, parentId);
            if (parent) parent.children.push(newFolder);
            return clone;
          });
        }}
      />

      <div className="flex flex-col flex-1 min-w-0 relative">
        <Toolbar
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          scale={scale}
          hasPdf={!!pdfPath}
          activeTool={activeTool}
          onToolChange={setActiveTool}
          isRightPanelOpen={isRightPanelOpen}
          onToggleRightPanel={() => setIsRightPanelOpen(v => !v)}
        />

        <main className="flex-1 overflow-y-auto relative flex justify-center canvas-pattern">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <div className="bg-white/80 backdrop-blur-md px-6 py-4 rounded-2xl shadow-lg border border-zinc-200/50 text-zinc-700 font-medium flex items-center space-x-3">
                <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                <span>Loading Document...</span>
              </div>
            </div>
          )}

          {!pdfPath && !isLoading && (
            <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-6">
              <div className="w-24 h-24 bg-white rounded-[2rem] flex items-center justify-center shadow-sm border border-zinc-200/60 transition-transform hover:scale-105">
                <svg className="w-10 h-10 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <p className="font-medium text-zinc-500 text-lg tracking-tight">Double-click a PDF to start reading.</p>
            </div>
          )}

          {pdfPath && !isLoading && (
            <div className="w-full h-full pb-16">
              <PdfViewer totalPages={totalPages} dimensions={dimensions} scale={scale} activeTool={activeTool} />
            </div>
          )}
        </main>
      </div>

      <MetaPanel
        selectedPdf={selectedPdf}
        isOpen={isRightPanelOpen}
        onClose={() => setIsRightPanelOpen(false)}
      />
    </div>
  );
}

export default App;