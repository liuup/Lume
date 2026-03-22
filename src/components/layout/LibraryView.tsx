import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Download, FilePenLine, FileText, FileUp, GitMerge, Hash, Loader2, Orbit, RotateCcw, Search, Star, Trash2, Trash } from "lucide-react";
import { DuplicateGroup, FolderNode, IdentifierImportResult, LibraryItem } from "../../types";
import { ExportModal } from "./ExportModal";
import { preloadPdfDocument } from "../pdfDocumentRuntime";
import { preloadPdfCoreRuntime } from "../pdfRuntime";
import { useI18n } from "../../hooks/useI18n";
import {
  clampColumnWidth,
  COLUMN_ORDER,
  COLUMN_VISIBILITY_STORAGE_KEY,
  COLUMN_WIDTH_STORAGE_KEY,
  DEFAULT_COLUMN_VISIBILITY,
  DEFAULT_COLUMN_WIDTHS,
  formatDateLabel,
  getResponsiveColumns,
  getVisibleColumns,
  normalizeColumnVisibility,
  normalizeColumnWidths,
  type ColumnVisibilityMap,
  type ColumnWidthMap,
  type SortColumn,
  type SortDirection,
} from "./libraryViewUtils";

// ─── Highlight utility ──────────────────────────────────────────────────────

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim() || !text) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-amber-200 text-amber-900 rounded px-0.5 not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {highlightText(text.slice(idx + query.length), query)}
    </>
  );
}

function parseIdentifierBatchInput(raw: string): string[] {
  return Array.from(new Set(
    raw
      .split(/[\n,;]/)
      .map((value) => value.trim())
      .filter(Boolean),
  ));
}

interface LibraryViewProps {
  folderTree: FolderNode[];
  trashItems: LibraryItem[];
  isTrashView: boolean;
  isFavoritesView?: boolean;
  isDuplicatesView?: boolean;
  isSmartCollectionView?: boolean;
  selectedFolderId: string;
  selectedItemId: string | null;
  favoriteItems?: LibraryItem[];
  duplicateGroups?: DuplicateGroup[];
  smartCollectionItems?: LibraryItem[];
  smartCollectionName?: string | null;
  onSelectItem: (id: string) => void;
  onOpenItem: (item: LibraryItem) => void;
  onAddItem: () => void;
  onAddReferenceFile?: () => Promise<void> | void;
  onAddIdentifier?: (
    identifier: string,
    options?: { silent?: boolean },
  ) => Promise<IdentifierImportResult | null> | IdentifierImportResult | null;
  onMergeDuplicateGroup?: (group: DuplicateGroup) => Promise<void> | void;
  onDeleteItem: (item: LibraryItem) => void;
  onRestoreItem: (item: LibraryItem) => Promise<void> | void;
  onEmptyTrash: () => Promise<void> | void;
  onRenameItem: (item: LibraryItem, nextName: string) => Promise<void> | void;
  onUpdateItemTags: (item: LibraryItem, tags: string[]) => Promise<void> | void;
  onItemPointerDown: (item: LibraryItem, event: React.MouseEvent<HTMLDivElement>) => void;
  isFavoriteItem?: (itemId: string) => boolean;
  onToggleFavorite?: (item: LibraryItem) => void;
  /** Sidebar tag filter (null = no filter active). */
  tagFilter: string | null;
  onClearTagFilter: () => void;
}

export function LibraryView({
  folderTree,
  trashItems,
  isTrashView,
  isFavoritesView = false,
  isDuplicatesView = false,
  isSmartCollectionView = false,
  selectedFolderId,
  selectedItemId,
  favoriteItems = [],
  duplicateGroups = [],
  smartCollectionItems = [],
  smartCollectionName = null,
  onSelectItem,
  onOpenItem,
  onAddItem,
  onAddReferenceFile = async () => undefined,
  onAddIdentifier = async () => null,
  onMergeDuplicateGroup = async () => undefined,
  onDeleteItem,
  onRestoreItem,
  onEmptyTrash,
  onRenameItem,
  onUpdateItemTags,
  onItemPointerDown,
  isFavoriteItem = () => false,
  onToggleFavorite = () => {},
  tagFilter,
  onClearTagFilter,
}: LibraryViewProps) {
  const { t } = useI18n();
  // Search state
  const [query, setQuery]             = useState("");
  const [yearFilter, setYearFilter]   = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("dateAdded");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [columnWidths, setColumnWidths] = useState<ColumnWidthMap>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_COLUMN_WIDTHS;
    }

    try {
      const raw = window.localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY);
      return raw ? normalizeColumnWidths(JSON.parse(raw)) : DEFAULT_COLUMN_WIDTHS;
    } catch {
      return DEFAULT_COLUMN_WIDTHS;
    }
  });
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityMap>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_COLUMN_VISIBILITY;
    }

    try {
      const raw = window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY);
      return raw ? normalizeColumnVisibility(JSON.parse(raw)) : DEFAULT_COLUMN_VISIBILITY;
    } catch {
      return DEFAULT_COLUMN_VISIBILITY;
    }
  });
  const [globalResults, setGlobalResults] = useState<LibraryItem[]>([]);
  const [isSearching, setIsSearching]     = useState(false);

  // UI state
  const [contextMenu, setContextMenu] = useState<{ item: LibraryItem; x: number; y: number } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<LibraryItem | null>(null);
  const [renameValue, setRenameValue]   = useState("");  const [showExport, setShowExport] = useState(false);  const renameInputRef = useRef<HTMLInputElement>(null);
  const [showIdentifierImport, setShowIdentifierImport] = useState(false);
  const [identifierValue, setIdentifierValue] = useState("");
  const [isImportingIdentifier, setIsImportingIdentifier] = useState(false);
  const [identifierImportProgress, setIdentifierImportProgress] = useState<{
    total: number;
    completed: number;
    created: number;
    existing: number;
    failed: number;
  } | null>(null);
  const [mergingGroupId, setMergingGroupId] = useState<string | null>(null);
  const identifierInputRef = useRef<HTMLTextAreaElement>(null);
  const [tagEditorTarget, setTagEditorTarget] = useState<LibraryItem | null>(null);
  const [tagEditorValue, setTagEditorValue] = useState("");
  const [tagEditorTags, setTagEditorTags] = useState<string[]>([]);
  const debounceRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const listViewportRef = useRef<HTMLDivElement>(null);
  const [listViewportWidth, setListViewportWidth] = useState(0);

  // ── Folder tree helpers ──────────────────────────────────────────────────

  function findFolderById(nodes: FolderNode[], id: string): FolderNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      const nested = findFolderById(node.children, id);
      if (nested) return nested;
    }
    return null;
  }

  function collectAllItems(node: FolderNode): LibraryItem[] {
    return [
      ...node.items,
      ...node.children.flatMap(child => collectAllItems(child)),
    ];
  }

  const rootFolder    = folderTree[0] ?? null;
  const selectedFolder = findFolderById(folderTree, selectedFolderId);

  const folderItems: LibraryItem[] = isTrashView
    ? trashItems
    : isDuplicatesView
      ? duplicateGroups.flatMap((group) => group.items)
    : isSmartCollectionView
      ? smartCollectionItems
    : isFavoritesView
      ? favoriteItems
    : selectedFolder
    ? rootFolder && selectedFolder.id === rootFolder.id
      ? collectAllItems(selectedFolder)
      : selectedFolder.items
    : [];

  // ── Global search via Tauri backend ─────────────────────────────────────

  const isGlobalSearch = !isTrashView && !isFavoritesView && !isDuplicatesView && !isSmartCollectionView && (query.trim().length > 0 || yearFilter.trim().length > 0 || !!tagFilter);

  const runGlobalSearch = useCallback(
    (q: string, year: string, sidebarTag: string | null) => {
      if (isTrashView || isFavoritesView || isDuplicatesView || isSmartCollectionView) {
        setGlobalResults([]);
        setIsSearching(false);
        return;
      }
      if (!q.trim() && !year.trim() && !sidebarTag) {
        setGlobalResults([]);
        setIsSearching(false);
        return;
      }
      setIsSearching(true);
      const tagFilters = sidebarTag ? [sidebarTag] : [];
      invoke<LibraryItem[]>("search_library", {
        params: { query: q.trim(), field: "all", year_filter: year.trim() || null, tag_filters: tagFilters },
      })
        .then(results => { setGlobalResults(results); setIsSearching(false); })
        .catch(err   => { console.error("search_library error:", err); setIsSearching(false); });
    },
    [isDuplicatesView, isFavoritesView, isSmartCollectionView, isTrashView]
  );

  // Debounced search trigger — re-runs on any filter change, including sidebar tag
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runGlobalSearch(query, yearFilter, tagFilter), 280);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, yearFilter, tagFilter, runGlobalSearch]);

  // Clear results when all inputs are empty
  useEffect(() => {
    if (!query.trim() && !yearFilter.trim() && !tagFilter) setGlobalResults([]);
  }, [query, yearFilter, tagFilter]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      COLUMN_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ ...columnVisibility, title: true })
    );
  }, [columnVisibility]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    const element = listViewportRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setListViewportWidth(entry.contentRect.width);
    });

    observer.observe(element);
    setListViewportWidth(element.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, []);

  const responsiveColumns = useMemo(() => getResponsiveColumns(listViewportWidth), [listViewportWidth]);
  const visibleColumns = useMemo(
    () => getVisibleColumns(responsiveColumns, columnVisibility),
    [columnVisibility, responsiveColumns]
  );
  const visibleGridTemplateColumns = useMemo(
    () => visibleColumns.map((column) => `${columnWidths[column]}px`).join(" "),
    [columnWidths, visibleColumns]
  );
  const visibleTableMinWidth = useMemo(
    () => visibleColumns.reduce((sum, column) => sum + columnWidths[column], 0) + 32,
    [columnWidths, visibleColumns]
  );

  // ── Context menu listener ────────────────────────────────────────────────

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setContextMenu(null); };
    window.addEventListener("click",   closeMenu);
    window.addEventListener("scroll",  closeMenu, true);
    window.addEventListener("resize",  closeMenu);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("click",   closeMenu);
      window.removeEventListener("scroll",  closeMenu, true);
      window.removeEventListener("resize",  closeMenu);
      window.removeEventListener("keydown", onEsc);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!headerMenu) return;
    const closeMenu = () => setHeaderMenu(null);
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setHeaderMenu(null); };
    window.addEventListener("click", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", onEsc);
    };
  }, [headerMenu]);

  // ── Rename dialog handler ────────────────────────────────────────────────

  useEffect(() => {
    if (!renameTarget) return;
    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setRenameTarget(null); setRenameValue(""); }
    };
    window.addEventListener("keydown", onEsc);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("keydown", onEsc); };
  }, [renameTarget]);

  useEffect(() => {
    if (!tagEditorTarget) return;

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTagEditorTarget(null);
        setTagEditorTags([]);
        setTagEditorValue("");
      }
    };

    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [tagEditorTarget]);

  useEffect(() => {
    if (!showIdentifierImport) return;
    const frame = window.requestAnimationFrame(() => {
      identifierInputRef.current?.focus();
      identifierInputRef.current?.select();
    });
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImportingIdentifier) {
        setShowIdentifierImport(false);
        setIdentifierValue("");
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onEsc);
    };
  }, [isImportingIdentifier, showIdentifierImport]);

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth  - 184) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 56)  : 0;
  const headerMenuX = headerMenu ? Math.min(headerMenu.x, window.innerWidth - 220) : 0;
  const headerMenuY = headerMenu ? Math.min(headerMenu.y, window.innerHeight - 240) : 0;

  const submitRename = async () => {
    if (!renameTarget) return;
    const trimmedName = renameValue.trim();
    if (!trimmedName) return;
    await onRenameItem(renameTarget, trimmedName);
    setRenameTarget(null);
    setRenameValue("");
  };

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;

    setTagEditorTags((prev) => {
      if (prev.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
        return prev;
      }
      return [...prev, tag];
    });
    setTagEditorValue("");
  };

  const removeTag = (tag: string) => {
    setTagEditorTags((prev) => prev.filter((value) => value !== tag));
  };

  const submitTags = async () => {
    if (!tagEditorTarget) return;
    await onUpdateItemTags(tagEditorTarget, tagEditorTags);
    setTagEditorTarget(null);
    setTagEditorTags([]);
    setTagEditorValue("");
  };

  const handleTagEditorKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagEditorValue);
    } else if (e.key === "Backspace" && !tagEditorValue) {
      const lastTag = tagEditorTags[tagEditorTags.length - 1];
      if (lastTag) removeTag(lastTag);
    }
  };

  const submitIdentifierImport = async () => {
    const identifiers = parseIdentifierBatchInput(identifierValue);
    if (identifiers.length === 0) return;

    try {
      setIsImportingIdentifier(true);
      const isBatchImport = identifiers.length > 1;
      let created = 0;
      let existing = 0;
      let failed = 0;

      setIdentifierImportProgress({
        total: identifiers.length,
        completed: 0,
        created: 0,
        existing: 0,
        failed: 0,
      });

      for (const [index, identifier] of identifiers.entries()) {
        const result = await onAddIdentifier(identifier, { silent: isBatchImport });
        if (result?.created) {
          created += 1;
        } else if (result?.item) {
          existing += 1;
        } else {
          failed += 1;
        }

        setIdentifierImportProgress({
          total: identifiers.length,
          completed: index + 1,
          created,
          existing,
          failed,
        });
      }

      if (created > 0 || existing > 0) {
        setShowIdentifierImport(false);
        setIdentifierValue("");
        setIdentifierImportProgress(null);
      }
    } finally {
      setIsImportingIdentifier(false);
    }
  };

  const matchesLocalFilters = useCallback((item: LibraryItem) => {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery = !normalizedQuery
      || item.title.toLowerCase().includes(normalizedQuery)
      || item.authors.toLowerCase().includes(normalizedQuery)
      || item.publication.toLowerCase().includes(normalizedQuery)
      || item.doi.toLowerCase().includes(normalizedQuery)
      || item.arxiv_id.toLowerCase().includes(normalizedQuery);
    const matchesYear = !yearFilter.trim() || item.year === yearFilter.trim();
    const matchesTag = !tagFilter || item.tags.includes(tagFilter);
    return matchesQuery && matchesYear && matchesTag;
  }, [query, tagFilter, yearFilter]);

  const visibleDuplicateGroups = useMemo(() => {
    if (!isDuplicatesView) {
      return [] as DuplicateGroup[];
    }

    return duplicateGroups.filter((group) => group.items.some((item) => matchesLocalFilters(item)));
  }, [duplicateGroups, isDuplicatesView, matchesLocalFilters]);

  const displayItems = useMemo(() => {
    const sourceItems = isDuplicatesView
      ? Array.from(new Map(
        visibleDuplicateGroups.flatMap((group) => group.items).map((item) => [item.id, item]),
      ).values())
      : isGlobalSearch
        ? globalResults
        : folderItems;
    const items = [...sourceItems].filter((item) => {
      if (isGlobalSearch) {
        return true;
      }
      return matchesLocalFilters(item);
    });
    const getTimestamp = (value: string) => {
      const numeric = Number(value);
      if (!Number.isNaN(numeric) && numeric > 0) {
        return numeric;
      }
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    const getYear = (item: LibraryItem) => {
      const numeric = Number(item.year);
      return Number.isNaN(numeric) ? -1 : numeric;
    };

    items.sort((left, right) => {
      let comparison = 0;
      switch (sortColumn) {
        case "title":
          comparison = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
          break;
        case "authors":
          comparison = left.authors.localeCompare(right.authors, undefined, { sensitivity: "base" });
          break;
        case "year":
          comparison = getYear(left) - getYear(right);
          break;
        case "publication":
          comparison = (left.publication || left.publisher || "").localeCompare(
            right.publication || right.publisher || "",
            undefined,
            { sensitivity: "base" }
          );
          break;
        case "dateAdded":
        default:
          comparison = getTimestamp(left.date_added) - getTimestamp(right.date_added);
          break;
      }

      if (comparison === 0) {
        comparison = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });

    return items;
  }, [folderItems, globalResults, isDuplicatesView, isGlobalSearch, matchesLocalFilters, sortColumn, sortDirection, visibleDuplicateGroups]);

  const folderLabel = isTrashView
    ? t("folderSidebar.labels.trash")
    : isDuplicatesView
      ? t("folderSidebar.duplicates.title")
    : isSmartCollectionView
      ? (smartCollectionName ?? t("folderSidebar.smartCollections.title"))
    : isFavoritesView
      ? t("folderSidebar.favorites.title")
      : selectedFolder?.name ?? t("libraryView.myLibrary");
  const exportScopeLabel = isGlobalSearch
    ? (displayItems.length === 1
      ? t("libraryView.export.searchScope.one", { count: displayItems.length })
      : t("libraryView.export.searchScope.other", { count: displayItems.length }))
    : (displayItems.length === 1
      ? t("libraryView.export.folderScope.one", { count: displayItems.length, folder: folderLabel })
      : t("libraryView.export.folderScope.other", { count: displayItems.length, folder: folderLabel }));

  const searchPlaceholder = t("libraryView.search.placeholder.all");

  const toggleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }

    setSortColumn(column);
    setSortDirection(column === "dateAdded" || column === "year" ? "desc" : "asc");
  };

  const toggleColumnVisibility = (column: SortColumn) => {
    if (column === "title") return;
    setColumnVisibility((current) => ({ ...current, [column]: !current[column] }));
  };

  const startColumnResize = (column: SortColumn, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = columnWidths[column];

    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    document.body.style.cursor = "col-resize";

    const handlePointerMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = clampColumnWidth(column, startWidth + delta);
      setColumnWidths((current) => ({ ...current, [column]: nextWidth }));
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
  };

  const autoFitColumn = useCallback((column: SortColumn) => {
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;

    context.font = column === "title" ? "600 14px sans-serif" : "400 14px sans-serif";
    const labelWidths: Record<SortColumn, string> = {
      title: t("libraryView.columns.title"),
      authors: t("libraryView.columns.authors"),
      year: t("libraryView.columns.year"),
      publication: t("libraryView.columns.publication"),
      dateAdded: t("libraryView.columns.dateAdded"),
    };

    const samples = displayItems.slice(0, 200);
    let widest = context.measureText(labelWidths[column]).width + 40;

    for (const item of samples) {
      const cellText = column === "title"
        ? (item.title || item.attachments[0]?.name || t("libraryView.item.untitled"))
        : column === "authors"
          ? (item.authors || "—")
          : column === "year"
            ? (item.year || "—")
            : column === "publication"
              ? (item.publication || item.publisher || "—")
              : formatDateLabel(item.date_added);

      widest = Math.max(widest, context.measureText(cellText).width + (column === "title" ? 48 : 28));
    }

    setColumnWidths((current) => ({
      ...current,
      [column]: clampColumnWidth(column, widest),
    }));
  }, [displayItems, t]);

  const duplicateReasonLabel = (reason: DuplicateGroup["reason"]) => {
    const key = `libraryView.duplicates.reason.${reason}`;
    return t(key, undefined, reason);
  };

  const duplicateReasonClassName = (reason: DuplicateGroup["reason"]) => {
    if (reason === "doi") {
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200";
    }
    if (reason === "arxiv") {
      return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200";
    }
    return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200";
  };

  const handleMergeDuplicateGroup = async (group: DuplicateGroup) => {
    if (group.items.length < 2) {
      return;
    }

    try {
      setMergingGroupId(group.id);
      await onMergeDuplicateGroup(group);
    } finally {
      setMergingGroupId((current) => current === group.id ? null : current);
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full bg-white dark:bg-zinc-950 relative">

      {/* ── Search header ───────────────────────────────────── */}
      <div className="border-b border-zinc-200 dark:border-zinc-800 flex flex-col shrink-0 bg-white/90 dark:bg-zinc-950/95 backdrop-blur-sm sticky top-0 z-10 min-w-0">

        {/* Row 1 – search input + add button */}
        <div className="flex flex-wrap items-center gap-3 px-4 md:px-6 py-3">
          <div className="relative min-w-0 flex-[1_1_320px] max-w-2xl">
            {isSearching
              ? <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 text-indigo-400 animate-spin" size={16} />
              : <Search  className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={16} />
            }
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full pl-10 pr-4 py-2 bg-zinc-100 border-transparent focus:bg-white border focus:border-indigo-400 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-400/20 transition-all placeholder:text-zinc-400 shadow-sm dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:bg-zinc-950 dark:focus:border-indigo-800"
            />
          </div>
          {isTrashView ? (
            <button
              onClick={() => { void onEmptyTrash(); }}
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3 md:px-4 py-2 text-sm font-medium text-red-600 dark:text-red-300 bg-white dark:bg-zinc-950 border border-red-200 dark:border-red-950/70 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors shadow-sm active:scale-[0.98]"
              title={t("libraryView.actions.emptyTrashTitle")}
            >
              <Trash size={15} />
              <span className="hidden min-[900px]:inline">{t("libraryView.actions.emptyTrash")}</span>
            </button>
          ) : (
            <>
              <button
                onClick={() => setShowExport(true)}
                className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3 md:px-4 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98] dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-indigo-300 dark:hover:border-indigo-900/70"
                title={t("libraryView.actions.exportTitle")}
              >
                <Download size={15} />
                <span className="hidden min-[900px]:inline">{t("libraryView.actions.export")}</span>
              </button>
              <button
                onClick={() => {
                  void onAddReferenceFile();
                }}
                className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3 md:px-4 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-emerald-600 hover:border-emerald-200 transition-colors shadow-sm active:scale-[0.98] dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-emerald-300 dark:hover:border-emerald-900/70"
                title={t("libraryView.actions.addReferenceFile", undefined, "Import BibTeX / RIS / CSL JSON")}
              >
                <FileText size={15} />
                <span className="hidden min-[900px]:inline">{t("libraryView.actions.addReferenceFile", undefined, "Import BibTeX / RIS / CSL JSON")}</span>
              </button>
              <button
                onClick={() => setShowIdentifierImport(true)}
                className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3 md:px-4 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-cyan-600 hover:border-cyan-200 transition-colors shadow-sm active:scale-[0.98] dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-cyan-300 dark:hover:border-cyan-900/70"
                title={t("libraryView.actions.addIdentifier", undefined, "Add DOI / arXiv")}
              >
                <Orbit size={15} />
                <span className="hidden min-[900px]:inline">{t("libraryView.actions.addIdentifier", undefined, "Add DOI / arXiv")}</span>
              </button>
              <button
                onClick={onAddItem}
                className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3 md:px-4 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98] dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-indigo-300 dark:hover:border-indigo-900/70"
              >
                <FileUp size={15} />
                <span className="hidden min-[900px]:inline">{t("libraryView.actions.addItem")}</span>
              </button>
            </>
          )}
        </div>

        {/* Row 2 – year input + filters */}
        <div className="flex items-center gap-2 px-4 md:px-6 pb-3 flex-wrap min-w-0">
          {/* Year filter */}
          <div className="flex items-center ml-1">
            <input
              type="text"
              value={yearFilter}
              onChange={e => setYearFilter(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="2024"
              maxLength={4}
              className="w-16 px-2 py-1 bg-zinc-100 border border-transparent focus:bg-white focus:border-indigo-400 rounded-lg text-xs outline-none focus:ring-2 focus:ring-indigo-400/20 transition-all placeholder:text-zinc-400 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:bg-zinc-950 dark:focus:border-indigo-800"
            />
          </div>

          {/* Active sidebar tag chip */}
          {tagFilter && !isTrashView && (
            <div className="flex items-center gap-1.5 ml-1 px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium border border-indigo-200 dark:border-indigo-900/70 dark:bg-indigo-950/40 dark:text-indigo-200">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
              <span>#{tagFilter}</span>
              <button
                onClick={onClearTagFilter}
                className="ml-0.5 text-indigo-400 hover:text-indigo-700 transition-colors leading-none dark:text-indigo-400 dark:hover:text-indigo-200"
                title={t("libraryView.search.clearTag")}
              >
                ×
              </button>
            </div>
          )}

        </div>
      </div>

      {/* ── Item list ───────────────────────────────────────── */}
      <div ref={listViewportRef} className="flex-1 overflow-y-auto">
        {displayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-zinc-400 dark:text-zinc-500 space-y-4 mt-10 px-6">
            <div className="w-16 h-16 bg-zinc-50 dark:bg-zinc-900 rounded-2xl flex items-center justify-center border border-zinc-200/60 dark:border-zinc-800 shadow-sm">
              <FileText size={32} className="opacity-40" />
            </div>
            {isGlobalSearch ? (
              <p className="text-sm">{isSearching ? t("libraryView.empty.searching") : t("libraryView.empty.noResults")}</p>
            ) : (
              <>
                <p className="text-sm">
                  {isDuplicatesView
                    ? t("libraryView.empty.noDuplicates", undefined, "No duplicate groups found")
                    : isSmartCollectionView
                    ? t("libraryView.empty.noSmartCollectionItems", { name: smartCollectionName ?? t("folderSidebar.smartCollections.title") })
                    : isFavoritesView
                      ? t("libraryView.empty.noFavorites", undefined, "No favorite papers yet")
                      : t("libraryView.empty.noItems")}
                </p>
                <p className="text-xs text-zinc-400">
                  {isDuplicatesView
                    ? t("libraryView.duplicates.hint", undefined, "Duplicate groups are inferred from DOI, arXiv ID, and title/author/year matches.")
                    : t("libraryView.empty.hint")}
                </p>
              </>
            )}
          </div>
        ) : isDuplicatesView ? (
          <div className="space-y-4 px-4 py-4 md:px-6">
            {visibleDuplicateGroups.map((group) => (
              <section
                key={group.id}
                className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/80 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/70">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${duplicateReasonClassName(group.reason)}`}>
                        {duplicateReasonLabel(group.reason)}
                      </span>
                      <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                        {t("libraryView.duplicates.groupCount", { count: group.items.length }, `${group.items.length} items`)}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {group.matchValue}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void handleMergeDuplicateGroup(group);
                    }}
                    disabled={mergingGroupId === group.id}
                    className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-70 dark:border-emerald-900/70 dark:bg-zinc-950 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                    title={t("libraryView.duplicates.merge", undefined, "Merge Group")}
                  >
                    {mergingGroupId === group.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <GitMerge size={14} />
                    )}
                    <span>
                      {mergingGroupId === group.id
                        ? t("libraryView.duplicates.merging", undefined, "Merging")
                        : t("libraryView.duplicates.merge", undefined, "Merge Group")}
                    </span>
                  </button>
                </div>
                <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {group.items.map((item) => {
                    const hasPdf = item.attachments.some((attachment) => attachment.attachment_type.toLowerCase() === "pdf");
                    return (
                      <div
                        key={item.id}
                        className={`flex items-start gap-3 px-4 py-3 transition-colors ${
                          selectedItemId === item.id
                            ? "bg-indigo-50/80 dark:bg-indigo-950/20"
                            : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                        }`}
                        onPointerDown={(event) => onItemPointerDown(item, event)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onSelectItem(item.id);
                          setContextMenu({ item, x: event.clientX, y: event.clientY });
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectItem(item.id)}
                          onDoubleClick={() => onOpenItem(item)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                              {item.title || item.attachments[0]?.name || t("libraryView.item.untitled")}
                            </span>
                            {!hasPdf ? (
                              <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                                {t("libraryView.duplicates.metadataOnly", undefined, "Metadata only")}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            {[item.authors || "—", item.year || "—", item.publication || item.publisher || "—"]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleFavorite(item)}
                          className={`mt-0.5 rounded-lg p-1.5 transition-colors ${
                            isFavoriteItem(item.id)
                              ? "text-amber-500 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/30"
                              : "text-zinc-400 hover:bg-zinc-100 hover:text-amber-500 dark:text-zinc-500 dark:hover:bg-zinc-900 dark:hover:text-amber-300"
                          }`}
                          title={isFavoriteItem(item.id)
                            ? t("libraryView.context.unfavorite", undefined, "Remove from Favorites")
                            : t("libraryView.context.favorite", undefined, "Add to Favorites")}
                        >
                          <Star size={15} className={isFavoriteItem(item.id) ? "fill-current" : undefined} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto">
            <div style={{ minWidth: visibleTableMinWidth }}>
              <div
                className="grid gap-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/80 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
                style={{ gridTemplateColumns: visibleGridTemplateColumns }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setHeaderMenu({ x: event.clientX, y: event.clientY });
                  setContextMenu(null);
                }}
              >
                {visibleColumns.includes("title") && (
                  <SortableHeader label={t("libraryView.columns.title")} active={sortColumn === "title"} direction={sortDirection} onClick={() => toggleSort("title")} onResizeStart={(event) => startColumnResize("title", event)} onAutoFit={() => autoFitColumn("title")} />
                )}
                {visibleColumns.includes("authors") && (
                  <SortableHeader label={t("libraryView.columns.authors")} active={sortColumn === "authors"} direction={sortDirection} onClick={() => toggleSort("authors")} onResizeStart={(event) => startColumnResize("authors", event)} onAutoFit={() => autoFitColumn("authors")} />
                )}
                {visibleColumns.includes("year") && (
                  <SortableHeader label={t("libraryView.columns.year")} active={sortColumn === "year"} direction={sortDirection} onClick={() => toggleSort("year")} onResizeStart={(event) => startColumnResize("year", event)} onAutoFit={() => autoFitColumn("year")} />
                )}
                {visibleColumns.includes("publication") && (
                  <SortableHeader label={t("libraryView.columns.publication")} active={sortColumn === "publication"} direction={sortDirection} onClick={() => toggleSort("publication")} onResizeStart={(event) => startColumnResize("publication", event)} onAutoFit={() => autoFitColumn("publication")} />
                )}
                {visibleColumns.includes("dateAdded") && (
                  <SortableHeader label={t("libraryView.columns.dateAdded")} active={sortColumn === "dateAdded"} direction={sortDirection} onClick={() => toggleSort("dateAdded")} onResizeStart={(event) => startColumnResize("dateAdded", event)} onAutoFit={() => autoFitColumn("dateAdded")} />
                )}
              </div>
              {displayItems.map(item => (
                <LibraryItemRow
                  key={item.id}
                  item={item}
                  isSelected={selectedItemId === item.id}
                  highlight={isGlobalSearch ? query : ""}
                  isFavorite={isFavoriteItem(item.id)}
                  visibleColumns={visibleColumns}
                  gridTemplateColumns={visibleGridTemplateColumns}
                  onSelect={() => onSelectItem(item.id)}
                  onOpen={() => onOpenItem(item)}
                  onToggleFavorite={() => onToggleFavorite(item)}
                  onPointerDown={event => onItemPointerDown(item, event)}
                  onContextMenu={event => {
                    onSelectItem(item.id);
                    setContextMenu({ item, x: event.clientX, y: event.clientY });
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Context menu ────────────────────────────────────── */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-[0_12px_40px_rgba(0,0,0,0.14)] animate-popup dark:border-zinc-800 dark:bg-zinc-950"
          style={{ left: menuX, top: menuY }}
          onClick={e => e.stopPropagation()}
        >
          {isTrashView ? (
            <>
              <button
                onClick={() => {
                  void onRestoreItem(contextMenu.item);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                <RotateCcw size={15} />
                <span>{t("libraryView.context.restore")}</span>
              </button>
              <button
                onClick={() => {
                  void onEmptyTrash();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
              >
                <Trash2 size={15} />
                <span>{t("libraryView.actions.emptyTrash")}</span>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setRenameTarget(contextMenu.item);
                  setRenameValue(contextMenu.item.title || contextMenu.item.attachments[0]?.name || t("libraryView.item.untitled"));
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                <FilePenLine size={15} />
                <span>{t("libraryView.context.rename")}</span>
              </button>
              <button
                onClick={() => {
                  onToggleFavorite(contextMenu.item);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                <Star size={15} className={isFavoriteItem(contextMenu.item.id) ? "fill-current text-amber-500 dark:text-amber-300" : ""} />
                <span>{isFavoriteItem(contextMenu.item.id)
                  ? t("libraryView.context.unfavorite", undefined, "Remove from Favorites")
                  : t("libraryView.context.favorite", undefined, "Add to Favorites")}</span>
              </button>
              <button
                onClick={() => {
                  setTagEditorTarget(contextMenu.item);
                  setTagEditorTags(contextMenu.item.tags ?? []);
                  setTagEditorValue("");
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                <Hash size={15} />
                <span>{t("libraryView.context.editTags", undefined, "Edit Tags")}</span>
              </button>
              <button
                onClick={() => {
                  onDeleteItem(contextMenu.item);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
              >
                <Trash2 size={15} />
                <span>{t("libraryView.context.delete")}</span>
              </button>
            </>
          )}
        </div>
      )}

      {headerMenu && (
        <div
          className="fixed z-50 min-w-52 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.14)] animate-popup dark:border-zinc-800 dark:bg-zinc-950"
          style={{ left: headerMenuX, top: headerMenuY }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            {t("libraryView.columnMenu.title", undefined, "Visible Columns")}
          </div>
          {COLUMN_ORDER.map((column) => {
            const isForced = column === "title";
            const isChecked = isForced || columnVisibility[column];
            return (
              <button
                key={column}
                type="button"
                disabled={isForced}
                onClick={() => toggleColumnVisibility(column)}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-left ${
                  isForced
                    ? "cursor-not-allowed text-zinc-400 dark:text-zinc-500"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
                }`}
              >
                <span className={`flex h-4 w-4 items-center justify-center rounded border text-[11px] ${
                  isChecked
                    ? "border-indigo-500 bg-indigo-500 text-white dark:border-indigo-700 dark:bg-indigo-700"
                    : "border-zinc-300 bg-white text-transparent dark:border-zinc-700 dark:bg-zinc-950"
                }`}>
                  ✓
                </span>
                <span className="flex-1 truncate">{t(`libraryView.columns.${column}`)}</span>
                {isForced ? (
                  <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
                    {t("libraryView.columnMenu.alwaysVisible", undefined, "Required")}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {renameTarget && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-zinc-900/10 backdrop-blur-[1px] animate-backdrop dark:bg-zinc-950/70"
          onClick={() => {
            setRenameTarget(null);
            setRenameValue("");
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)] animate-modal dark:border-zinc-800 dark:bg-zinc-950"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
                <FilePenLine size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("libraryView.renameDialog.title")}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("libraryView.renameDialog.description")}</p>
              </div>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={async e => {
                e.preventDefault();
                await submitRename();
              }}
            >
              <div>
                <label className="mb-2 block text-xs font-medium text-zinc-500 dark:text-zinc-400">{t("libraryView.renameDialog.fileName")}</label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/15 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-indigo-800 dark:focus-within:bg-zinc-950">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                    placeholder={t("libraryView.renameDialog.placeholder")}
                  />
                  {renameTarget.attachments.some((attachment) => attachment.attachment_type.toLowerCase() === "pdf") ? (
                    <span className="shrink-0 text-sm text-zinc-400 dark:text-zinc-500">.pdf</span>
                  ) : null}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRenameTarget(null);
                    setRenameValue("");
                  }}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  {t("libraryView.renameDialog.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!renameValue.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300 dark:disabled:bg-indigo-900/60"
                >
                  {t("libraryView.renameDialog.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showIdentifierImport && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-zinc-900/10 backdrop-blur-[1px] animate-backdrop dark:bg-zinc-950/70"
          onClick={() => {
            if (isImportingIdentifier) return;
            setShowIdentifierImport(false);
            setIdentifierValue("");
            setIdentifierImportProgress(null);
          }}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)] animate-modal dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-cyan-50 p-2 text-cyan-600 dark:bg-cyan-950/40 dark:text-cyan-300">
                <Orbit size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {t("libraryView.identifierDialog.title", undefined, "Import by DOI / arXiv")}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t("libraryView.identifierDialog.description", undefined, "Create library items from DOI or arXiv identifiers.")}
                </p>
              </div>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={async (event) => {
                event.preventDefault();
                await submitIdentifierImport();
              }}
            >
              <div>
                <label className="mb-2 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {t("libraryView.identifierDialog.label", undefined, "Identifiers")}
                </label>
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-cyan-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-cyan-400/15 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-cyan-800 dark:focus-within:bg-zinc-950">
                  <textarea
                    ref={identifierInputRef}
                    value={identifierValue}
                    onChange={(event) => setIdentifierValue(event.target.value)}
                    rows={4}
                    className="w-full resize-none bg-transparent py-2.5 text-sm text-zinc-800 outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                    placeholder={t("libraryView.identifierDialog.placeholder", undefined, "10.48550/arXiv.1706.03762\n1706.03762\n10.1145/3292500.3330701")}
                  />
                </div>
                <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                  {t("libraryView.identifierDialog.help", undefined, "Paste one identifier per line, or separate multiple values with commas. Supports DOI URLs, raw DOI values, arXiv URLs, and arXiv IDs.")}
                </p>
                {identifierImportProgress ? (
                  <div className="mt-3 rounded-xl border border-cyan-100 bg-cyan-50 px-3 py-2 text-xs text-cyan-700 dark:border-cyan-900/70 dark:bg-cyan-950/20 dark:text-cyan-200">
                    <div className="font-medium">
                      {t("libraryView.identifierDialog.progress", {
                        completed: identifierImportProgress.completed,
                        total: identifierImportProgress.total,
                      }, `${identifierImportProgress.completed}/${identifierImportProgress.total}`)}
                    </div>
                    <div className="mt-1 text-[11px] text-cyan-600 dark:text-cyan-300">
                      {t("libraryView.identifierDialog.summary", {
                        created: identifierImportProgress.created,
                        existing: identifierImportProgress.existing,
                        failed: identifierImportProgress.failed,
                      }, `${identifierImportProgress.created} new · ${identifierImportProgress.existing} existing · ${identifierImportProgress.failed} failed`)}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={isImportingIdentifier}
                  onClick={() => {
                    setShowIdentifierImport(false);
                    setIdentifierValue("");
                    setIdentifierImportProgress(null);
                  }}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  {t("libraryView.identifierDialog.cancel", undefined, "Cancel")}
                </button>
                <button
                  type="submit"
                  disabled={parseIdentifierBatchInput(identifierValue).length === 0 || isImportingIdentifier}
                  className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-cyan-300 dark:bg-cyan-700 dark:hover:bg-cyan-600 dark:disabled:bg-cyan-950/60"
                >
                  {isImportingIdentifier ? <Loader2 size={14} className="animate-spin" /> : null}
                  {isImportingIdentifier
                    ? t("libraryView.identifierDialog.importing", undefined, "Importing")
                    : t("libraryView.identifierDialog.import", undefined, "Import")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {tagEditorTarget && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-zinc-900/10 backdrop-blur-[1px] animate-backdrop dark:bg-zinc-950/70"
          onClick={() => {
            setTagEditorTarget(null);
            setTagEditorTags([]);
            setTagEditorValue("");
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)] animate-modal dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
                <Hash size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("libraryView.tagDialog.title", undefined, "Edit Item Tags")}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("libraryView.tagDialog.description", undefined, "Add custom tags for this PDF item.")}</p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <div
                className="flex flex-wrap gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 min-h-[44px] dark:border-zinc-800 dark:bg-zinc-900"
                onClick={() => {
                  const input = document.getElementById("library-tag-editor-input") as HTMLInputElement | null;
                  input?.focus();
                }}
              >
                {tagEditorTags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-600 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-200">
                    {tag}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTag(tag);
                      }}
                      className="leading-none text-indigo-400 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-200"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  id="library-tag-editor-input"
                  type="text"
                  value={tagEditorValue}
                  onChange={(e) => setTagEditorValue(e.target.value)}
                  onKeyDown={handleTagEditorKeyDown}
                  onBlur={() => { if (tagEditorValue.trim()) addTag(tagEditorValue); }}
                  placeholder={tagEditorTags.length === 0 ? t("libraryView.tagDialog.placeholder", undefined, "Type tag and press Enter") : ""}
                  className="min-w-[140px] flex-1 bg-transparent text-sm text-zinc-700 outline-none placeholder:text-zinc-400 dark:text-zinc-200 dark:placeholder:text-zinc-500"
                />
              </div>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t("libraryView.tagDialog.help", undefined, "Press Enter or comma to add a tag.")}</p>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setTagEditorTarget(null);
                  setTagEditorTags([]);
                  setTagEditorValue("");
                }}
                className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                {t("libraryView.tagDialog.cancel", undefined, "Cancel")}
              </button>
              <button
                type="button"
                onClick={submitTags}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 dark:bg-indigo-700 dark:hover:bg-indigo-600"
              >
                {t("libraryView.tagDialog.save", undefined, "Save")}
              </button>
            </div>
          </div>
        </div>
      )}

    {/* Export modal — uses fixed positioning, renders correctly inside any container */}
    <ExportModal
      items={displayItems}
      isOpen={!isTrashView && showExport}
      onClose={() => setShowExport(false)}
      scopeLabel={exportScopeLabel}
    />
  </div>
  );
}

// ─── LibraryItemRow ──────────────────────────────────────────────────────────

function LibraryItemRow({
  item,
  isSelected,
  highlight,
  isFavorite,
  visibleColumns,
  gridTemplateColumns,
  onSelect,
  onOpen,
  onToggleFavorite,
  onPointerDown,
  onContextMenu,
}: {
  item: LibraryItem;
  isSelected: boolean;
  highlight: string;
  isFavorite: boolean;
  visibleColumns: SortColumn[];
  gridTemplateColumns: string;
  onSelect: () => void;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onPointerDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const displayTitle = item.title || item.attachments[0]?.name || t("libraryView.item.untitled");
  const displayAuthors = item.authors || "—";
  const displayYear = item.year || "—";
  const displayPublication = item.publication || item.publisher || "—";
  const displayDateAdded = formatDateLabel(item.date_added);
  const warmPdfRuntime = () => {
    void preloadPdfCoreRuntime();
    const pdfPath = item.attachments?.[0]?.path || item.id;
    void preloadPdfDocument(pdfPath);
  };

  return (
    <div
      className={`library-item-row group grid items-center gap-3 px-3 py-2 cursor-pointer transition-colors select-none border-b border-zinc-100 dark:border-zinc-900 ${
        isSelected ? "bg-indigo-50 dark:bg-indigo-950/40" : "bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900/70"
      }`}
      data-selected={isSelected ? "true" : "false"}
      style={{ cursor: "grab", gridTemplateColumns }}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onMouseEnter={warmPdfRuntime}
      onFocus={warmPdfRuntime}
      onMouseDown={onPointerDown}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu(e); }}
      title={t("libraryView.item.openHint")}
      tabIndex={0}
    >
      {visibleColumns.includes("title") && (
        <div className="min-w-0 flex items-center gap-2">
          <div className={`p-1.25 rounded-lg shrink-0 ${
            isSelected ? "bg-indigo-100 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-300" : "bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 group-hover:text-indigo-500 dark:group-hover:text-indigo-300 transition-colors"
          }`}>
            <FileText size={14} />
          </div>
          <div className="min-w-0 flex flex-1 items-center gap-2">
            <h3 className="library-item-title flex-1 truncate text-[13px] font-semibold text-zinc-800 transition-colors group-hover:text-indigo-900 dark:text-zinc-100 dark:group-hover:text-indigo-200">
              {highlight ? highlightText(displayTitle, highlight) : displayTitle}
            </h3>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite();
              }}
              className={`rounded-md p-1 transition-colors ${
                isFavorite
                  ? "text-amber-500 hover:text-amber-600 dark:text-amber-300 dark:hover:text-amber-200"
                  : "text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-amber-500 dark:text-zinc-700 dark:hover:text-amber-300"
              }`}
              title={isFavorite
                ? t("libraryView.context.unfavorite", undefined, "Remove from Favorites")
                : t("libraryView.context.favorite", undefined, "Add to Favorites")}
            >
              <Star size={14} className={isFavorite ? "fill-current" : undefined} />
            </button>
          </div>
        </div>
      )}
      {visibleColumns.includes("authors") && (
        <div className="truncate text-sm text-zinc-600 dark:text-zinc-300">{highlight ? highlightText(displayAuthors, highlight) : displayAuthors}</div>
      )}
      {visibleColumns.includes("year") && (
        <div className="truncate text-sm text-zinc-500 dark:text-zinc-400">{displayYear}</div>
      )}
      {visibleColumns.includes("publication") && (
        <div className="truncate text-sm text-zinc-500 dark:text-zinc-400">{highlight ? highlightText(displayPublication, highlight) : displayPublication}</div>
      )}
      {visibleColumns.includes("dateAdded") && (
        <div className="truncate text-sm text-zinc-500 dark:text-zinc-400">{displayDateAdded}</div>
      )}
    </div>
  );
}

function SortableHeader({
  label,
  active,
  direction,
  onClick,
  onResizeStart,
  onAutoFit,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
  onResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  onAutoFit: () => void;
}) {
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full min-w-0 items-center gap-1 pr-3 text-left transition-colors ${active ? "text-zinc-700 dark:text-zinc-100" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100"}`}
      >
        <span className="truncate">{label}</span>
        {active ? (
          direction === "asc" ? <ArrowUp size={12} className="shrink-0" /> : <ArrowDown size={12} className="shrink-0" />
        ) : null}
      </button>
      <div
        className="absolute right-[-6px] top-1/2 h-6 w-3 -translate-y-1/2 cursor-col-resize"
        onMouseDown={onResizeStart}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onAutoFit();
        }}
        title="Resize column"
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-zinc-200 dark:bg-zinc-700 hover:bg-indigo-400" />
      </div>
    </div>
  );
}
