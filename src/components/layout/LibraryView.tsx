import { useEffect, useRef, useState } from "react";
import { FilePenLine, FileText, FileUp, Search, Trash2 } from "lucide-react";
import { FolderNode, LibraryItem } from "../../types";

interface LibraryViewProps {
  folderTree: FolderNode[];
  selectedFolderId: string;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onOpenItem: (item: LibraryItem) => void;
  onAddItem: () => void;
  onDeleteItem: (item: LibraryItem) => void;
  onRenameItem: (item: LibraryItem, nextName: string) => Promise<void> | void;
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
}: LibraryViewProps) {
  const [query, setQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    item: LibraryItem;
    x: number;
    y: number;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<LibraryItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  const rootFolder = folderTree[0] ?? null;
  const selectedFolder = findFolderById(folderTree, selectedFolderId);

  const folderItems = selectedFolder
    ? rootFolder && selectedFolder.id === rootFolder.id
      ? collectAllItems(selectedFolder)
      : selectedFolder.items
    : [];

  const filteredItems = query.trim()
    ? folderItems.filter(p =>
        (p.attachments[0]?.name?.toLowerCase() || "").includes(query.toLowerCase()) ||
        p.title?.toLowerCase().includes(query.toLowerCase()) ||
        p.authors?.toLowerCase().includes(query.toLowerCase()) ||
        p.doi?.toLowerCase().includes(query.toLowerCase()) ||
        p.arxiv_id?.toLowerCase().includes(query.toLowerCase())
      )
    : folderItems;

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

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 184) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 56) : 0;

  const submitRename = async () => {
    if (!renameTarget) return;

    const trimmedName = renameValue.trim();
    if (!trimmedName) return;

    await onRenameItem(renameTarget, trimmedName);
    setRenameTarget(null);
    setRenameValue("");
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full bg-white relative">
      {/* Search Header */}
      <div className="h-14 border-b border-zinc-200 flex items-center gap-3 px-6 shrink-0 bg-white/80 backdrop-blur-md sticky top-0 z-10 min-w-0">
        <div className="relative min-w-0 flex-1 max-w-2xl">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={16} />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by title, author, DOI, or arXiv ID..."
            className="w-full pl-10 pr-4 py-2 bg-zinc-100 border-transparent focus:bg-white border focus:border-indigo-400 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-400/20 transition-all placeholder:text-zinc-400 shadow-sm"
          />
        </div>
        <button
          onClick={onAddItem}
          className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2 text-sm font-medium text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98]"
        >
          <FileUp size={15} />
          <span>Add Library Item</span>
        </button>
      </div>

      {/* Item List */}
      <div className="flex-1 overflow-y-auto p-6">
        {filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-zinc-400 space-y-4 mt-10">
            <div className="w-16 h-16 bg-zinc-50 rounded-2xl flex items-center justify-center border border-zinc-200/60 shadow-sm">
              <FileText size={32} className="opacity-40" />
            </div>
            <p className="text-sm">No items in this folder</p>
            <p className="text-xs text-zinc-400">Use the Add Library Item button above to add a paper.</p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
            {filteredItems.map(item => (
              <LibraryItemRow
                key={item.id}
                item={item}
                isSelected={selectedItemId === item.id}
                onSelect={() => onSelectItem(item.id)}
                onOpen={() => onOpenItem(item)}
                onContextMenu={event => {
                  onSelectItem(item.id);
                  setContextMenu({
                    item,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              />
            ))}
          </div>
        )}
      </div>

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
    </div>
  );
}

function formatAuthorsForList(authors: string) {
  if (authors === "—") {
    return "Unknown Author";
  }

  const parts = authors
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length <= 3) {
    return authors;
  }

  return `${parts.slice(0, 3).join(", ")}, etc.`;
}

function LibraryItemRow({
  item,
  isSelected,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  item: LibraryItem;
  isSelected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors select-none ${
        isSelected
          ? "bg-indigo-50"
          : "bg-white hover:bg-zinc-50"
      }`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={e => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
      title="Double-click to open"
    >
      <div className={`p-2 rounded-lg shrink-0 ${isSelected ? "bg-indigo-100 text-indigo-600" : "bg-zinc-100 text-zinc-500 group-hover:text-indigo-500 transition-colors"}`}>
        <FileText size={16} />
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-zinc-800 truncate group-hover:text-indigo-900 transition-colors">
          {item.title || item.attachments[0]?.name || "Untitled"}
        </h3>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500 min-w-0">
          <span className="truncate">
            {formatAuthorsForList(item.authors)}
          </span>
          <span className="text-zinc-300">•</span>
          <span className="shrink-0 text-zinc-400">
            {item.year !== "—" ? item.year : "No Year"}
          </span>
        </div>
      </div>
    </div>
  );
}
