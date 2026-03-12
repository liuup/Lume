import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FilePenLine, Folder, FolderOpen, FolderPlus, Hash, Plus, Settings, Trash2 } from "lucide-react";
import { FolderNode, TagInfo } from "../../types";
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
  onAddFolder: (parentId: string, name: string) => Promise<void>;
  onRenameFolder: (folder: FolderNode, nextName: string) => Promise<void> | void;
  onDeleteFolder: (folder: FolderNode) => Promise<void> | void;
  draggedItemId: string | null;
  dragOverFolderId: string | null;
  onFolderHover: (folderId: string | null) => void;
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
  onAddFolder,
  onRenameFolder,
  onDeleteFolder,
  draggedItemId,
  dragOverFolderId,
  onFolderHover,
  allTags,
  selectedTagFilter,
  onSelectTag,
  onSetTagColor,
  onOpenSettings
}: FolderSidebarProps) {
  const { t } = useI18n();
  const selectedFolder = findFolderNode(folderTree, selectedFolderId);
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

  return (
    <aside className={`bg-zinc-50 border-r border-zinc-200 flex flex-col h-full shrink-0 overflow-hidden transition-[width] duration-300 ${isCollapsed ? "w-16" : "w-64"}`}>
      <div className={`h-14 border-b border-zinc-200 shrink-0 flex items-center ${isCollapsed ? "px-2 justify-center gap-2" : "px-4 justify-between"}`}>
        <button
          onClick={() => { setNewFolderParentId(selectedFolderId); setNewFolderName(""); }}
          className="inline-flex items-center justify-center w-9 h-9 text-zinc-600 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98]"
          title={t("folderSidebar.actions.newFolder")}
        >
          <FolderPlus size={15} />
        </button>
        <button
          onClick={onToggleCollapse}
          className="inline-flex items-center justify-center w-9 h-9 text-zinc-500 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors shadow-sm active:scale-[0.98]"
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
              className={`inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-colors ${selectedFolder ? "border-indigo-200 bg-indigo-50 text-indigo-600" : "border-zinc-200 bg-white text-zinc-400"}`}
              title={selectedFolder?.name ?? t("folderSidebar.labels.currentFolder")}
            >
              <Folder size={16} />
            </button>

            {selectedTagFilter && (
              <button
                onClick={() => onSelectTag(selectedTagFilter)}
                className="inline-flex items-center justify-center w-10 h-10 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-600 transition-colors"
                title={t("folderSidebar.tags.activeFilter", { tag: selectedTagFilter })}
              >
                <Hash size={16} />
              </button>
            )}
          </div>

          <div className="border-t border-zinc-200 shrink-0 p-2 flex justify-center">
            <button
              onClick={onOpenSettings}
              className="flex items-center justify-center w-10 h-10 text-zinc-600 rounded-xl hover:bg-zinc-100 transition-colors"
              title={t("folderSidebar.actions.settings")}
            >
              <Settings size={16} className="text-zinc-400" />
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Folder Tree */}
          <div
            className="flex-1 min-h-0 overflow-y-auto px-2 py-2"
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

          {/* ── Tags section ──────────────────────────────────────── */}
          {allTags.length > 0 && (
            <div className="border-t border-zinc-200 shrink-0">
              {/* Header */}
              <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                  <Hash size={11} />
                  {t("folderSidebar.tags.title")}
                </div>
                <span className="text-[10px] text-zinc-400 font-medium">{allTags.length}</span>
              </div>
              {/* Tag list */}
              <div className="max-h-52 overflow-y-auto px-2 pb-2 space-y-0.5">
                {allTags.map(tagInfo => {
                  const isActive = selectedTagFilter === tagInfo.tag;
                  const dotColor = tagInfo.color || DEFAULT_TAG_COLOR;
                  return (
                    <div
                      key={tagInfo.tag}
                      className={[
                        'group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer select-none transition-colors',
                        isActive
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-zinc-600 hover:bg-zinc-100',
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
                      {/* Colored dot */}
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0 transition-transform group-hover:scale-110"
                        style={{ backgroundColor: dotColor }}
                      />
                      <span className="text-[13px] font-medium flex-1 truncate">{tagInfo.tag}</span>
                      <span className="text-[10px] font-medium text-zinc-400 shrink-0">{tagInfo.count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Settings Button (Footer) ─────────────────────────── */}
          <div className="border-t border-zinc-200 shrink-0 p-3">
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-zinc-600 rounded-lg hover:bg-zinc-100 transition-colors"
            >
              <Settings size={15} className="text-zinc-400" />
              {t("folderSidebar.actions.settings")}
            </button>
          </div>
        </>
      )}

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
            <span>{t("folderSidebar.context.rename")}</span>
          </button>
          <button
            onClick={async () => {
              const folder = contextMenu.folder;
              setContextMenu(null);
              await onDeleteFolder(folder);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
          >
            <Trash2 size={15} />
            <span>{t("folderSidebar.context.delete")}</span>
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
                <h3 className="text-sm font-semibold text-zinc-900">{t("folderSidebar.newDialog.title")}</h3>
                <p className="text-xs text-zinc-500">{t("folderSidebar.newDialog.description")}</p>
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
                <label className="mb-2 block text-xs font-medium text-zinc-500">{t("folderSidebar.newDialog.name")}</label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/15">
                  <input
                    ref={newFolderInputRef}
                    type="text"
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none"
                    placeholder={t("folderSidebar.newDialog.placeholder")}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setNewFolderParentId(null); setNewFolderName(""); }}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
                >
                  {t("folderSidebar.newDialog.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!newFolderName.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
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
                <h3 className="text-sm font-semibold text-zinc-900">{t("folderSidebar.renameDialog.title")}</h3>
                <p className="text-xs text-zinc-500">{t("folderSidebar.renameDialog.description")}</p>
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
                <label className="mb-2 block text-xs font-medium text-zinc-500">{t("folderSidebar.renameDialog.name")}</label>
                <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/15">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    className="w-full bg-transparent py-2.5 text-sm text-zinc-800 outline-none"
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
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
                >
                  {t("folderSidebar.renameDialog.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!renameValue.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
                >
                  {t("folderSidebar.renameDialog.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tag color picker (right-click context menu) */}
      {tagColorMenu && (
        <div
          className="fixed z-50 rounded-xl border border-zinc-200 bg-white p-3 shadow-[0_12px_40px_rgba(0,0,0,0.14)] min-w-[160px]"
          style={{
            left: Math.min(tagColorMenu.x, window.innerWidth  - 172),
            top:  Math.min(tagColorMenu.y, window.innerHeight - 100),
          }}
          onClick={e => e.stopPropagation()}
        >
          <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-0.5">
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

/* ── Folder tree item (recursive) ── */
function FolderTreeItem({
  node,
  depth,
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
  const hasChildren = node.children.length > 0;
  const isDropTarget = Boolean(draggedItemId) && dragOverFolderId === node.id;

  useEffect(() => {
    if (isDropTarget && hasChildren && !open) {
      setOpen(true);
    }
  }, [isDropTarget, hasChildren, open]);

  return (
    <div>
      <div
        data-folder-drop-id={node.id}
        className={`group flex items-center space-x-1.5 px-2 py-1.5 rounded-md cursor-pointer select-none transition-colors ${
          isDropTarget
            ? "bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300"
            : isSelected
            ? "bg-indigo-50 text-indigo-700"
            : "text-zinc-600 hover:bg-zinc-100"
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
          title={t("folderSidebar.actions.newSubFolder")}
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
              draggedItemId={draggedItemId}
              dragOverFolderId={dragOverFolderId}
              onFolderHover={onFolderHover}
              onSelectFolder={onSelectFolder}
              onDeleteFolder={onDeleteFolder}
              onOpenNewFolderDialog={onOpenNewFolderDialog}
              onOpenContextMenu={onOpenContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}