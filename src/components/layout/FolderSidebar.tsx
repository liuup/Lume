import { useEffect, useRef, useState } from "react";
import { ChevronRight, FilePenLine, Folder, FolderOpen, FolderPlus, Plus } from "lucide-react";
import { FolderNode } from "../../App";

interface FolderSidebarProps {
  folderTree: FolderNode[];
  selectedFolderId: string;
  onSelectFolder: (id: string) => void;
  onAddFolder: (parentId: string, name: string) => Promise<void>;
  onRenameFolder: (folder: FolderNode, nextName: string) => Promise<void> | void;
}

export function FolderSidebar({
  folderTree,
  selectedFolderId,
  onSelectFolder,
  onAddFolder,
  onRenameFolder,
}: FolderSidebarProps) {
  const [contextMenu, setContextMenu] = useState<{
    folder: FolderNode;
    x: number;
    y: number;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<FolderNode | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const newFolderInputRef = useRef<HTMLInputElement>(null);

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

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 184) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 56) : 0;

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

  return (
    <aside className="w-64 bg-zinc-50 border-r border-zinc-200 flex flex-col h-full shrink-0">
      <div className="h-14 px-4 border-b border-zinc-200 shrink-0 flex items-center">
        <button
          onClick={() => { setNewFolderParentId(selectedFolderId); setNewFolderName(""); }}
          className="inline-flex items-center justify-center w-9 h-9 text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98]"
          title="New Folder"
        >
          <FolderPlus size={15} />
        </button>
      </div>

      {/* Folder Tree */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {folderTree.map(node => (
          <FolderTreeItem
            key={node.id}
            node={node}
            depth={0}
            selectedFolderId={selectedFolderId}
            onSelectFolder={onSelectFolder}
            onOpenNewFolderDialog={parentId => { setNewFolderParentId(parentId); setNewFolderName(""); }}
            onOpenContextMenu={(folder, event) => {
              onSelectFolder(folder.id);
              setContextMenu({ folder, x: event.clientX, y: event.clientY });
            }}
          />
        ))}
      </div>

      {contextMenu && (
        <div
          className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-[0_12px_40px_rgba(0,0,0,0.14)]"
          style={{ left: menuX, top: menuY }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setRenameTarget(contextMenu.folder);
              setRenameValue(contextMenu.folder.name);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
          >
            <FilePenLine size={15} />
            <span>Rename Folder</span>
          </button>
        </div>
      )}

      {newFolderParentId && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-zinc-900/10 backdrop-blur-[1px]"
          onClick={() => { setNewFolderParentId(null); setNewFolderName(""); }}
        >
          <div
            className="w-[calc(100%-24px)] max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600">
                <FolderPlus size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">New Folder</h3>
                <p className="text-xs text-zinc-500">Create a new folder in your library.</p>
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
                <label className="mb-2 block text-xs font-medium text-zinc-500">Folder name</label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/15">
                  <input
                    ref={newFolderInputRef}
                    type="text"
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none"
                    placeholder="Enter folder name"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setNewFolderParentId(null); setNewFolderName(""); }}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!newFolderName.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
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
            className="w-[calc(100%-24px)] max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600">
                <FilePenLine size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">Rename Folder</h3>
                <p className="text-xs text-zinc-500">Edit the folder name in your library.</p>
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
                <label className="mb-2 block text-xs font-medium text-zinc-500">Folder name</label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/15">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none"
                    placeholder="Enter folder name"
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
    </aside>
  );
}

/* ── Folder tree item (recursive) ── */
function FolderTreeItem({
  node,
  depth,
  selectedFolderId,
  onSelectFolder,
  onOpenNewFolderDialog,
  onOpenContextMenu,
}: {
  node: FolderNode;
  depth: number;
  selectedFolderId: string;
  onSelectFolder: (id: string) => void;
  onOpenNewFolderDialog: (parentId: string) => void;
  onOpenContextMenu: (folder: FolderNode, event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const [open, setOpen] = useState(true);
  const isSelected = node.id === selectedFolderId;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={`group flex items-center space-x-1.5 px-2 py-1.5 rounded-md cursor-pointer select-none transition-colors ${
          isSelected
            ? "bg-indigo-50 text-indigo-700"
            : "text-zinc-600 hover:bg-zinc-100"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
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
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
        >
          <ChevronRight size={13} />
        </button>

        {open && hasChildren ? (
          <FolderOpen size={14} className="shrink-0 text-indigo-400" />
        ) : (
          <Folder size={14} className={`shrink-0 ${isSelected ? "text-indigo-500" : "text-zinc-400"}`} />
        )}

        <span className="text-[13px] font-medium flex-1 truncate">{node.name}</span>

        {/* Add sub-folder button shown on hover */}
        <button
          className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-indigo-500 transition-opacity shrink-0"
          title="New sub-folder"
          onClick={e => { e.stopPropagation(); onOpenNewFolderDialog(node.id); }}
        >
          <Plus size={12} />
        </button>
      </div>

      {open && hasChildren && (
        <div>
          {node.children.map(child => (
            <FolderTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              onSelectFolder={onSelectFolder}
              onOpenNewFolderDialog={onOpenNewFolderDialog}
              onOpenContextMenu={onOpenContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}