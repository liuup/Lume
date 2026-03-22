import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, FilePenLine, Folder, FolderOpen, FolderPlus, Hash, History, Orbit, Plus, Settings, Star, Trash2 } from "lucide-react";
import { DuplicateGroup, FAVORITES_FOLDER_ID, FolderNode, LibraryItem, RecentDocument, SmartCollection, SmartCollectionMatchMode, TagInfo, TRASH_FOLDER_ID } from "../../types";
import { useI18n } from "../../hooks/useI18n";

// ── Preset tag palette ──────────────────────────────────────────────────────
const TAG_COLORS: { label: string; value: string }[] = [
  { label: 'Indigo',  value: '#6366f1' },
  { label: 'Sky',     value: '#0ea5e9' },
  { label: 'Teal',    value: '#14b8a6' },
  { label: 'Emerald', value: '#10b981' },
  { label: 'Amber',   value: '#f59e0b' },
  { label: 'Orange',  value: '#f97316' },
  { label: 'Rose',    value: '#f43f5e' },
  { label: 'Violet',  value: '#8b5cf6' },
];

const DEFAULT_TAG_COLOR = '#94a3b8'; // zinc-400 when no color assigned

interface FolderSidebarProps {
  folderTree: FolderNode[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  selectedFolderId: string;
  onSelectFolder: (id: string) => void;
  trashCount: number;
  onAddFolder: (parentId: string, name: string) => Promise<void>;
  onRenameFolder: (folder: FolderNode, nextName: string) => Promise<void> | void;
  onDeleteFolder: (folder: FolderNode) => Promise<void> | void;
  draggedItemId: string | null;
  dragOverFolderId: string | null;
  onFolderHover: (folderId: string | null) => void;
  recentDocuments: RecentDocument[];
  onOpenRecentDocument: (itemId: string) => void;
  favoriteDocuments: LibraryItem[];
  onOpenFavoriteDocument: (itemId: string) => void;
  duplicateGroups: DuplicateGroup[];
  isDuplicatesSelected: boolean;
  onSelectDuplicates: () => void;
  smartCollections: SmartCollection[];
  selectedSmartCollectionId: string | null;
  onSelectSmartCollection: (collectionId: string) => void;
  onCreateSmartCollection: (collection: Omit<SmartCollection, "id" | "createdAt" | "updatedAt">) => void;
  onUpdateSmartCollection: (collectionId: string, collection: Omit<SmartCollection, "id" | "createdAt" | "updatedAt">) => void;
  onDeleteSmartCollection: (collectionId: string) => void;
  // ── tag system ────────
  allTags: TagInfo[];
  selectedTagFilter: string | null;
  onSelectTag: (tag: string) => void;
  onSetTagColor: (tag: string, color: string) => Promise<void>;
  
  onOpenSettings: () => void;
}

export function FolderSidebar({
  folderTree,
  isCollapsed,
  onToggleCollapse,
  selectedFolderId,
  onSelectFolder,
  trashCount,
  onAddFolder,
  onRenameFolder,
  onDeleteFolder,
  draggedItemId,
  dragOverFolderId,
  onFolderHover,
  recentDocuments,
  onOpenRecentDocument,
  favoriteDocuments,
  onOpenFavoriteDocument,
  duplicateGroups,
  isDuplicatesSelected,
  onSelectDuplicates,
  smartCollections,
  selectedSmartCollectionId,
  onSelectSmartCollection,
  onCreateSmartCollection,
  onUpdateSmartCollection,
  onDeleteSmartCollection,
  allTags,
  selectedTagFilter,
  onSelectTag,
  onSetTagColor,
  onOpenSettings
}: FolderSidebarProps) {
  const { t } = useI18n();
  const rootFolderId = folderTree[0]?.id ?? null;
  const selectedFolder = findFolderNode(folderTree, selectedFolderId);
  const isFavoritesSelected = selectedFolderId === FAVORITES_FOLDER_ID;
  const duplicateItemCount = duplicateGroups.reduce((sum, group) => sum + group.items.length, 0);
  const isTrashSelected = selectedFolderId === TRASH_FOLDER_ID;
  const [smartCollectionDialog, setSmartCollectionDialog] = useState<{
    mode: "create" | "edit";
    collection: SmartCollection | null;
  } | null>(null);
  const [smartCollectionName, setSmartCollectionName] = useState("");
  const [smartCollectionQuery, setSmartCollectionQuery] = useState("");
  const [smartCollectionYear, setSmartCollectionYear] = useState("");
  const [smartCollectionTags, setSmartCollectionTags] = useState("");
  const [smartCollectionFavoritesOnly, setSmartCollectionFavoritesOnly] = useState(false);
  const [smartCollectionMatchMode, setSmartCollectionMatchMode] = useState<SmartCollectionMatchMode>("all");
  const smartCollectionNameRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    folder: FolderNode;
    x: number;
    y: number;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<FolderNode | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [tagColorMenu, setTagColorMenu] = useState<{
    tag: string;
    currentColor: string;
    x: number;
    y: number;
  } | null>(null);

  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!smartCollectionDialog) return;

    const frame = window.requestAnimationFrame(() => {
      smartCollectionNameRef.current?.focus();
      smartCollectionNameRef.current?.select();
    });

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSmartCollectionDialog(null);
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [smartCollectionDialog]);

  useEffect(() => {
    if (!contextMenu) return;

    const closeMenu = () => setContextMenu(null);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!newFolderParentId) return;

    const frame = window.requestAnimationFrame(() => {
      newFolderInputRef.current?.focus();
    });

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNewFolderParentId(null);
        setNewFolderName("");
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [newFolderParentId]);

  useEffect(() => {
    if (!renameTarget) return;

    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRenameTarget(null);
        setRenameValue("");
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [renameTarget]);

  useEffect(() => {
    if (!tagColorMenu) return;
    const close = () => setTagColorMenu(null);
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setTagColorMenu(null); };
    window.addEventListener('click',   close);
    window.addEventListener('scroll',  close, true);
    window.addEventListener('resize',  close);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('click',   close);
      window.removeEventListener('scroll',  close, true);
      window.removeEventListener('resize',  close);
      window.removeEventListener('keydown', onEsc);
    };
  }, [tagColorMenu]);

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 184) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 56)  : 0;

  const submitNewFolder = async () => {
    if (!newFolderParentId) return;
    const trimmedName = newFolderName.trim();
    if (!trimmedName) return;
    await onAddFolder(newFolderParentId, trimmedName);
    setNewFolderParentId(null);
    setNewFolderName("");
  };

  const submitRename = async () => {
    if (!renameTarget) return;

    const trimmedName = renameValue.trim();
    if (!trimmedName) return;

    await onRenameFolder(renameTarget, trimmedName);
    setRenameTarget(null);
    setRenameValue("");
  };

  const resetSmartCollectionForm = () => {
    setSmartCollectionName("");
    setSmartCollectionQuery("");
    setSmartCollectionYear("");
    setSmartCollectionTags("");
    setSmartCollectionFavoritesOnly(false);
    setSmartCollectionMatchMode("all");
  };

  const openSmartCollectionDialog = (mode: "create" | "edit", collection?: SmartCollection) => {
    if (mode === "edit" && collection) {
      setSmartCollectionName(collection.name);
      setSmartCollectionQuery(collection.query);
      setSmartCollectionYear(collection.year);
      setSmartCollectionTags(collection.tags.join(", "));
      setSmartCollectionFavoritesOnly(collection.favoritesOnly);
      setSmartCollectionMatchMode(collection.matchMode);
      setSmartCollectionDialog({ mode, collection });
      return;
    }

    resetSmartCollectionForm();
    setSmartCollectionDialog({ mode, collection: null });
  };

  const closeSmartCollectionDialog = () => {
    setSmartCollectionDialog(null);
    resetSmartCollectionForm();
  };

  const parseSmartCollectionTags = (value: string) => {
    const seen = new Set<string>();
    return value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => {
        if (!entry) {
          return false;
        }
        const key = entry.toLowerCase();
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  };

  const smartCollectionTagsList = parseSmartCollectionTags(smartCollectionTags);
  const hasSmartCollectionRule = Boolean(
    smartCollectionQuery.trim()
    || smartCollectionYear.trim()
    || smartCollectionTagsList.length > 0
    || smartCollectionFavoritesOnly
  );

  const smartCollectionSummary = (collection: SmartCollection) => {
    const parts: string[] = [];

    if (collection.query) {
      parts.push(`"${collection.query}"`);
    }
    if (collection.year) {
      parts.push(`${t("folderSidebar.smartCollections.summary.year")}: ${collection.year}`);
    }
    if (collection.tags.length > 0) {
      parts.push(`${t("folderSidebar.smartCollections.summary.tags")}: ${collection.tags.join(", ")}`);
    }
    if (collection.favoritesOnly) {
      parts.push(t("folderSidebar.smartCollections.summary.favoritesOnly"));
    }

    if (parts.length === 0) {
      return t("folderSidebar.smartCollections.emptyRules");
    }

    const modeLabel = t(`folderSidebar.smartCollections.dialog.matchMode.${collection.matchMode}`);
    return `${modeLabel} · ${parts.join(" · ")}`;
  };

  const submitSmartCollection = () => {
    const trimmedName = smartCollectionName.trim();
    const trimmedQuery = smartCollectionQuery.trim();
    const trimmedYear = smartCollectionYear.trim();

    if (!trimmedName || !hasSmartCollectionRule) {
      return;
    }

    const payload = {
      name: trimmedName,
      query: trimmedQuery,
      year: trimmedYear,
      tags: smartCollectionTagsList,
      favoritesOnly: smartCollectionFavoritesOnly,
      matchMode: smartCollectionMatchMode,
    };

    if (smartCollectionDialog?.mode === "edit" && smartCollectionDialog.collection) {
      onUpdateSmartCollection(smartCollectionDialog.collection.id, payload);
    } else {
      onCreateSmartCollection(payload);
    }

    closeSmartCollectionDialog();
  };

  return (
    <aside className={`bg-zinc-50 dark:bg-zinc-950 border-r border-zinc-200 dark:border-zinc-800 flex flex-col h-full shrink-0 overflow-hidden transition-[width] duration-300 ${isCollapsed ? "w-16" : "w-64"}`}>
      <div className={`h-14 border-b border-zinc-200 dark:border-zinc-800 shrink-0 flex items-center ${isCollapsed ? "px-2 justify-center" : "px-3 justify-between"}`}>
        {!isCollapsed && (
          <div className="flex items-center gap-2">
            <button
              onClick={onOpenSettings}
              className="inline-flex items-center justify-center w-9 h-9 text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98] dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-indigo-300 dark:hover:border-indigo-900/70"
              title={t("folderSidebar.actions.settings")}
            >
              <Settings size={15} />
            </button>
          </div>
        )}
        <button
          onClick={onToggleCollapse}
          className="inline-flex items-center justify-center w-9 h-9 text-zinc-500 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98] dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-indigo-300 dark:hover:border-indigo-900/70"
          title={isCollapsed ? t("folderSidebar.actions.expand") : t("folderSidebar.actions.collapse")}
        >
          {isCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
      </div>

      {isCollapsed ? (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 py-3 flex flex-col items-center gap-2">
            <button
              onClick={() => selectedFolder && onSelectFolder(selectedFolder.id)}
              className={`inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-colors ${selectedFolder ? "border-indigo-200 dark:border-indigo-900/70 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-300" : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-zinc-400 dark:text-zinc-500"}`}
              title={selectedFolder?.name ?? t("folderSidebar.labels.currentFolder")}
            >
              <Folder size={16} />
            </button>

            {selectedTagFilter && (
              <button
                onClick={() => onSelectTag(selectedTagFilter)}
                className="inline-flex items-center justify-center w-10 h-10 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-600 transition-colors dark:border-indigo-900/70 dark:bg-indigo-950/40 dark:text-indigo-300"
                title={t("folderSidebar.tags.activeFilter", { tag: selectedTagFilter })}
              >
                <Hash size={16} />
              </button>
            )}

            <button
              onClick={() => onSelectFolder(FAVORITES_FOLDER_ID)}
              className={`inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-colors ${
                isFavoritesSelected
                  ? "border-amber-200 dark:border-amber-900/70 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-300"
                  : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400"
              }`}
              title={t("folderSidebar.favorites.title")}
            >
              <Star size={16} className={isFavoritesSelected ? "fill-current" : undefined} />
            </button>

            <button
              onClick={onSelectDuplicates}
              className={`inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-colors ${
                isDuplicatesSelected
                  ? "border-sky-200 dark:border-sky-900/70 bg-sky-50 dark:bg-sky-950/30 text-sky-600 dark:text-sky-300"
                  : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400"
              }`}
              title={t("folderSidebar.duplicates.title")}
            >
              <Copy size={16} />
            </button>

            {selectedSmartCollectionId && (
              <button
                onClick={() => onSelectSmartCollection(selectedSmartCollectionId)}
                className="inline-flex items-center justify-center w-10 h-10 rounded-xl border border-cyan-200 bg-cyan-50 text-cyan-600 transition-colors dark:border-cyan-900/70 dark:bg-cyan-950/30 dark:text-cyan-300"
                title={smartCollections.find((collection) => collection.id === selectedSmartCollectionId)?.name ?? t("folderSidebar.smartCollections.title")}
              >
                <Orbit size={16} />
              </button>
            )}

            <button
              onClick={() => onSelectFolder(TRASH_FOLDER_ID)}
              className={`inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-colors ${
                isTrashSelected
                  ? "border-rose-200 dark:border-rose-900/70 bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-300"
                  : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400"
              }`}
              title={t("folderSidebar.labels.trash")}
            >
              <Trash2 size={16} />
            </button>
          </div>

        </>
      ) : (
        <>
          {/* Folder Tree */}
          <div
            className="flex-1 min-h-0 overflow-y-auto px-2 py-2 sidebar-content-enter"
            onMouseLeave={() => {
              if (draggedItemId) {
                onFolderHover(null);
              }
            }}
          >
            {folderTree.map(node => (
              <FolderTreeItem
                key={node.id}
                node={node}
                depth={0}
                rootFolderId={rootFolderId}
                trashCount={trashCount}
                selectedFolderId={selectedFolderId}
                draggedItemId={draggedItemId}
                dragOverFolderId={dragOverFolderId}
                onFolderHover={onFolderHover}
                onSelectFolder={onSelectFolder}
                onDeleteFolder={onDeleteFolder}
                onOpenNewFolderDialog={parentId => { setNewFolderParentId(parentId); setNewFolderName(""); }}
                onOpenContextMenu={(folder, event) => {
                  onSelectFolder(folder.id);
                  setContextMenu({ folder, x: event.clientX, y: event.clientY });
                }}
              />
            ))}
          </div>

          <div className="border-t border-zinc-200 shrink-0 dark:border-zinc-800">
            <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
              <button
                type="button"
                onClick={() => onSelectFolder(FAVORITES_FOLDER_ID)}
                className={`flex flex-1 items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${
                  isFavoritesSelected
                    ? "text-amber-600 dark:text-amber-300"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                <Star size={11} className={isFavoritesSelected ? "fill-current" : undefined} />
                {t("folderSidebar.favorites.title")}
              </button>
              <span className="text-[10px] text-zinc-400 font-medium">{favoriteDocuments.length}</span>
            </div>
            <div className="max-h-44 overflow-y-auto px-3 pb-3">
              {favoriteDocuments.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-3 py-3 text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-500">
                  {t("folderSidebar.favorites.empty")}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {favoriteDocuments.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onOpenFavoriteDocument(item.id)}
                      className="flex w-full items-start gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left transition-colors hover:border-amber-200 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-amber-900/70 dark:hover:bg-zinc-900"
                      title={item.title || item.attachments?.[0]?.name || item.id}
                    >
                      <div className="mt-0.5 rounded-lg bg-amber-50 p-1 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300">
                        <Star size={12} className="fill-current" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">
                          {item.title || item.attachments?.[0]?.name || item.id}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                          {item.authors && item.authors !== "—"
                            ? item.authors
                            : item.publication || item.folder_path || t("folderSidebar.favorites.open")}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-zinc-200 shrink-0 dark:border-zinc-800">
            <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
              <button
                type="button"
                onClick={onSelectDuplicates}
                className={`flex flex-1 items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${
                  isDuplicatesSelected
                    ? "text-sky-600 dark:text-sky-300"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                <Copy size={11} />
                {t("folderSidebar.duplicates.title")}
              </button>
              <span className="text-[10px] text-zinc-400 font-medium">{duplicateGroups.length}</span>
            </div>
            <div className="px-3 pb-3">
              <button
                type="button"
                onClick={onSelectDuplicates}
                className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                  isDuplicatesSelected
                    ? "border-sky-200 bg-sky-50 dark:border-sky-900/70 dark:bg-sky-950/30"
                    : "border-zinc-200 bg-white hover:border-sky-200 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-sky-900/70 dark:hover:bg-zinc-900"
                }`}
              >
                <div className={`mt-0.5 rounded-lg p-1 ${
                  isDuplicatesSelected
                    ? "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-200"
                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
                }`}>
                  <Copy size={12} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-xs font-medium ${
                    isDuplicatesSelected
                      ? "text-sky-800 dark:text-sky-100"
                      : "text-zinc-700 dark:text-zinc-200"
                  }`}>
                    {duplicateGroups.length === 0
                      ? t("folderSidebar.duplicates.empty")
                      : t("folderSidebar.duplicates.summary", {
                          groups: duplicateGroups.length,
                          items: duplicateItemCount,
                        })}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    {duplicateGroups.length === 0
                      ? t("folderSidebar.duplicates.hintEmpty")
                      : t("folderSidebar.duplicates.hint")}
                  </div>
                </div>
              </button>
            </div>
          </div>

          <div className="border-t border-zinc-200 shrink-0 dark:border-zinc-800">
            <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
              <button
                type="button"
                onClick={() => {
                  if (smartCollections[0]) {
                    onSelectSmartCollection(smartCollections[0].id);
                  }
                }}
                className="flex flex-1 items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
              >
                <Orbit size={11} />
                {t("folderSidebar.smartCollections.title")}
              </button>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400 font-medium">{smartCollections.length}</span>
                <button
                  type="button"
                  onClick={() => openSmartCollectionDialog("create")}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 transition-colors hover:border-cyan-200 hover:bg-cyan-50 hover:text-cyan-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-cyan-900/70 dark:hover:bg-cyan-950/30 dark:hover:text-cyan-300"
                  title={t("folderSidebar.smartCollections.create")}
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
            <div className="max-h-52 overflow-y-auto px-3 pb-3">
              {smartCollections.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-3 py-3 text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-500">
                  {t("folderSidebar.smartCollections.empty")}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {smartCollections.map((collection) => {
                    const isActive = selectedSmartCollectionId === collection.id;
                    return (
                      <div
                        key={collection.id}
                        className={`group flex items-start gap-2 rounded-xl border px-3 py-2 transition-colors ${
                          isActive
                            ? "border-cyan-200 bg-cyan-50 dark:border-cyan-900/70 dark:bg-cyan-950/30"
                            : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectSmartCollection(collection.id)}
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                          title={collection.name}
                        >
                          <div className={`mt-0.5 rounded-lg p-1 ${
                            isActive
                              ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-200"
                              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
                          }`}>
                            <Orbit size={12} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className={`truncate text-xs font-medium ${
                              isActive
                                ? "text-cyan-800 dark:text-cyan-100"
                                : "text-zinc-700 dark:text-zinc-200"
                            }`}>
                              {collection.name}
                            </div>
                            <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                              {smartCollectionSummary(collection)}
                            </div>
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openSmartCollectionDialog("edit", collection);
                            }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-cyan-600 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-cyan-300"
                            title={t("folderSidebar.smartCollections.edit")}
                          >
                            <FilePenLine size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteSmartCollection(collection.id);
                            }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                            title={t("folderSidebar.smartCollections.delete")}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {recentDocuments.length > 0 && (
            <div className="border-t border-zinc-200 shrink-0 dark:border-zinc-800">
              <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                  <History size={11} />
                  {t("folderSidebar.recents.title")}
                </div>
                <span className="text-[10px] text-zinc-400 font-medium">{recentDocuments.length}</span>
              </div>
              <div className="max-h-44 overflow-y-auto px-3 pb-3">
                <div className="space-y-1.5">
                  {recentDocuments.map((entry) => (
                    <button
                      key={entry.itemId}
                      type="button"
                      onClick={() => onOpenRecentDocument(entry.itemId)}
                      className="flex w-full items-start gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left transition-colors hover:border-indigo-200 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-indigo-900/70 dark:hover:bg-zinc-900"
                      title={entry.title}
                    >
                      <div className="mt-0.5 rounded-lg bg-zinc-100 p-1 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                        <History size={12} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">
                          {entry.title}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                          {entry.subtitle || t("folderSidebar.recents.resumeAt", { page: entry.lastPage })}
                        </div>
                        <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-indigo-600 dark:text-indigo-300">
                          {t("folderSidebar.recents.resumeAt", { page: entry.lastPage })}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Tags section ──────────────────────────────────────── */}
          {allTags.length > 0 && (
            <div className="border-t border-zinc-200 shrink-0 dark:border-zinc-800">
              {/* Header */}
              <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                  <Hash size={11} />
                  {t("folderSidebar.tags.title")}
                </div>
                <span className="text-[10px] text-zinc-400 font-medium">{allTags.length}</span>
              </div>
              {/* Tag pills */}
              <div className="max-h-40 overflow-y-auto px-3 pb-3">
                <div className="flex flex-wrap gap-1.5">
                {allTags.map(tagInfo => {
                  const isActive = selectedTagFilter === tagInfo.tag;
                  const dotColor = tagInfo.color || DEFAULT_TAG_COLOR;
                  return (
                    <button
                      type="button"
                      key={tagInfo.tag}
                      className={[
                        'group inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                        isActive
                          ? 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/70 dark:bg-indigo-950/40 dark:text-indigo-200'
                          : 'border-zinc-200 bg-white text-zinc-600 hover:border-indigo-200 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-indigo-900/70 dark:hover:bg-zinc-900',
                      ].join(' ')}
                      onClick={() => onSelectTag(tagInfo.tag)}
                      onContextMenu={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setTagColorMenu({ tag: tagInfo.tag, currentColor: dotColor, x: e.clientX, y: e.clientY });
                      }}
                      title={tagInfo.count === 1
                        ? t("folderSidebar.tags.tooltip.one", { tag: tagInfo.tag, count: tagInfo.count })
                        : t("folderSidebar.tags.tooltip.other", { tag: tagInfo.tag, count: tagInfo.count })}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full transition-transform group-hover:scale-110"
                        style={{ backgroundColor: dotColor }}
                      />
                      <span className="truncate">{tagInfo.tag}</span>
                    </button>
                  );
                })}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {contextMenu && (
        <div
          className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-[0_12px_40px_rgba(0,0,0,0.14)] animate-popup dark:border-zinc-800 dark:bg-zinc-950"
          style={{ left: menuX, top: menuY }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setRenameTarget(contextMenu.folder);
              setRenameValue(contextMenu.folder.name);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            <FilePenLine size={15} />
            <span>{t("folderSidebar.context.rename")}</span>
          </button>
          <button
            onClick={async () => {
              const folder = contextMenu.folder;
              setContextMenu(null);
              await onDeleteFolder(folder);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
          >
            <Trash2 size={15} />
            <span>{t("folderSidebar.context.delete")}</span>
          </button>
        </div>
      )}

      {newFolderParentId && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-zinc-900/10 backdrop-blur-[1px] animate-backdrop dark:bg-zinc-950/70"
          onClick={() => { setNewFolderParentId(null); setNewFolderName(""); }}
        >
          <div
            className="w-[calc(100%-24px)] max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)] animate-modal dark:border-zinc-800 dark:bg-zinc-950"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
                <FolderPlus size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("folderSidebar.newDialog.title")}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("folderSidebar.newDialog.description")}</p>
              </div>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={async e => {
                e.preventDefault();
                await submitNewFolder();
              }}
            >
              <div>
                <label className="mb-2 block text-xs font-medium text-zinc-500 dark:text-zinc-400">{t("folderSidebar.newDialog.name")}</label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/15 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-indigo-800 dark:focus-within:bg-zinc-950">
                  <input
                    ref={newFolderInputRef}
                    type="text"
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                    placeholder={t("folderSidebar.newDialog.placeholder")}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setNewFolderParentId(null); setNewFolderName(""); }}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  {t("folderSidebar.newDialog.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!newFolderName.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300 dark:disabled:bg-indigo-900/60"
                >
                  {t("folderSidebar.newDialog.create")}
                </button>
              </div>
            </form>
          </div>
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
            className="w-[calc(100%-24px)] max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)] animate-modal dark:border-zinc-800 dark:bg-zinc-950"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
                <FilePenLine size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("folderSidebar.renameDialog.title")}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("folderSidebar.renameDialog.description")}</p>
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
                <label className="mb-2 block text-xs font-medium text-zinc-500 dark:text-zinc-400">{t("folderSidebar.renameDialog.name")}</label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/15 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-indigo-800 dark:focus-within:bg-zinc-950">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                    placeholder={t("folderSidebar.renameDialog.placeholder")}
                  />
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
                  {t("folderSidebar.renameDialog.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!renameValue.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300 dark:disabled:bg-indigo-900/60"
                >
                  {t("folderSidebar.renameDialog.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {smartCollectionDialog && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-zinc-900/10 backdrop-blur-[1px] animate-backdrop dark:bg-zinc-950/70"
          onClick={closeSmartCollectionDialog}
        >
          <div
            className="w-[calc(100%-24px)] max-w-lg rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)] animate-modal dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-cyan-50 p-2 text-cyan-600 dark:bg-cyan-950/40 dark:text-cyan-300">
                <Orbit size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {smartCollectionDialog.mode === "edit"
                    ? t("folderSidebar.smartCollections.dialog.editTitle")
                    : t("folderSidebar.smartCollections.dialog.createTitle")}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t("folderSidebar.smartCollections.dialog.description")}
                </p>
              </div>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                submitSmartCollection();
              }}
            >
              <div>
                <label className="mb-2 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {t("folderSidebar.smartCollections.dialog.name")}
                </label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-cyan-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-cyan-400/15 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-cyan-800 dark:focus-within:bg-zinc-950">
                  <input
                    ref={smartCollectionNameRef}
                    type="text"
                    value={smartCollectionName}
                    onChange={(event) => setSmartCollectionName(event.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                    placeholder={t("folderSidebar.smartCollections.dialog.namePlaceholder")}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-2 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {t("folderSidebar.smartCollections.dialog.query")}
                  </label>
                  <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-cyan-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-cyan-400/15 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-cyan-800 dark:focus-within:bg-zinc-950">
                    <input
                      type="text"
                      value={smartCollectionQuery}
                      onChange={(event) => setSmartCollectionQuery(event.target.value)}
                      className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                      placeholder={t("folderSidebar.smartCollections.dialog.queryPlaceholder")}
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {t("folderSidebar.smartCollections.dialog.year")}
                  </label>
                  <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-cyan-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-cyan-400/15 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-cyan-800 dark:focus-within:bg-zinc-950">
                    <input
                      type="text"
                      value={smartCollectionYear}
                      onChange={(event) => setSmartCollectionYear(event.target.value.replace(/\D/g, "").slice(0, 4))}
                      className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                      placeholder="2024"
                      maxLength={4}
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {t("folderSidebar.smartCollections.dialog.tags")}
                </label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-cyan-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-cyan-400/15 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-cyan-800 dark:focus-within:bg-zinc-950">
                  <input
                    type="text"
                    value={smartCollectionTags}
                    onChange={(event) => setSmartCollectionTags(event.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                    placeholder={t("folderSidebar.smartCollections.dialog.tagsPlaceholder")}
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/70">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {t("folderSidebar.smartCollections.dialog.matchMode.label")}
                  </label>
                  <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-950">
                    {(["all", "any"] as SmartCollectionMatchMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setSmartCollectionMatchMode(mode)}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                          smartCollectionMatchMode === mode
                            ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-200"
                            : "text-zinc-500 hover:text-cyan-600 dark:text-zinc-400 dark:hover:text-cyan-300"
                        }`}
                      >
                        {t(`folderSidebar.smartCollections.dialog.matchMode.${mode}`)}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-3 text-sm text-zinc-700 dark:text-zinc-200">
                  <input
                    type="checkbox"
                    checked={smartCollectionFavoritesOnly}
                    onChange={(event) => setSmartCollectionFavoritesOnly(event.target.checked)}
                    className="h-4 w-4 rounded border-zinc-300 text-cyan-600 focus:ring-cyan-500/30 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                  <span>{t("folderSidebar.smartCollections.dialog.favoritesOnly")}</span>
                </label>
              </div>

              {!hasSmartCollectionRule && (
                <p className="text-xs text-amber-600 dark:text-amber-300">
                  {t("folderSidebar.smartCollections.dialog.ruleRequired")}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeSmartCollectionDialog}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  {t("folderSidebar.smartCollections.dialog.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!smartCollectionName.trim() || !hasSmartCollectionRule}
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-cyan-300 dark:bg-cyan-700 dark:hover:bg-cyan-600 dark:disabled:bg-cyan-950/60"
                >
                  {smartCollectionDialog.mode === "edit"
                    ? t("folderSidebar.smartCollections.dialog.save")
                    : t("folderSidebar.smartCollections.dialog.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tag color picker (right-click context menu) */}
      {tagColorMenu && (
        <div
          className="fixed z-50 rounded-xl border border-zinc-200 bg-white p-3 shadow-[0_12px_40px_rgba(0,0,0,0.14)] min-w-[160px] animate-popup dark:border-zinc-800 dark:bg-zinc-950"
          style={{
            left: Math.min(tagColorMenu.x, window.innerWidth  - 172),
            top:  Math.min(tagColorMenu.y, window.innerHeight - 100),
          }}
          onClick={e => e.stopPropagation()}
        >
          <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-0.5 dark:text-zinc-400">
            {t("folderSidebar.tags.color")}
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {TAG_COLORS.map(c => (
              <button
                key={c.value}
                title={t(`folderSidebar.colors.${c.label.toLowerCase()}`, undefined, c.label)}
                onClick={async () => {
                  await onSetTagColor(tagColorMenu.tag, c.value);
                  setTagColorMenu(null);
                }}
                className={[
                  'w-7 h-7 rounded-full transition-transform hover:scale-110 border-2',
                  tagColorMenu.currentColor === c.value
                    ? 'border-zinc-800 scale-110'
                    : 'border-transparent',
                ].join(' ')}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function findFolderNode(nodes: FolderNode[], id: string): FolderNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findFolderNode(node.children, id);
    if (child) return child;
  }

  return null;
}

function countFolderItems(node: FolderNode): number {
  return node.items.length + node.children.reduce((sum, child) => sum + countFolderItems(child), 0);
}

/* ── Folder tree item (recursive) ── */
function FolderTreeItem({
  node,
  depth,
  rootFolderId,
  trashCount,
  selectedFolderId,
  draggedItemId,
  dragOverFolderId,
  onFolderHover,
  onSelectFolder,
  onDeleteFolder,
  onOpenNewFolderDialog,
  onOpenContextMenu,
}: {
  node: FolderNode;
  depth: number;
  rootFolderId: string | null;
  trashCount: number;
  selectedFolderId: string;
  draggedItemId: string | null;
  dragOverFolderId: string | null;
  onFolderHover: (folderId: string | null) => void;
  onSelectFolder: (id: string) => void;
  onDeleteFolder: (folder: FolderNode) => Promise<void> | void;
  onOpenNewFolderDialog: (parentId: string) => void;
  onOpenContextMenu: (folder: FolderNode, event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const isSelected = node.id === selectedFolderId;
  const isTrashSelected = selectedFolderId === TRASH_FOLDER_ID;
  const hasChildren = node.children.length > 0;
  const showsTrashChild = node.id === rootFolderId;
  const hasVisibleChildren = hasChildren || showsTrashChild;
  const isDropTarget = Boolean(draggedItemId) && dragOverFolderId === node.id;
  const itemCount = countFolderItems(node);

  useEffect(() => {
    if (isDropTarget && hasVisibleChildren && !open) {
      setOpen(true);
    }
  }, [hasVisibleChildren, isDropTarget, open]);

  return (
    <div>
      <div
        data-folder-drop-id={node.id}
        className={`group flex items-center space-x-1.5 px-2 py-1.5 rounded-md cursor-pointer select-none transition-colors ${
          isDropTarget
            ? "bg-indigo-100 dark:bg-indigo-950/55 text-indigo-700 dark:text-indigo-200 ring-1 ring-indigo-300 dark:ring-indigo-800"
            : isSelected
            ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-200"
            : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900/80"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onMouseEnter={() => {
          if (draggedItemId) {
            onFolderHover(node.id);
          }
        }}
        onMouseMove={() => {
          if (draggedItemId) {
            onFolderHover(node.id);
          }
        }}
        onClick={() => { onSelectFolder(node.id); }}
        onContextMenu={e => {
          if (depth === 0) return;
          e.preventDefault();
          e.stopPropagation();
          onOpenContextMenu(node, e);
        }}
      >
        {/* Chevron toggle */}
        <button
          className={`shrink-0 text-zinc-400 hover:text-zinc-600 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
          style={{ visibility: hasVisibleChildren ? "visible" : "hidden" }}
        >
          <ChevronRight size={13} />
        </button>

        {open && hasVisibleChildren ? (
          <FolderOpen size={14} className="shrink-0 text-indigo-400" />
        ) : (
          <Folder size={14} className={`shrink-0 ${isSelected ? "text-indigo-500 dark:text-indigo-300" : "text-zinc-400 dark:text-zinc-500"}`} />
        )}

        <span className="text-[13px] font-medium flex-1 truncate">{node.name}</span>

        <span className="shrink-0 rounded-full bg-zinc-200/70 px-2 py-0.5 text-[11px] text-zinc-500">
          {itemCount}
        </span>

        {/* Add sub-folder button shown on hover */}
        <button
          className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-indigo-500 transition-opacity shrink-0"
          title={t("folderSidebar.actions.newSubFolder")}
          onClick={e => { e.stopPropagation(); onOpenNewFolderDialog(node.id); }}
        >
          <Plus size={12} />
        </button>
      </div>

      {open && hasVisibleChildren && (
        <div>
          {node.children.map(child => (
            <FolderTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              rootFolderId={rootFolderId}
              trashCount={trashCount}
              selectedFolderId={selectedFolderId}
              draggedItemId={draggedItemId}
              dragOverFolderId={dragOverFolderId}
              onFolderHover={onFolderHover}
              onSelectFolder={onSelectFolder}
              onDeleteFolder={onDeleteFolder}
              onOpenNewFolderDialog={onOpenNewFolderDialog}
              onOpenContextMenu={onOpenContextMenu}
            />
          ))}
          {showsTrashChild && (
            <button
              type="button"
              onClick={() => onSelectFolder(TRASH_FOLDER_ID)}
              className={`group flex w-full items-center space-x-1.5 rounded-md px-2 py-1.5 transition-colors ${
                isTrashSelected
                  ? "bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-200"
                  : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900/80"
              }`}
              style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            >
              <div className="w-[13px] shrink-0" />
              <Trash2 size={14} className={`shrink-0 ${isTrashSelected ? "text-rose-500" : "text-zinc-400"}`} />
              <span className="flex-1 truncate text-left text-[13px] font-medium">{t("folderSidebar.labels.trash")}</span>
              <span className="shrink-0 rounded-full bg-zinc-200/70 px-2 py-0.5 text-[11px] text-zinc-500">
                {trashCount}
              </span>
              <span className="w-3 shrink-0 opacity-0" aria-hidden="true">
                +
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
