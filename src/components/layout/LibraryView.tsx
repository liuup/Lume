import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, FilePenLine, FileText, FileUp, Globe, Loader2, Search, Trash2 } from "lucide-react";
import { FolderNode, LibraryItem } from "../../types";
import { ExportModal } from "./ExportModal";

// ─── Search field types ──────────────────────────────────────────────────────

type SearchField = "all" | "title" | "authors" | "year" | "doi" | "arxiv";

const FIELD_LABELS: { id: SearchField; label: string }[] = [
  { id: "all",     label: "All Fields" },
  { id: "title",   label: "Title" },
  { id: "authors", label: "Authors" },
  { id: "year",    label: "Year" },
  { id: "doi",     label: "DOI" },
  { id: "arxiv",   label: "arXiv" },
];

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
  tagFilter,
  onClearTagFilter,
}: LibraryViewProps) {
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

  const folderLabel = selectedFolder?.name ?? "My Library";

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
              placeholder={
                searchField === "title"   ? "Search by title..." :
                searchField === "authors" ? "Search by author..." :
                searchField === "year"    ? "Search by year, e.g. 2024..." :
                searchField === "doi"     ? "Search by DOI..." :
                searchField === "arxiv"   ? "Search by arXiv ID..." :
                                            "Search across all fields..."
              }
              className="w-full pl-10 pr-4 py-2 bg-zinc-100 border-transparent focus:bg-white border focus:border-indigo-400 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-400/20 transition-all placeholder:text-zinc-400 shadow-sm"
            />
          </div>
          <button
            onClick={() => setShowExport(true)}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98]"
            title="Export references"
          >
            <Download size={15} />
            <span>Export</span>
          </button>
          <button
            onClick={onAddItem}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98]"
          >
            <FileUp size={15} />
            <span>Add Library Item</span>
          </button>
        </div>

        {/* Row 2 – field filter pills + year input + scope indicator */}
        <div className="flex items-center gap-2 px-6 pb-3 flex-wrap min-w-0">
          {FIELD_LABELS.map(f => (
            <button
              key={f.id}
              onClick={() => setSearchField(f.id)}
              className={[
                "px-3 py-1 rounded-full text-xs font-medium transition-colors border whitespace-nowrap",
                searchField === f.id
                  ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                  : "bg-white text-zinc-500 border-zinc-200 hover:border-indigo-300 hover:text-indigo-600",
              ].join(" ")}
            >
              {f.label}
            </button>
          ))}

          {/* Year filter */}
          <div className="flex items-center gap-1.5 ml-1">
            <span className="text-xs text-zinc-400">Year:</span>
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
                title="Clear tag filter"
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
                    ? "Searching entire library…"
                    : `${displayItems.length} result${displayItems.length !== 1 ? "s" : ""} across all library`}
                </span>
              </>
            ) : (
              <span>
                {folderItems.length} paper{folderItems.length !== 1 ? "s" : ""} in{" "}
                <strong className="text-zinc-600">{folderLabel}</strong>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Item list ───────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6">
        {displayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-zinc-400 space-y-4 mt-10">
            <div className="w-16 h-16 bg-zinc-50 rounded-2xl flex items-center justify-center border border-zinc-200/60 shadow-sm">
              <FileText size={32} className="opacity-40" />
            </div>
            {isGlobalSearch ? (
              <p className="text-sm">{isSearching ? "Searching…" : "No results found"}</p>
            ) : (
              <>
                <p className="text-sm">No items in this folder</p>
                <p className="text-xs text-zinc-400">Use the Add Library Item button above to add a paper.</p>
              </>
            )}
          </div>
        ) : (
          <div className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
            {displayItems.map(item => (
              <LibraryItemRow
                key={item.id}
                item={item}
                isSelected={selectedItemId === item.id}
                highlight={isGlobalSearch ? query : ""}
                showFolderPath={isGlobalSearch}
                onSelect={() => onSelectItem(item.id)}
                onOpen={() => onOpenItem(item)}
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
              setRenameValue(contextMenu.item.title || contextMenu.item.attachments[0]?.name || "Untitled");
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
          >
            <FilePenLine size={15} />
            <span>Rename Item</span>
          </button>
          <button
            onClick={() => {
              onDeleteItem(contextMenu.item);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
          >
            <Trash2 size={15} />
            <span>Delete Item</span>
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
                <h3 className="text-sm font-semibold text-zinc-900">Rename PDF</h3>
                <p className="text-xs text-zinc-500">Edit the file name stored in your library.</p>
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
                <label className="mb-2 block text-xs font-medium text-zinc-500">File name</label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/15">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none"
                    placeholder="Enter PDF name"
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
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!renameValue.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    {/* Export modal — uses fixed positioning, renders correctly inside any container */}
    <ExportModal
      items={displayItems}
      isOpen={showExport}
      onClose={() => setShowExport(false)}
      scopeLabel={
        isGlobalSearch
          ? `${displayItems.length} item${displayItems.length !== 1 ? "s" : ""} from search results`
          : `${displayItems.length} item${displayItems.length !== 1 ? "s" : ""} in ${folderLabel}`
      }
    />
  </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatAuthorsForList(authors: string): string {
  if (authors === "—") return "Unknown Author";
  const parts = authors.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length <= 3) return authors;
  return `${parts.slice(0, 3).join(", ")}, etc.`;
}

/** Derive a display-friendly folder label from a filesystem item id */
function folderPathLabel(itemId: string): string {
  const segments = itemId.split("/");
  const libIdx   = segments.findIndex(s => s === "library");
  if (libIdx !== -1) {
    const relative = segments.slice(libIdx + 1, -1);
    return relative.length > 0 ? relative.join(" / ") : "My Library";
  }
  return segments.length > 2 ? segments[segments.length - 2] : "My Library";
}

// ─── LibraryItemRow ──────────────────────────────────────────────────────────

function LibraryItemRow({
  item,
  isSelected,
  highlight,
  showFolderPath,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  item: LibraryItem;
  isSelected: boolean;
  highlight: string;
  showFolderPath: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const displayTitle   = item.title || item.attachments[0]?.name || "Untitled";
  const displayAuthors = formatAuthorsForList(item.authors);

  return (
    <div
      className={`library-item-row group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors select-none ${
        isSelected ? "bg-indigo-50" : "bg-white hover:bg-zinc-50"
      }`}
      data-selected={isSelected ? "true" : "false"}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu(e); }}
      title="Double-click to open"
    >
      <div className={`p-2 rounded-lg shrink-0 ${
        isSelected ? "bg-indigo-100 text-indigo-600" : "bg-zinc-100 text-zinc-500 group-hover:text-indigo-500 transition-colors"
      }`}>
        <FileText size={16} />
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="library-item-title text-sm font-semibold text-zinc-800 truncate group-hover:text-indigo-900 transition-colors">
          {highlight ? highlightText(displayTitle, highlight) : displayTitle}
        </h3>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500 min-w-0 flex-wrap">
          <span className="truncate">
            {highlight ? highlightText(displayAuthors, highlight) : displayAuthors}
          </span>
          <span className="text-zinc-300">•</span>
          <span className="shrink-0 text-zinc-400">
            {item.year !== "—" ? item.year : "No Year"}
          </span>
          {item.tags && item.tags.length > 0 && (
            <>
              <span className="text-zinc-300">•</span>
              <div className="flex items-center gap-1 flex-wrap">
                {item.tags.slice(0, 3).map(tag => (
                  <span key={tag} className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-medium border border-indigo-100">
                    {tag}
                  </span>
                ))}
                {item.tags.length > 3 && (
                  <span className="text-zinc-400 text-[10px]">+{item.tags.length - 3}</span>
                )}
              </div>
            </>
          )}
        </div>
        {showFolderPath && (
          <div className="mt-0.5 text-[10px] text-zinc-400 truncate">
            📁 {folderPathLabel(item.id)}
          </div>
        )}
      </div>
    </div>
  );
}
