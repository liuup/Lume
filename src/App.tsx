import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  currentPage: number;
}

function App() {
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const activeTab = openTabs.find(t => t.id === activeTabId) || null;
  const pdfPath = activeTab?.pdf.path || null;
  const totalPages = activeTab?.totalPages || 0;
  const dimensions = activeTab?.dimensions || [];
  const currentPage = activeTab?.currentPage || 1;
  const [scale, setScale] = useState<number>(1.5);
  const [activeTool, setActiveTool] = useState<ToolType>('none');
  const [isLoading, setIsLoading] = useState(false);

  // Library state
  const [folderTree, setFolderTree] = useState<FolderNode[]>([DEFAULT_FOLDER]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("root");
  const [selectedPdfId, setSelectedPdfId] = useState<string | null>(null);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);

  // Sync background Rust PDF context when switching tabs
  useEffect(() => {
    if (!pdfPath) return;
    let isMounted = true;
    (async () => {
      try {
        setIsLoading(true);
        // Important: we just reload without modifying frontend page counts/dimensions 
        // since those were already cached in `openTabs` state when the tab was created.
        await invoke("load_pdf", { path: pdfPath });
        if (isMounted) {
          setIsLoading(false);
        }
      } catch (err) {
        console.error("Failed to switch PDF context", err);
        if (isMounted) setIsLoading(false);
      }
    })();
    return () => { isMounted = false; };
  }, [pdfPath]);

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
          dimensions: dims,
          currentPage: 1
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
        dimensions: dims,
        currentPage: 1
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
        const nextActiveId = next.length > 0 ? next[next.length - 1].id : null;
        setActiveTabId(nextActiveId);
        if (nextActiveId) setSelectedPdfId(nextActiveId);
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

  const scrollTimeout = useRef<number | null>(null);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!activeTabId) return;
    if (scrollTimeout.current) return;
    
    const target = e.currentTarget;
    // Use requestAnimationFrame or setTimeout for throttling
    scrollTimeout.current = window.setTimeout(() => {
      scrollTimeout.current = null;
      const rect = target.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      let closestPage = 1;
      let minDistance = Infinity;
      
      const pageNodes = target.querySelectorAll('[data-page-number]');
      pageNodes.forEach(node => {
        const nodeRect = node.getBoundingClientRect();
        const nodeCenter = nodeRect.top + nodeRect.height / 2;
        const dist = Math.abs(nodeCenter - center);
        if (dist < minDistance) {
          minDistance = dist;
          closestPage = parseInt(node.getAttribute('data-page-number') || '1', 10);
        }
      });
      
      if (closestPage !== currentPage) {
        setOpenTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, currentPage: closestPage } : t));
      }
    }, 100);
  };

  const handlePageJump = (page: number) => {
    const el = document.getElementById(`pdf-page-${page}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
      setOpenTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, currentPage: page } : t));
    }
  };

  const selectedPdf = selectedPdfId ? findPdf(folderTree, selectedPdfId) : null;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-50">
      {/* ── Top title-bar / tab strip ── */}
      <div 
        data-tauri-drag-region="true"
        className="h-[36px] flex items-center border-b border-zinc-200 bg-zinc-200/40 shrink-0 select-none"
      >
        {/* Left: traffic-light gap (draggable) */}
        <div 
          data-tauri-drag-region="true"
          className="w-[76px] h-full shrink-0 cursor-default" 
        />

        {/* Tabs */}
        <div 
          data-tauri-drag-region="true"
          className="flex items-center space-x-1.5 overflow-x-auto overflow-y-hidden no-scrollbar flex-1 min-w-0 h-full cursor-default"
        >
          {openTabs.map(tab => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => {
                  setActiveTabId(tab.id);
                  setSelectedPdfId(tab.id);
                }}
                className={[
                  "group flex items-center gap-1.5 px-3 h-[26px] min-w-[100px] max-w-[180px]",
                  "rounded-md text-[12px] font-medium transition-colors relative cursor-default",
                  isActive
                    ? "bg-white shadow-sm border border-zinc-200/60 text-zinc-900 z-10"
                    : "bg-transparent border border-transparent text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-700",
                ].join(" ")}
              >
                
                <span className="truncate flex-1" title={tab.pdf.meta.title || tab.pdf.name}>
                  {tab.pdf.meta.title || tab.pdf.name}
                </span>
                
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id, e);
                  }}
                  className="shrink-0 p-0.5 rounded-sm hover:bg-zinc-300 text-zinc-400 hover:text-zinc-600 transition-colors"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Right: extra draggable space */}
        <div 
          data-tauri-drag-region="true"
          className="w-12 h-full shrink-0 cursor-default" 
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
          currentPage={currentPage}
          totalPages={totalPages}
          onPageJump={handlePageJump}
        />

        <main ref={mainRef} className="flex-1 overflow-y-hidden relative flex justify-center canvas-pattern">
          {/* Main Content Area */}
          {activeTab ? (
            <div className="flex-1 w-full bg-zinc-200/50 overflow-y-auto min-h-0 relative" onScroll={handleScroll}>
              {isLoading && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-200/50 backdrop-blur-sm">
                  <div className="flex flex-col items-center space-y-4">
                    <div className="w-8 h-8 border-2 border-zinc-400 border-t-zinc-600 rounded-full animate-spin" />
                    <div className="text-sm font-medium text-zinc-600">Switching document...</div>
                  </div>
                </div>
              )}
              {!isLoading && (
                <PdfViewer 
                  key={activeTabId}
                  totalPages={totalPages} 
                  dimensions={dimensions} 
                  scale={scale} 
                  activeTool={activeTool}
                />
              )}
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-6">
              <div className="w-24 h-24 bg-white rounded-[2rem] flex items-center justify-center shadow-sm border border-zinc-200/60 transition-transform hover:scale-105">
                <svg className="w-10 h-10 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <p className="font-medium text-zinc-500 text-lg tracking-tight">Double-click a PDF to start reading.</p>
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