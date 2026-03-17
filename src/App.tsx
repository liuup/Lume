import { Suspense, lazy, useState, useRef, useEffect, useCallback, useEffectEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderSidebar } from "./components/layout/FolderSidebar";
import { LibraryView } from "./components/layout/LibraryView";
import { SettingsModal } from "./components/modals/SettingsModal";
import { preloadPdfDocument } from "./components/pdfDocumentRuntime";
import {
  loadPdfAIPanelModule,
  loadPdfMetaPanelModule,
  loadPdfSearchBarModule,
  loadPdfToolbarModule,
  loadPdfViewerModule,
  preloadPdfCoreRuntime,
  preloadPdfSidebarRuntime,
} from "./components/pdfRuntime";
import { X } from "lucide-react";

import { CliLibraryChangedPayload, DEFAULT_FOLDER, LibraryItem, PdfSearchMatch, TagInfo, ToolType, TRASH_FOLDER_ID } from "./types";
import { useLibrary } from "./hooks/useLibrary";
import { useSettings } from "./hooks/useSettings";
import { useI18n } from "./hooks/useI18n";
import { useFeedback } from "./hooks/useFeedback";

type LibraryDragState = {
  itemId: string;
  title: string;
  x: number;
  y: number;
};

type SearchRequestOptions = {
  notifyOnNoResults?: boolean;
  advanceIfSameTerm?: boolean;
};

const PdfViewer = lazy(async () => {
  const module = await loadPdfViewerModule();
  return { default: module.PdfViewer };
});
const Toolbar = lazy(async () => {
  const module = await loadPdfToolbarModule();
  return { default: module.Toolbar };
});
const SearchBar = lazy(async () => {
  const module = await loadPdfSearchBarModule();
  return { default: module.SearchBar };
});
const AIPanel = lazy(async () => {
  const module = await loadPdfAIPanelModule();
  return { default: module.AIPanel };
});
const MetaPanel = lazy(async () => {
  const module = await loadPdfMetaPanelModule();
  return { default: module.MetaPanel };
});

function App() {
  const { t } = useI18n();
  const feedback = useFeedback();
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
    trashItems,
    selectedFolderId,
    setSelectedFolderId,
    selectedItemId,
    setSelectedItemId,
    findItem,
    findFolder,
    handleAddItem,
    importPdfPaths,
    handleOpenItem,
    handleCloseTab,
    handlePageJump,
    updateCurrentPage,
    updatePageDimension,
    handleAddFolder,
    handleDeleteItem,
    handleRenameItem,
    handleMoveItemToFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleItemUpdatedLocally,
    handleRestoreTrashItem,
    handleEmptyTrash,
  } = useLibrary();

  const [scale, setScale] = useState<number>(1.5);
  const [activeTool, setActiveTool] = useState<ToolType>('none');
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(true);
  const [rightPanelWidth, setRightPanelWidth] = useState(320);
  const [aiPanelWidth, setAiPanelWidth] = useState(340);
  const [showSearch, setShowSearch] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchMatches, setSearchMatches] = useState<PdfSearchMatch[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [arePdfSidebarsReady, setArePdfSidebarsReady] = useState(false);
  const [annotationsRefreshKey, setAnnotationsRefreshKey] = useState(0);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<LibraryDragState | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const [fileDropPaths, setFileDropPaths] = useState<string[]>([]);
  const [fileDropFolderId, setFileDropFolderId] = useState<string | null>(null);
  const draggedItemIdRef = useRef<string | null>(null);
  const dragOverFolderIdRef = useRef<string | null>(null);
  const isFileDropActiveRef = useRef(false);
  const fileDropFolderIdRef = useRef<string | null>(null);
  const searchCacheRef = useRef<Map<string, PdfSearchMatch[]>>(new Map());
  const searchRequestIdRef = useRef(0);
  const activePdfScrollRef = useRef<HTMLDivElement | null>(null);
  const { settings, isLoading: isSettingsLoading } = useSettings();

  useEffect(() => {
    if (!activeTabId || activeTabId === "library") {
      setArePdfSidebarsReady(false);
      return undefined;
    }

    void preloadPdfCoreRuntime();
    if (arePdfSidebarsReady) {
      void preloadPdfSidebarRuntime();
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setArePdfSidebarsReady(true);
      void preloadPdfSidebarRuntime();
    }, 160);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeTabId, arePdfSidebarsReady]);

  const clearSearchState = useCallback((keepInput = false) => {
    searchRequestIdRef.current += 1;
    setSearchTerm("");
    setSearchMatches([]);
    setActiveSearchIndex(-1);
    setIsSearchLoading(false);
    if (!keepInput) {
      setSearchInput("");
    }
  }, []);

  const handleDragItemEnd = useCallback(() => {
    draggedItemIdRef.current = null;
    dragOverFolderIdRef.current = null;
    setDraggedItemId(null);
    setDragState(null);
    setDragOverFolderId(null);
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    document.body.style.cursor = "";
  }, []);

  const resolveImportFolderId = useCallback((folderId: string | null) => {
    const preferredFolderId = folderId && folderId !== TRASH_FOLDER_ID
      ? folderId
      : selectedFolderId !== TRASH_FOLDER_ID
        ? selectedFolderId
        : folderTree[0]?.id ?? DEFAULT_FOLDER.id;

    if (findFolder(folderTree, preferredFolderId)) {
      return preferredFolderId;
    }

    return folderTree[0]?.id ?? DEFAULT_FOLDER.id;
  }, [findFolder, folderTree, selectedFolderId]);

  const clearFileDropState = useCallback(() => {
    isFileDropActiveRef.current = false;
    fileDropFolderIdRef.current = null;
    setIsFileDropActive(false);
    setFileDropPaths([]);
    setFileDropFolderId(null);
  }, []);

  // ── Tag system state ─────────────────────────────────────────────────────
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(null);

  const refreshAllTags = useCallback(async () => {
    try {
      const tags = await invoke<TagInfo[]>("get_all_tags");
      setAllTags(tags);
      return tags;
    } catch (err) {
      console.error("Failed to load tags", err);
      feedback.error({
        title: t("feedback.library.tags.loadError.title"),
        description: t("feedback.library.tags.loadError.description"),
      });
      return [] as TagInfo[];
    }
  }, [feedback, t]);

  useEffect(() => { refreshAllTags(); }, [refreshAllTags]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await listen<CliLibraryChangedPayload>("cli-library-changed", () => {
        void refreshAllTags();
      });
    })().catch((err) => {
      console.error("Failed to listen for CLI library updates", err);
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, [refreshAllTags]);

  const handleUpdateItemTags = useCallback(async (item: LibraryItem, tags: string[]) => {
    const normalizedTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));

    try {
      await invoke("update_item_tags", { itemId: item.id, tags: normalizedTags });
      await handleItemUpdatedLocally();
      const latestTags = await refreshAllTags();

      if (selectedTagFilter && !latestTags.some((tagInfo) => tagInfo.tag === selectedTagFilter)) {
        setSelectedTagFilter(null);
      }

      feedback.success({
        title: t("feedback.library.tags.updateSuccess.title"),
        description: t("feedback.library.tags.updateSuccess.description", {
          title: item.title || item.attachments?.[0]?.name || item.id,
        }),
      });
    } catch (error) {
      console.error("Failed to update item tags", error);
      feedback.error({
        title: t("feedback.library.tags.updateError.title"),
        description: t("feedback.library.tags.updateError.description"),
      });
    }
  }, [feedback, handleItemUpdatedLocally, refreshAllTags, selectedTagFilter, t]);

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

  useEffect(() => {
    clearSearchState();
    setShowSearch(false);
  }, [clearSearchState, pdfPath]);

  const tagColors: Record<string, string> = {};
  for (const t of allTags) {
    if (t.color) tagColors[t.tag] = t.color;
  }

  const mainRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

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

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  const startPanelResize = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
    side: "left" | "right",
  ) => {
    event.preventDefault();

    const minWidth = side === "left" ? 280 : 300;
    const maxWidth = 520;

    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    document.body.style.cursor = "col-resize";

    const handlePointerMove = (moveEvent: MouseEvent) => {
      if (side === "left") {
        const nextWidth = Math.min(maxWidth, Math.max(minWidth, moveEvent.clientX));
        setAiPanelWidth(nextWidth);
      } else {
        const nextWidth = Math.min(maxWidth, Math.max(minWidth, window.innerWidth - moveEvent.clientX));
        setRightPanelWidth(nextWidth);
      }
    };

    const cleanup = () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.webkitUserSelect = "";
      document.body.style.cursor = "";
      resizeCleanupRef.current = null;
    };

    const handlePointerUp = () => {
      cleanup();
    };

    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanup;

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
  }, []);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, isSettingsLoading, dimensions.length, settings?.defaultPdfZoom]);

  const handleVisiblePageChange = useCallback((page: number) => {
    if (!activeTabId || activeTabId === "library" || page === currentPage) {
      return;
    }
    updateCurrentPage(page);
  }, [activeTabId, currentPage, updateCurrentPage]);

  const selectedItem = selectedItemId
    ? (findItem(folderTree, selectedItemId) ?? trashItems.find((item) => item.id === selectedItemId) ?? null)
    : null;
  const isTrashSelected = selectedFolderId === TRASH_FOLDER_ID;
  const isLibrary = activeTabId === 'library' || activeTabId === null;
  const activeFileDropFolderId = resolveImportFolderId(fileDropFolderId);
  const activeFileDropFolder = findFolder(folderTree, activeFileDropFolderId) ?? folderTree[0] ?? null;
  const fileDropLabel = fileDropPaths.length === 1
    ? fileDropPaths[0].split(/[/\\]/).pop()?.replace(/\.pdf$/i, "") || fileDropPaths[0]
    : t("app.drag.importPdfCount", { count: fileDropPaths.length });

  const updateDragOverFolder = useCallback((clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const folderTarget = target?.closest("[data-folder-drop-id]") as HTMLElement | null;
    const nextFolderId = folderTarget?.dataset.folderDropId ?? null;

    if (dragOverFolderIdRef.current !== nextFolderId) {
      dragOverFolderIdRef.current = nextFolderId;
      setDragOverFolderId(nextFolderId);
    }
  }, []);

  const handleFolderHover = useCallback((folderId: string | null) => {
    if (dragOverFolderIdRef.current !== folderId) {
      dragOverFolderIdRef.current = folderId;
      setDragOverFolderId(folderId);
    }
  }, []);

  const updateFileDropFolder = useCallback((physicalX: number, physicalY: number) => {
    const scale = window.devicePixelRatio || 1;
    const target = document.elementFromPoint(physicalX / scale, physicalY / scale) as HTMLElement | null;
    const folderTarget = target?.closest("[data-folder-drop-id]") as HTMLElement | null;
    const hoveredFolderId = folderTarget?.dataset.folderDropId ?? null;
    const nextFolderId = resolveImportFolderId(hoveredFolderId);

    if (fileDropFolderIdRef.current !== nextFolderId) {
      fileDropFolderIdRef.current = nextFolderId;
      setFileDropFolderId(nextFolderId);
    }
  }, [resolveImportFolderId]);

  const handleExternalPdfDrop = useEffectEvent((paths: string[], folderId: string | null) => {
    const pdfPaths = paths.filter((path) => /\.pdf$/i.test(path));
    if (pdfPaths.length === 0) {
      return;
    }

    void importPdfPaths(pdfPaths, resolveImportFolderId(folderId));
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          const pdfPaths = event.payload.paths.filter((path) => /\.pdf$/i.test(path));
          if (pdfPaths.length === 0) {
            return;
          }

          isFileDropActiveRef.current = true;
          setIsFileDropActive(true);
          setFileDropPaths(pdfPaths);
          updateFileDropFolder(event.payload.position.x, event.payload.position.y);
          return;
        }

        if (event.payload.type === "over") {
          if (!isFileDropActiveRef.current) {
            return;
          }
          updateFileDropFolder(event.payload.position.x, event.payload.position.y);
          return;
        }

        if (event.payload.type === "leave") {
          clearFileDropState();
          return;
        }

        const targetFolderId = fileDropFolderIdRef.current;
        const droppedPaths = event.payload.paths;
        clearFileDropState();
        handleExternalPdfDrop(droppedPaths, targetFolderId);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to register drag-drop listener", error);
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [clearFileDropState, handleExternalPdfDrop, updateFileDropFolder]);

  const handleItemPointerDown = useCallback((item: { id: string; title: string }, event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a")) return;

    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    let isDragging = false;

    const title = item.title || "Untitled";

    const cleanup = () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    };

    const handlePointerMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (!isDragging && Math.hypot(dx, dy) < 6) {
        return;
      }

      if (!isDragging) {
        isDragging = true;
        draggedItemIdRef.current = item.id;
        setDraggedItemId(item.id);
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
        document.body.style.cursor = "grabbing";
      }

      setDragState({
        itemId: item.id,
        title,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
      });
      updateDragOverFolder(moveEvent.clientX, moveEvent.clientY);
    };

    const handlePointerUp = () => {
      cleanup();

      if (!isDragging) {
        return;
      }

      const targetFolderId = dragOverFolderIdRef.current;
      const draggedId = draggedItemIdRef.current;

      handleDragItemEnd();

      if (draggedId && targetFolderId) {
        void handleMoveItemToFolder(draggedId, targetFolderId);
      }
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
  }, [handleDragItemEnd, handleMoveItemToFolder, updateDragOverFolder]);

  const handleAnnotationsSaved = useCallback((savedPdfPath: string) => {
    if (savedPdfPath && savedPdfPath === (selectedItem?.attachments?.[0]?.path || "")) {
      setAnnotationsRefreshKey(prev => prev + 1);
    }
  }, [selectedItem?.attachments]);

  const jumpWithinSearchResults = useCallback((backwards: boolean, totalMatches: number) => {
    if (totalMatches <= 0) {
      setActiveSearchIndex(-1);
      return;
    }

    setActiveSearchIndex((prev) => {
      if (prev < 0 || prev >= totalMatches) {
        return backwards ? totalMatches - 1 : 0;
      }

      return backwards
        ? (prev - 1 + totalMatches) % totalMatches
        : (prev + 1) % totalMatches;
    });
  }, []);

  const handleSearchInputChange = useCallback((value: string) => {
    setSearchInput(value);

    if (value.trim() !== searchTerm) {
      setSearchTerm("");
      setSearchMatches([]);
      setActiveSearchIndex(-1);
    }
  }, [searchTerm]);

  const handleDocumentSearch = useCallback(async (
    term: string,
    backwards: boolean,
    options: SearchRequestOptions = {},
  ) => {
    const trimmedTerm = term.trim();
    const {
      notifyOnNoResults = true,
      advanceIfSameTerm = true,
    } = options;

    setSearchInput(term);

    if (!pdfPath || !trimmedTerm) {
      clearSearchState(true);
      return;
    }

    if (trimmedTerm === searchTerm) {
      if (searchMatches.length === 0) {
        if (notifyOnNoResults) {
          feedback.info({
            title: t("feedback.search.notFound.title"),
            description: t("feedback.search.notFound.description", { term: trimmedTerm }),
          });
        }
        return;
      }

      if (advanceIfSameTerm) {
        jumpWithinSearchResults(backwards, searchMatches.length);
      }
      return;
    }

    const cacheKey = `${pdfPath}::${trimmedTerm.toLocaleLowerCase()}`;
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setIsSearchLoading(true);

    try {
      let matches = searchCacheRef.current.get(cacheKey);

      if (!matches) {
        matches = await invoke<PdfSearchMatch[]>("search_pdf_text", {
          path: pdfPath,
          term: trimmedTerm,
        });
        searchCacheRef.current.set(cacheKey, matches);
      }

      if (searchRequestIdRef.current !== requestId) {
        return;
      }

      setSearchTerm(trimmedTerm);
      setSearchMatches(matches);
      setActiveSearchIndex(matches.length > 0 ? (backwards ? matches.length - 1 : 0) : -1);

      if (matches.length === 0 && notifyOnNoResults) {
        feedback.info({
          title: t("feedback.search.notFound.title"),
          description: t("feedback.search.notFound.description", { term: trimmedTerm }),
        });
      }
    } catch (error) {
      console.error("Failed to search PDF text", error);
    } finally {
      if (searchRequestIdRef.current === requestId) {
        setIsSearchLoading(false);
      }
    }
  }, [clearSearchState, feedback, jumpWithinSearchResults, pdfPath, searchMatches, searchTerm, t]);

  useEffect(() => {
    if (!showSearch) {
      return;
    }

    const trimmedTerm = searchInput.trim();
    if (!trimmedTerm) {
      setSearchTerm("");
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      setIsSearchLoading(false);
      searchRequestIdRef.current += 1;
      return;
    }

    const timer = window.setTimeout(() => {
      void handleDocumentSearch(searchInput, false, {
        notifyOnNoResults: false,
        advanceIfSameTerm: false,
      });
    }, 180);

    return () => window.clearTimeout(timer);
  }, [handleDocumentSearch, searchInput, showSearch]);

  useEffect(() => {
    const container = activePdfScrollRef.current;
    const activeMatch = searchMatches[activeSearchIndex];

    if (!container || !activeMatch) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const target = container.querySelector(`[data-search-match-id="${activeSearchIndex}"]`) as HTMLElement | null;

      if (target) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const scrollTop = container.scrollTop + (targetRect.top - containerRect.top) - (containerRect.height / 2) + (targetRect.height / 2);

        container.scrollTo({
          top: Math.max(0, scrollTop),
          behavior: "smooth",
        });
        return;
      }

      const pageNode = container.querySelector(
        `[data-page-number="${activeMatch.pageIndex + 1}"]`
      ) as HTMLElement | null;
      if (pageNode) {
        pageNode.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }

      handlePageJump(activeMatch.pageIndex + 1);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeSearchIndex, handlePageJump, searchMatches]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-50">
      {/* ── Top title-bar / tab strip ── */}
      <div
        data-tauri-drag-region="true"
        className="h-[36px] flex items-center border-b border-zinc-200 dark:border-zinc-800 bg-zinc-200/40 dark:bg-zinc-900/80 shrink-0 select-none"
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
                ? "bg-white dark:bg-zinc-950 shadow-sm border border-zinc-200/60 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 z-10"
                : "bg-transparent border border-transparent text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/80 hover:text-zinc-700 dark:hover:text-zinc-100",
            ].join(" ")}
          >
            <span className="truncate flex-1">Library</span>
          </div>

          {openTabs.map(tab => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onMouseEnter={() => {
                  void preloadPdfCoreRuntime();
                  const nextPdfPath = tab.item.attachments?.[0]?.path || tab.id;
                  void preloadPdfDocument(nextPdfPath);
                }}
                onClick={() => {
                  setActiveTabId(tab.id);
                  setSelectedItemId(tab.id);
                }}
                className={[
                  "group flex items-center gap-1.5 px-3 h-[26px] min-w-[100px] max-w-[180px]",
                  "rounded-md text-[12px] font-medium transition-colors relative cursor-default",
                  isActive
                    ? "bg-white dark:bg-zinc-950 shadow-sm border border-zinc-200/60 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 z-10"
                    : "bg-transparent border border-transparent text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/80 hover:text-zinc-700 dark:hover:text-zinc-100",
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
                  className="shrink-0 p-0.5 rounded-sm hover:bg-zinc-300 dark:hover:bg-zinc-800 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
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
          <div className="flex flex-1 min-h-0 view-enter" key="library-view">
            <FolderSidebar
              folderTree={folderTree}
              isCollapsed={isSidebarCollapsed}
              onToggleCollapse={() => setIsSidebarCollapsed(prev => !prev)}
              selectedFolderId={selectedFolderId}
              onSelectFolder={id => { setSelectedFolderId(id); setSelectedTagFilter(null); }}
              trashCount={trashItems.length}
              onAddFolder={handleAddFolder}
              onRenameFolder={handleRenameFolder}
              onDeleteFolder={handleDeleteFolder}
              draggedItemId={isFileDropActive ? "__external-file-drop__" : draggedItemId}
              dragOverFolderId={isFileDropActive ? activeFileDropFolderId : dragOverFolderId}
              onFolderHover={handleFolderHover}
              allTags={allTags}
              selectedTagFilter={selectedTagFilter}
              onSelectTag={t => setSelectedTagFilter(prev => prev === t ? null : t)}
              onSetTagColor={async (tag, color) => {
                try {
                  await invoke("set_tag_color", { tag, color });
                  await refreshAllTags();
                  feedback.success({
                    title: t("feedback.library.tags.colorUpdated.title"),
                    description: t("feedback.library.tags.colorUpdated.description", { tag }),
                  });
                } catch (error) {
                  console.error("Failed to set tag color", error);
                  feedback.error({
                    title: t("feedback.library.tags.colorUpdateError.title"),
                    description: t("feedback.library.tags.colorUpdateError.description", { tag }),
                  });
                }
              }}
              onOpenSettings={() => setShowSettings(true)}
            />
            <LibraryView 
              folderTree={folderTree}
              trashItems={trashItems}
              isTrashView={isTrashSelected}
              selectedFolderId={selectedFolderId}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
              onOpenItem={handleOpenItem}
              onAddItem={handleAddItem}
              onDeleteItem={handleDeleteItem}
              onRestoreItem={handleRestoreTrashItem}
              onEmptyTrash={handleEmptyTrash}
              onRenameItem={handleRenameItem}
              onUpdateItemTags={handleUpdateItemTags}
              onItemPointerDown={handleItemPointerDown}
              tagFilter={selectedTagFilter}
              onClearTagFilter={() => setSelectedTagFilter(null)}
            />
          </div>
        ) : (
          <div className="flex flex-1 min-w-0 relative view-enter" key="pdf-view">
            {arePdfSidebarsReady && (
              <Suspense fallback={null}>
                <AIPanel
                  selectedItem={selectedItem}
                  isOpen={isAiPanelOpen}
                  onClose={() => setIsAiPanelOpen(false)}
                  width={aiPanelWidth}
                  onResizeStart={(event) => startPanelResize(event, "left")}
                />
              </Suspense>
            )}
            <div className="flex flex-col flex-1 min-w-0 relative">
              <Suspense fallback={<div className="h-14 shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-950/95" />}>
                <Toolbar
                  onZoomIn={zoomIn}
                  onZoomOut={zoomOut}
                  scale={scale}
                  hasPdf={!!pdfPath}
                  activeTool={activeTool}
                  onToolChange={setActiveTool}
                  isAiPanelOpen={isAiPanelOpen}
                  onToggleAiPanel={() => setIsAiPanelOpen(v => !v)}
                  isRightPanelOpen={isRightPanelOpen}
                  onToggleRightPanel={() => setIsRightPanelOpen(v => !v)}
                  onFitWidth={fitWidth}
                  onFitHeight={fitHeight}
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageJump={handlePageJump}
                />
              </Suspense>

              <main ref={mainRef} className="flex-1 overflow-y-hidden relative flex justify-center canvas-pattern">
                {showSearch && (
                  <Suspense fallback={null}>
                    <SearchBar
                      value={searchInput}
                      totalMatches={searchInput.trim() === searchTerm ? searchMatches.length : 0}
                      activeMatchIndex={searchInput.trim() === searchTerm ? activeSearchIndex : -1}
                      isSearching={isSearchLoading}
                      onValueChange={handleSearchInputChange}
                      onSearch={handleDocumentSearch}
                      onClose={() => {
                        clearSearchState();
                        setShowSearch(false);
                      }}
                    />
                  </Suspense>
                )}
                {/* Main Content Area */}
                {isLoading && (
                  <div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-200/50 dark:bg-zinc-950/70 backdrop-blur-sm animate-fade-in">
                    <div className="flex flex-col items-center space-y-4">
                      <div className="w-8 h-8 border-2 border-zinc-400 dark:border-zinc-600 border-t-zinc-600 dark:border-t-zinc-200 rounded-full animate-spin" />
                      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{t("app.loading.switchingDocument")}</div>
                    </div>
                  </div>
                )}
                {openTabs.map(tab => (
                  <div 
                    key={tab.id}
                    ref={tab.id === activeTabId ? activePdfScrollRef : null}
                    className={`flex-1 w-full bg-zinc-200/50 dark:bg-zinc-950 overflow-y-auto min-h-0 absolute inset-0 ${tab.id === activeTabId ? 'block' : 'hidden'}`}
                  >
                    <Suspense
                      fallback={
                        <div className="flex min-h-full items-center justify-center bg-zinc-200/50 dark:bg-zinc-950">
                          <div className="flex flex-col items-center space-y-3 text-zinc-500 dark:text-zinc-400">
                            <div className="h-7 w-7 rounded-full border-2 border-zinc-300 dark:border-zinc-700 border-t-zinc-600 dark:border-t-zinc-200 animate-spin" />
                            <div className="text-sm font-medium">{t("app.loading.switchingDocument")}</div>
                          </div>
                        </div>
                      }
                    >
                      <PdfViewer 
                        tabId={tab.id}
                        pdfPath={tab.item.attachments?.[0]?.path || ""}
                        totalPages={tab.totalPages} 
                        dimensions={tab.dimensions} 
                        scale={scale} 
                        activeTool={activeTool}
                        currentPage={tab.currentPage}
                        searchMatches={tab.id === activeTabId ? searchMatches : []}
                        activeSearchIndex={tab.id === activeTabId ? activeSearchIndex : -1}
                        onDimensionResolved={updatePageDimension}
                        onCurrentPageChange={tab.id === activeTabId ? handleVisiblePageChange : undefined}
                        onAnnotationsSaved={handleAnnotationsSaved}
                      />
                    </Suspense>
                  </div>
                ))}
              </main>
            </div>
          </div>
        )}

        {!isLibrary && arePdfSidebarsReady && (
          <Suspense fallback={null}>
            <MetaPanel
              selectedItem={selectedItem}
              isOpen={isRightPanelOpen}
              onClose={() => setIsRightPanelOpen(false)}
              width={rightPanelWidth}
              onResizeStart={(event) => startPanelResize(event, "right")}
              tagColors={tagColors}
              onItemUpdated={() => {
                handleItemUpdatedLocally();
                refreshAllTags();
              }}
              onPageJump={handlePageJump}
              annotationsRefreshKey={annotationsRefreshKey}
            />
          </Suspense>
        )}
      </div>

      {isFileDropActive && (
        <div className="pointer-events-none fixed inset-0 z-[95]">
          <div className="absolute inset-4 rounded-[28px] border-2 border-dashed border-indigo-300 bg-indigo-100/40 backdrop-blur-[2px]" />
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div className="w-[min(520px,calc(100vw-3rem))] rounded-[24px] border border-indigo-200 bg-white/92 px-6 py-5 shadow-[0_26px_70px_-30px_rgba(79,70,229,0.45)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">
                {t("app.drag.importPdf")}
              </div>
              <div className="mt-2 text-lg font-semibold text-zinc-900 break-words">
                {fileDropLabel}
              </div>
              <div className="mt-2 text-sm text-zinc-600">
                {t("app.drag.importToFolder", { folder: activeFileDropFolder?.name || "My Library" })}
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* ── Settings Modal ── */}
      <SettingsModal 
        isOpen={showSettings} 
        onClose={() => setShowSettings(false)} 
      />

      {dragState && (
        <div
          className="fixed z-[100] pointer-events-none rounded-xl border border-indigo-200 bg-white/95 px-3 py-2 shadow-xl backdrop-blur-sm animate-popup"
          style={{
            left: dragState.x + 14,
            top: dragState.y + 14,
          }}
        >
          <div className="text-xs font-semibold text-indigo-600">{t("app.drag.movePdf")}</div>
          <div className="max-w-64 truncate text-sm text-zinc-700">{dragState.title}</div>
        </div>
      )}
    </div>
  );
}

export default App;
