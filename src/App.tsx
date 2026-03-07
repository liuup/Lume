import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toolbar } from "./components/Toolbar";
import { PdfViewer } from "./components/PdfViewer";
import { PdfListSidebar } from "./components/layout/PdfListSidebar";
import { MetaPanel } from "./components/layout/MetaPanel";
import { X } from "lucide-react";

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

export interface OpenTab {
  id: string;
  pdf: PdfEntry;
  totalPages: number;
  dimensions: PageDimension[];
}

function App() {
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const activeTab = openTabs.find(t => t.id === activeTabId) || null;
  const pdfPath = activeTab?.pdf.path || null;
  const totalPages = activeTab?.totalPages || 0;
  const dimensions = activeTab?.dimensions || [];
  const [scale, setScale] = useState<number>(1.5);
  const [activeTool, setActiveTool] = useState<ToolType>('none');
  const [isLoading, setIsLoading] = useState(false);

  // Library state
  const [folderTree, setFolderTree] = useState<FolderNode[]>([DEFAULT_FOLDER]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("root");
  const [selectedPdfId, setSelectedPdfId] = useState<string | null>(null);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);

  const mainRef = useRef<HTMLElement>(null);

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
  function addPdfToFolder(path: string): PdfEntry {
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
    return newPdf;
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
        const newPdf = addPdfToFolder(selected);
        
        setOpenTabs(prev => [...prev, {
          id: newPdf.id,
          pdf: newPdf,
          totalPages: pages,
          dimensions: dims
        }]);
        setActiveTabId(newPdf.id);
        
        setIsLoading(false);
      }
    } catch (err) {
      console.error("Failed to open PDF", err);
      setIsLoading(false);
    }
  };

  // Called when user double-clicks a PDF in the list — opens it in the viewer
  const handleOpenPdf = async (pdf: PdfEntry) => {
    if (openTabs.find(t => t.id === pdf.id)) {
      setActiveTabId(pdf.id);
      return;
    }
    try {
      setIsLoading(true);
      const pages: number = await invoke("load_pdf", { path: pdf.path });
      const dims: PageDimension[] = await invoke("get_pdf_dimensions");
      
      setOpenTabs(prev => [...prev, {
        id: pdf.id,
        pdf,
        totalPages: pages,
        dimensions: dims
      }]);
      setActiveTabId(pdf.id);
      
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

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  };

  const fitWidth = () => {
    if (!mainRef.current || dimensions.length === 0) return;
    const cw = mainRef.current.clientWidth;
    // Leave roughly 64px padding (32px each side)
    const padding = 64; 
    const s = Math.max(0.25, Math.min(4.0, (cw - padding) / dimensions[0].width));
    setScale(s);
  };

  const fitHeight = () => {
    if (!mainRef.current || dimensions.length === 0) return;
    const ch = mainRef.current.clientHeight;
    // Leave some padding
    const padding = 64;
    const s = Math.max(0.25, Math.min(4.0, (ch - padding) / dimensions[0].height));
    setScale(s);
  };

  const selectedPdf = selectedPdfId ? findPdf(folderTree, selectedPdfId) : null;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-50">
      {/* ── Top title-bar / tab strip ── */}
      <div className="h-[40px] flex items-end border-b border-zinc-200 bg-zinc-100/60 shrink-0 select-none">
        {/* Left: traffic-light gap + draggable empty area */}
        <div
          className="flex items-end h-full pl-[76px] pr-1 flex-1 min-w-0 cursor-default"
          onPointerDown={(e) => {
            // Only start dragging if the user clicked directly on this element (the empty space)
            if (e.currentTarget === e.target && e.button === 0) {
              getCurrentWindow().startDragging();
            }
          }}
        >
          {/* Tabs – sit inside the drag region but stop propagation so clicks don't drag */}
          <div className="flex items-end space-x-1 overflow-x-auto no-scrollbar h-full pb-0">
            {openTabs.map(tab => {
              const isActive = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={[
                    "group flex items-center gap-1.5 px-3 h-[30px] min-w-[100px] max-w-[180px]",
                    "rounded-t-md border-x border-t text-[12px] font-medium cursor-default transition-colors relative",
                    isActive
                      ? "bg-zinc-50 border-zinc-200 text-zinc-900 translate-y-[1px]"
                      : "bg-zinc-200/40 border-transparent text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-700",
                  ].join(" ")}
                >
                  {/* Cover the bottom border for the active tab so it merges with content */}
                  {isActive && <div className="absolute bottom-[-1px] left-0 right-0 h-[1px] bg-zinc-50" />}
                  <span className="truncate flex-1" title={tab.pdf.meta.title || tab.pdf.name}>
                    {tab.pdf.meta.title || tab.pdf.name}
                  </span>
                  <button
                    onClick={(e) => handleCloseTab(tab.id, e)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="shrink-0 p-0.5 rounded hover:bg-zinc-300/60 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: extra drag area */}
        <div
          className="w-4 h-full cursor-default"
          onPointerDown={(e) => {
            if (e.button === 0) getCurrentWindow().startDragging();
          }}
        />
      </div>

      {/* 主工作区 - Main Workspace Split */}
      <div className="flex flex-1 min-h-0">
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
          onFitWidth={fitWidth}
          onFitHeight={fitHeight}
        />

        <main ref={mainRef} className="flex-1 overflow-y-auto relative flex justify-center canvas-pattern">
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
    </div>
  );
}

export default App;