import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toolbar } from "./components/Toolbar";
import { PdfViewer } from "./components/PdfViewer";
import { FolderSidebar } from "./components/layout/FolderSidebar";
import { LibraryView } from "./components/layout/LibraryView";
import { MetaPanel } from "./components/layout/MetaPanel";
import { SearchBar } from "./components/SearchBar";
import { SettingsModal } from "./components/modals/SettingsModal";
import { X } from "lucide-react";

import { TagInfo, ToolType } from "./types";
import { useLibrary } from "./hooks/useLibrary";
import { useSettings } from "./hooks/useSettings";

function App() {
  const {
    openTabs,
    activeTabId,
    setActiveTabId,
    pdfPath,
    totalPages,
    dimensions,
    currentPage,
    isLoading,
    folderTree,
    selectedFolderId,
    setSelectedFolderId,
    selectedItemId,
    setSelectedItemId,
    findItem,
    handleAddItem,
    handleOpenItem,
    handleCloseTab,
    handlePageJump,
    updateCurrentPage,
    handleAddFolder,
    handleDeleteItem,
    handleRenameItem,
    handleRenameFolder,
    handleItemUpdatedLocally
  } = useLibrary();

  const [scale, setScale] = useState<number>(1.5);
  const [activeTool, setActiveTool] = useState<ToolType>('none');
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [annotationsRefreshKey, setAnnotationsRefreshKey] = useState(0);
  const { settings, isLoading: isSettingsLoading } = useSettings();

  // ── Tag system state ─────────────────────────────────────────────────────
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(null);

  const refreshAllTags = useCallback(async () => {
    try {
      const tags = await invoke<TagInfo[]>("get_all_tags");
      setAllTags(tags);
    } catch (err) {
      console.error("Failed to load tags", err);
    }
  }, []);

  useEffect(() => { refreshAllTags(); }, [refreshAllTags]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Cmd+F or Ctrl+F
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        if (!activeTabId || activeTabId === 'library') return; // only in PDF view
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [activeTabId]);

  const tagColors: Record<string, string> = {};
  for (const t of allTags) {
    if (t.color) tagColors[t.tag] = t.color;
  }

  const mainRef = useRef<HTMLElement>(null);

  const zoomIn = () => setScale(s => Math.min(s + 0.25, 4.0));
  const zoomOut = () => setScale(s => Math.max(s - 0.25, 0.5));

  const fitWidth = () => {
    if (!mainRef.current || !dimensions || dimensions.length === 0) return;
    const cw = mainRef.current.clientWidth;
    const padding = 64; 
    const baseW = dimensions[0]?.width || 1;
    const s = Math.max(0.25, Math.min(4.0, (cw - padding) / baseW));
    if (!isNaN(s)) setScale(s);
  };

  const fitHeight = () => {
    if (!mainRef.current || !dimensions || dimensions.length === 0) return;
    const ch = mainRef.current.clientHeight;
    const padding = 64;
    const baseH = dimensions[0]?.height || 1;
    const s = Math.max(0.25, Math.min(4.0, (ch - padding) / baseH));
    if (!isNaN(s)) setScale(s);
  };

  // ── Apply Default Zoom when a new PDF is opened ──
  useEffect(() => {
    if (isSettingsLoading || !activeTabId || activeTabId === 'library' || dimensions.length === 0) return;
    
    // We only want to apply this once when the document first loads
    // so we timeout to let the modal / dom finish rendering
    const timer = setTimeout(() => {
        if (!settings || !settings.defaultPdfZoom) return;
        if (settings.defaultPdfZoom === "page-fit") {
          fitHeight();
        } else if (settings.defaultPdfZoom === "page-width") {
          fitWidth();
        } else {
          try {
            const pctText = typeof settings.defaultPdfZoom === "string" ? settings.defaultPdfZoom : "100%";
            const pct = parseInt(pctText.replace("%", ""), 10);
            if (!isNaN(pct)) {
              setScale(pct / 100);
            }
          } catch (e) {
            console.error("Invalid default zoom", e);
          }
        }
    }, 100);
    
    return () => clearTimeout(timer);
  }, [activeTabId, isSettingsLoading, dimensions.length]);

  const scrollTimeout = useRef<number | null>(null);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!activeTabId || activeTabId === 'library') return;
    if (scrollTimeout.current) return;
    
    const target = e.currentTarget;
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
        updateCurrentPage(closestPage);
      }
    }, 100);
  };

  const selectedItem = selectedItemId ? findItem(folderTree, selectedItemId) : null;
  const isLibrary = activeTabId === 'library' || activeTabId === null;

  const handleAnnotationsSaved = useCallback((savedPdfPath: string) => {
    if (savedPdfPath && savedPdfPath === (selectedItem?.attachments?.[0]?.path || "")) {
      setAnnotationsRefreshKey(prev => prev + 1);
    }
  }, [selectedItem?.attachments]);

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
          <div
            onClick={() => setActiveTabId('library')}
            className={[
              "group flex items-center gap-1.5 px-4 h-[26px] min-w-[80px]",
              "rounded-md text-[12px] font-medium transition-colors relative cursor-default",
              isLibrary
                ? "bg-white shadow-sm border border-zinc-200/60 text-zinc-900 z-10"
                : "bg-transparent border border-transparent text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-700",
            ].join(" ")}
          >
            <span className="truncate flex-1">Library</span>
          </div>

          {openTabs.map(tab => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => {
                  setActiveTabId(tab.id);
                  setSelectedItemId(tab.id);
                }}
                className={[
                  "group flex items-center gap-1.5 px-3 h-[26px] min-w-[100px] max-w-[180px]",
                  "rounded-md text-[12px] font-medium transition-colors relative cursor-default",
                  isActive
                    ? "bg-white shadow-sm border border-zinc-200/60 text-zinc-900 z-10"
                    : "bg-transparent border border-transparent text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-700",
                ].join(" ")}
              >
                
                <span className="truncate flex-1" title={tab.item.title || tab.item.attachments[0]?.name}>
                  {tab.item.title || tab.item.attachments[0]?.name}
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
        {isLibrary ? (
          <>
            <FolderSidebar
              folderTree={folderTree}
              selectedFolderId={selectedFolderId}
              onSelectFolder={id => { setSelectedFolderId(id); setSelectedTagFilter(null); }}
              onAddFolder={handleAddFolder}
              onRenameFolder={handleRenameFolder}
              allTags={allTags}
              selectedTagFilter={selectedTagFilter}
              onSelectTag={t => setSelectedTagFilter(prev => prev === t ? null : t)}
              onSetTagColor={async (tag, color) => {
                await invoke("set_tag_color", { tag, color });
                await refreshAllTags();
              }}
              onOpenSettings={() => setShowSettings(true)}
            />
            <LibraryView 
              folderTree={folderTree}
              selectedFolderId={selectedFolderId}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
              onOpenItem={handleOpenItem}
              onAddItem={handleAddItem}
              onDeleteItem={handleDeleteItem}
              onRenameItem={handleRenameItem}
              tagFilter={selectedTagFilter}
              onClearTagFilter={() => setSelectedTagFilter(null)}
            />
          </>
        ) : (
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
              {showSearch && (
                <SearchBar
                  onSearch={(term, backwards) => {
                    // Using basic window.find for finding natively parsed text
                    const found = (window as any).find(term, false, backwards, true, false, false, false);
                    if (!found) {
                      // Optionally we could show a "not found" toast or handle it
                    }
                  }}
                  onClose={() => setShowSearch(false)}
                />
              )}
              {/* Main Content Area */}
              {isLoading && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-200/50 backdrop-blur-sm">
                  <div className="flex flex-col items-center space-y-4">
                    <div className="w-8 h-8 border-2 border-zinc-400 border-t-zinc-600 rounded-full animate-spin" />
                    <div className="text-sm font-medium text-zinc-600">Switching document...</div>
                  </div>
                </div>
              )}
              {openTabs.map(tab => (
                <div 
                  key={tab.id}
                  className={`flex-1 w-full bg-zinc-200/50 overflow-y-auto min-h-0 absolute inset-0 ${tab.id === activeTabId ? 'block' : 'hidden'}`} 
                  onScroll={handleScroll}
                >
                  <PdfViewer 
                    pdfPath={tab.item.attachments?.[0]?.path || ""}
                    totalPages={tab.totalPages} 
                    dimensions={tab.dimensions} 
                    scale={scale} 
                    activeTool={activeTool}
                    currentPage={tab.currentPage}
                    onAnnotationsSaved={handleAnnotationsSaved}
                  />
                </div>
              ))}
            </main>
          </div>
        )}

        {!isLibrary && (
          <MetaPanel
            selectedItem={selectedItem}
            isOpen={isRightPanelOpen}
            onClose={() => setIsRightPanelOpen(false)}
            tagColors={tagColors}
            onItemUpdated={() => {
              handleItemUpdatedLocally();
              refreshAllTags();
            }}
            onPageJump={handlePageJump}
            annotationsRefreshKey={annotationsRefreshKey}
          />
        )}
      </div>
      
      {/* ── Settings Modal ── */}
      <SettingsModal 
        isOpen={showSettings} 
        onClose={() => setShowSettings(false)} 
      />
    </div>
  );
}

export default App;