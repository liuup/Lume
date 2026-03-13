import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, FilePenLine, FileText, FileUp, Globe, Hash, Loader2, Search, Trash2 } from "lucide-react";
import { FolderNode, LibraryItem } from "../../types";
import { ExportModal } from "./ExportModal";
import { useI18n } from "../../hooks/useI18n";

// ─── Search field types ──────────────────────────────────────────────────────

type SearchField = "all" | "title" | "authors" | "year" | "doi" | "arxiv";

const SEARCH_FIELDS: SearchField[] = ["all", "title", "authors", "year", "doi", "arxiv"];

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

interface LibraryViewProps {
  folderTree: FolderNode[];
  selectedFolderId: string;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onOpenItem: (item: LibraryItem) => void;
  onAddItem: () => void;
  onDeleteItem: (item: LibraryItem) => void;
  onRenameItem: (item: LibraryItem, nextName: string) => Promise<void> | void;
  onUpdateItemTags: (item: LibraryItem, tags: string[]) => Promise<void> | void;
  onItemPointerDown: (item: LibraryItem, event: React.MouseEvent<HTMLDivElement>) => void;
  /** Sidebar tag filter (null = no filter active). */
  tagFilter: string | null;
  onClearTagFilter: () => void;
}

export function LibraryView({
  folderTree,
  selectedFolderId,
  selectedItemId,
  onSelectItem,
  onOpenItem,
  onAddItem,
  onDeleteItem,
  onRenameItem,
  onUpdateItemTags,
  onItemPointerDown,
  tagFilter,
  onClearTagFilter,
}: LibraryViewProps) {
  const { t } = useI18n();
  // Search state
  const [query, setQuery]             = useState("");
  const [searchField, setSearchField] = useState<SearchField>("all");
  const [yearFilter, setYearFilter]   = useState("");
  const [globalResults, setGlobalResults] = useState<LibraryItem[]>([]);
  const [isSearching, setIsSearching]     = useState(false);

  // UI state
  const [contextMenu, setContextMenu] = useState<{ item: LibraryItem; x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<LibraryItem | null>(null);
  const [renameValue, setRenameValue]   = useState("");  const [showExport, setShowExport] = useState(false);  const renameInputRef = useRef<HTMLInputElement>(null);
  const [tagEditorTarget, setTagEditorTarget] = useState<LibraryItem | null>(null);
  const [tagEditorValue, setTagEditorValue] = useState("");
  const [tagEditorTags, setTagEditorTags] = useState<string[]>([]);
  const debounceRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const folderItems: LibraryItem[] = selectedFolder
    ? rootFolder && selectedFolder.id === rootFolder.id
      ? collectAllItems(selectedFolder)
      : selectedFolder.items
    : [];

  // ── Global search via Tauri backend ─────────────────────────────────────

  const isGlobalSearch = query.trim().length > 0 || yearFilter.trim().length > 0 || !!tagFilter;

  const runGlobalSearch = useCallback(
    (q: string, field: SearchField, year: string, sidebarTag: string | null) => {
      if (!q.trim() && !year.trim() && !sidebarTag) {
        setGlobalResults([]);
        setIsSearching(false);
        return;
      }
      setIsSearching(true);
      const tagFilters = sidebarTag ? [sidebarTag] : [];
      invoke<LibraryItem[]>("search_library", {
        params: { query: q.trim(), field, year_filter: year.trim() || null, tag_filters: tagFilters },
      })
        .then(results => { setGlobalResults(results); setIsSearching(false); })
        .catch(err   => { console.error("search_library error:", err); setIsSearching(false); });
    },
    []
  );

  // Debounced search trigger — re-runs on any filter change, including sidebar tag
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runGlobalSearch(query, searchField, yearFilter, tagFilter), 280);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, searchField, yearFilter, tagFilter, runGlobalSearch]);

  // Clear results when all inputs are empty
  useEffect(() => {
    if (!query.trim() && !yearFilter.trim() && !tagFilter) setGlobalResults([]);
  }, [query, yearFilter, tagFilter]);

  const displayItems = isGlobalSearch ? globalResults : folderItems;

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

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth  - 184) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 56)  : 0;

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

  const folderLabel = selectedFolder?.name ?? t("libraryView.myLibrary");
  const resultCountLabel = displayItems.length === 1
    ? t("libraryView.scope.results.one", { count: displayItems.length })
    : t("libraryView.scope.results.other", { count: displayItems.length });
  const paperCountLabel = folderItems.length === 1
    ? t("libraryView.scope.papers.one", { count: folderItems.length })
    : t("libraryView.scope.papers.other", { count: folderItems.length });
  const exportScopeLabel = isGlobalSearch
    ? (displayItems.length === 1
      ? t("libraryView.export.searchScope.one", { count: displayItems.length })
      : t("libraryView.export.searchScope.other", { count: displayItems.length }))
    : (displayItems.length === 1
      ? t("libraryView.export.folderScope.one", { count: displayItems.length, folder: folderLabel })
      : t("libraryView.export.folderScope.other", { count: displayItems.length, folder: folderLabel }));

  const searchPlaceholder =
    searchField === "title"   ? t("libraryView.search.placeholder.title") :
    searchField === "authors" ? t("libraryView.search.placeholder.authors") :
    searchField === "year"    ? t("libraryView.search.placeholder.year") :
    searchField === "doi"     ? t("libraryView.search.placeholder.doi") :
    searchField === "arxiv"   ? t("libraryView.search.placeholder.arxiv") :
                                  t("libraryView.search.placeholder.all");

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full bg-white relative">

      {/* ── Search header ───────────────────────────────────── */}
      <div className="border-b border-zinc-200 flex flex-col shrink-0 bg-white/80 backdrop-blur-md sticky top-0 z-10 min-w-0">

        {/* Row 1 – search input + add button */}
        <div className="h-14 flex items-center gap-3 px-6">
          <div className="relative min-w-0 flex-1 max-w-2xl">
            {isSearching
              ? <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 text-indigo-400 animate-spin" size={16} />
              : <Search  className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={16} />
            }
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full pl-10 pr-4 py-2 bg-zinc-100 border-transparent focus:bg-white border focus:border-indigo-400 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-400/20 transition-all placeholder:text-zinc-400 shadow-sm"
            />
          </div>
          <button
            onClick={() => setShowExport(true)}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98]"
            title={t("libraryView.actions.exportTitle")}
          >
            <Download size={15} />
            <span>{t("libraryView.actions.export")}</span>
          </button>
          <button
            onClick={onAddItem}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98]"
          >
            <FileUp size={15} />
            <span>{t("libraryView.actions.addItem")}</span>
          </button>
        </div>

        {/* Row 2 – field filter pills + year input + scope indicator */}
        <div className="flex items-center gap-2 px-6 pb-3 flex-wrap min-w-0">
          {SEARCH_FIELDS.map(fieldId => (
            <button
              key={fieldId}
              onClick={() => setSearchField(fieldId)}
              className={[
                "px-3 py-1 rounded-full text-xs font-medium transition-colors border whitespace-nowrap",
                searchField === fieldId
                  ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                  : "bg-white text-zinc-500 border-zinc-200 hover:border-indigo-300 hover:text-indigo-600",
              ].join(" ")}
            >
              {t(`libraryView.search.fields.${fieldId}`)}
            </button>
          ))}

          {/* Year filter */}
          <div className="flex items-center gap-1.5 ml-1">
            <span className="text-xs text-zinc-400">{t("libraryView.search.yearLabel")}</span>
            <input
              type="text"
              value={yearFilter}
              onChange={e => setYearFilter(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="2024"
              maxLength={4}
              className="w-16 px-2 py-1 bg-zinc-100 border border-transparent focus:bg-white focus:border-indigo-400 rounded-lg text-xs outline-none focus:ring-2 focus:ring-indigo-400/20 transition-all placeholder:text-zinc-400"
            />
          </div>

          {/* Active sidebar tag chip */}
          {tagFilter && (
            <div className="flex items-center gap-1.5 ml-1 px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium border border-indigo-200">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
              <span>#{tagFilter}</span>
              <button
                onClick={onClearTagFilter}
                className="ml-0.5 text-indigo-400 hover:text-indigo-700 transition-colors leading-none"
                title={t("libraryView.search.clearTag")}
              >
                ×
              </button>
            </div>
          )}

          {/* Right-aligned scope indicator */}
          <div className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400 shrink-0">
            {isGlobalSearch ? (
              <>
                <Globe size={13} className="text-indigo-400 shrink-0" />
                <span className="text-indigo-500 font-medium">
                  {isSearching
                    ? t("libraryView.scope.searching")
                    : resultCountLabel}
                </span>
              </>
            ) : (
              <span>
                {paperCountLabel}{" "}
                <strong className="text-zinc-600">{folderLabel}</strong>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Item list ───────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {displayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-zinc-400 space-y-4 mt-10 px-6">
            <div className="w-16 h-16 bg-zinc-50 rounded-2xl flex items-center justify-center border border-zinc-200/60 shadow-sm">
              <FileText size={32} className="opacity-40" />
            </div>
            {isGlobalSearch ? (
              <p className="text-sm">{isSearching ? t("libraryView.empty.searching") : t("libraryView.empty.noResults")}</p>
            ) : (
              <>
                <p className="text-sm">{t("libraryView.empty.noItems")}</p>
                <p className="text-xs text-zinc-400">{t("libraryView.empty.hint")}</p>
              </>
            )}
          </div>
        ) : (
          <div className="divide-y divide-zinc-200 border-b border-zinc-200 bg-white">
            {displayItems.map(item => (
              <LibraryItemRow
                key={item.id}
                item={item}
                isSelected={selectedItemId === item.id}
                highlight={isGlobalSearch ? query : ""}
                onSelect={() => onSelectItem(item.id)}
                onOpen={() => onOpenItem(item)}
                onPointerDown={event => onItemPointerDown(item, event)}
                onContextMenu={event => {
                  onSelectItem(item.id);
                  setContextMenu({ item, x: event.clientX, y: event.clientY });
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Context menu ────────────────────────────────────── */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-[0_12px_40px_rgba(0,0,0,0.14)]"
          style={{ left: menuX, top: menuY }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setRenameTarget(contextMenu.item);
              setRenameValue(contextMenu.item.title || contextMenu.item.attachments[0]?.name || t("libraryView.item.untitled"));
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
          >
            <FilePenLine size={15} />
            <span>{t("libraryView.context.rename")}</span>
          </button>
          <button
            onClick={() => {
              setTagEditorTarget(contextMenu.item);
              setTagEditorTags(contextMenu.item.tags ?? []);
              setTagEditorValue("");
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
          >
            <Hash size={15} />
            <span>{t("libraryView.context.editTags", undefined, "Edit Tags")}</span>
          </button>
          <button
            onClick={() => {
              onDeleteItem(contextMenu.item);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
          >
            <Trash2 size={15} />
            <span>{t("libraryView.context.delete")}</span>
          </button>
        </div>
      )}

      {renameTarget && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-zinc-900/10 backdrop-blur-[1px]"
          onClick={() => {
            setRenameTarget(null);
            setRenameValue("");
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600">
                <FilePenLine size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">{t("libraryView.renameDialog.title")}</h3>
                <p className="text-xs text-zinc-500">{t("libraryView.renameDialog.description")}</p>
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
                <label className="mb-2 block text-xs font-medium text-zinc-500">{t("libraryView.renameDialog.fileName")}</label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/15">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none"
                    placeholder={t("libraryView.renameDialog.placeholder")}
                  />
                  <span className="shrink-0 text-sm text-zinc-400">.pdf</span>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRenameTarget(null);
                    setRenameValue("");
                  }}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
                >
                  {t("libraryView.renameDialog.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!renameValue.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
                >
                  {t("libraryView.renameDialog.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {tagEditorTarget && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-zinc-900/10 backdrop-blur-[1px]"
          onClick={() => {
            setTagEditorTarget(null);
            setTagEditorTags([]);
            setTagEditorValue("");
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600">
                <Hash size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">{t("libraryView.tagDialog.title", undefined, "Edit Item Tags")}</h3>
                <p className="text-xs text-zinc-500">{t("libraryView.tagDialog.description", undefined, "Add custom tags for this PDF item.")}</p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <div
                className="flex flex-wrap gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 min-h-[44px]"
                onClick={() => {
                  const input = document.getElementById("library-tag-editor-input") as HTMLInputElement | null;
                  input?.focus();
                }}
              >
                {tagEditorTags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-600">
                    {tag}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTag(tag);
                      }}
                      className="leading-none text-indigo-400 hover:text-indigo-700"
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
                  className="min-w-[140px] flex-1 bg-transparent text-sm text-zinc-700 outline-none placeholder:text-zinc-400"
                />
              </div>
              <p className="text-[11px] text-zinc-400">{t("libraryView.tagDialog.help", undefined, "Press Enter or comma to add a tag.")}</p>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setTagEditorTarget(null);
                  setTagEditorTags([]);
                  setTagEditorValue("");
                }}
                className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
              >
                {t("libraryView.tagDialog.cancel", undefined, "Cancel")}
              </button>
              <button
                type="button"
                onClick={submitTags}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
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
      isOpen={showExport}
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
  onSelect,
  onOpen,
  onPointerDown,
  onContextMenu,
}: {
  item: LibraryItem;
  isSelected: boolean;
  highlight: string;
  onSelect: () => void;
  onOpen: () => void;
  onPointerDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const displayTitle = item.title || item.attachments[0]?.name || t("libraryView.item.untitled");

  return (
    <div
      className={`library-item-row group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors select-none ${
        isSelected ? "bg-indigo-50" : "bg-white hover:bg-zinc-50"
      }`}
      data-selected={isSelected ? "true" : "false"}
      style={{ cursor: "grab" }}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onMouseDown={onPointerDown}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu(e); }}
      title={t("libraryView.item.openHint")}
    >
      <div className={`p-1.5 rounded-lg shrink-0 ${
        isSelected ? "bg-indigo-100 text-indigo-600" : "bg-zinc-100 text-zinc-500 group-hover:text-indigo-500 transition-colors"
      }`}>
        <FileText size={14} />
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="library-item-title text-sm font-semibold text-zinc-800 truncate group-hover:text-indigo-900 transition-colors">
          {highlight ? highlightText(displayTitle, highlight) : displayTitle}
        </h3>
      </div>
    </div>
  );
}
