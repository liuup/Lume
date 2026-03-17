/**
 * Module: src/hooks/useLibrary.ts
 * Purpose: Encapsulates all state management and Tauri command invocations related to the library, folders, and items.
 * Capabilities:
 *  - Manages folderTree, openTabs, and selected items/folders state.
 *  - Provides bound functions for adding, deleting, renaming, and opening PDFs.
 *  - Handles syncing PDF context to the Rust backend before rendering.
 * Context: Extracted from App.tsx to decouple complex local state logic from layout and rendering structure.
 */

import { useState, useEffect, useEffectEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useFeedback } from "./useFeedback";
import { useI18n } from "./useI18n";
import {
  CliLibraryChangedPayload,
  CliOpenRequest,
  FolderNode, 
  LibraryItem, 
  OpenTab, 
  PageDimension, 
  DEFAULT_FOLDER,
  TRASH_FOLDER_ID,
} from "../types";
import { clearCacheForPdf } from "../components/pdfCacheRegistry";
import { preloadPdfDocument } from "../components/pdfDocumentRuntime";
import { preloadPdfCoreRuntime } from "../components/pdfRuntime";

const DEFAULT_PAGE_DIMENSION: PageDimension = {
  width: 612,
  height: 792,
};

function createPlaceholderDimensions(totalPages: number): PageDimension[] {
  return Array.from({ length: Math.max(totalPages, 0) }, () => ({ ...DEFAULT_PAGE_DIMENSION }));
}

export function useLibrary() {
  const feedback = useFeedback();
  const { t } = useI18n();
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const [folderTree, setFolderTree] = useState<FolderNode[]>([DEFAULT_FOLDER]);
  const [trashItems, setTrashItems] = useState<LibraryItem[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>(DEFAULT_FOLDER.id);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Active Tab Derived State
  const activeTab = openTabs.find(t => t.id === activeTabId) || null;
  const pdfPath = activeTab?.item.attachments?.[0]?.path || null;
  const totalPages = activeTab?.totalPages || 0;
  const dimensions = activeTab?.dimensions || [];
  const currentPage = activeTab?.currentPage || 1;

  // Sync background Rust PDF context when switching tabs.
  // Keep the Rust-side document loaded for commands that still depend on backend PDF context.
  useEffect(() => {
    if (!pdfPath) return;
    let isMounted = true;
    (async () => {
      try {
        await invoke("load_pdf", { path: pdfPath });
        if (!isMounted) return;
      } catch (err) {
        console.error("Failed to switch PDF context", err);
      }
    })();
    return () => { isMounted = false; };
  }, [pdfPath]);

  function findFolder(nodes: FolderNode[], id: string): FolderNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      const found = findFolder(n.children, id);
      if (found) return found;
    }
    return null;
  }

  function findItem(nodes: FolderNode[], id: string): LibraryItem | null {
    for (const n of nodes) {
      const found = n.items.find(p => p.id === id);
      if (found) return found;
      const deep = findItem(n.children, id);
      if (deep) return deep;
    }
    return null;
  }

  function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string) {
    if (path === oldPrefix) return newPrefix;
    if (pathHasPrefix(path, oldPrefix)) {
      return `${newPrefix}${path.slice(oldPrefix.length)}`;
    }
    return path;
  }

  function pathHasPrefix(path: string, prefix: string) {
    return (
      path === prefix ||
      path.startsWith(`${prefix}/`) ||
      path.startsWith(`${prefix}\\`)
    );
  }

  function pathBaseName(path: string) {
    return path.split(/[/\\]/).pop() ?? path;
  }

  function pathDirName(path: string) {
    const segments = path.split(/[/\\]/);
    if (segments.length <= 1) return "";
    const separator = path.includes("\\") ? "\\" : "/";
    return segments.slice(0, -1).join(separator);
  }

  function createLibraryItem(path: string): LibraryItem {
    const fileName = pathBaseName(path);
    const baseName = fileName.replace(/\.pdf$/i, "");
    return {
      id: path,
      item_type: "Journal Article",
      title: baseName,
      authors: "—",
      year: "—",
      abstract: "",
      doi: "",
      arxiv_id: "",
      publication: "",
      volume: "",
      issue: "",
      pages: "",
      publisher: "",
      isbn: "",
      url: "",
      language: "",
      date_added: "",
      date_modified: "",
      folder_path: "",
      tags: [],
      attachments: [{
        id: `att-${path}`,
        item_id: path,
        name: baseName,
        path: path,
        attachment_type: "PDF"
      }],
    };
  }

  async function refreshLibrary(preferredFolderId?: string) {
    const [tree, nextTrashItems] = await Promise.all([
      invoke<FolderNode[]>("load_library_tree"),
      invoke<LibraryItem[]>("load_trash_items"),
    ]);
    setFolderTree(tree);
    setTrashItems(nextTrashItems);

    const rootId = tree[0]?.id ?? DEFAULT_FOLDER.id;
    setSelectedFolderId(prev => {
      const nextId = preferredFolderId ?? prev;
      if (nextId === TRASH_FOLDER_ID) {
        return TRASH_FOLDER_ID;
      }
      return nextId && findFolder(tree, nextId) ? nextId : rootId;
    });
    return tree;
  }

  useEffect(() => {
    refreshLibrary().catch(err => {
      console.error("Failed to load library", err);
      feedback.error({
        title: t("feedback.library.loadError.title"),
        description: t("feedback.library.loadError.description"),
      });
    });
  }, [feedback, t]);

  const handleCliOpen = useEffectEvent(async (request: CliOpenRequest) => {
    const target = request.target?.trim();
    if (!target) return;

    try {
      const tree = await refreshLibrary();
      const libraryItem = findItem(tree, target);
      if (libraryItem) {
        if (libraryItem.folder_path && findFolder(tree, libraryItem.folder_path)) {
          setSelectedFolderId(libraryItem.folder_path);
        }
        setSelectedItemId(libraryItem.id);
        await handleOpenItem(libraryItem);
        return;
      }

      const externalItem = createLibraryItem(target);
      setSelectedItemId(externalItem.id);
      await handleOpenItem(externalItem);
    } catch (err) {
      console.error("Failed to open CLI target", err);
      feedback.error({
        title: t("feedback.library.openError.title"),
        description: t("feedback.library.openError.description"),
      });
    }
  });

  const handleCliLibraryChanged = useEffectEvent(async () => {
    try {
      await handleItemUpdatedLocally();
    } catch (err) {
      console.error("Failed to refresh library after CLI change", err);
    }
  });

  useEffect(() => {
    let cancelled = false;
    let unlistenOpen: (() => void) | null = null;
    let unlistenChanged: (() => void) | null = null;

    (async () => {
      unlistenOpen = await listen<CliOpenRequest>("cli-open-request", (event) => {
        void handleCliOpen(event.payload);
      });

      unlistenChanged = await listen<CliLibraryChangedPayload>("cli-library-changed", () => {
        void handleCliLibraryChanged();
      });

      const pending = await invoke<CliOpenRequest | null>("take_pending_cli_open_request");
      if (!cancelled && pending) {
        await handleCliOpen(pending);
      }
    })().catch((err) => {
      console.error("Failed to initialize CLI listeners", err);
    });

    return () => {
      cancelled = true;
      if (unlistenOpen) unlistenOpen();
      if (unlistenChanged) unlistenChanged();
    };
  }, []);

  const importPdfPaths = async (paths: string[], folderIdOverride?: string | null) => {
    const normalizedPaths = Array.from(
      new Set(paths.map((path) => path.trim()).filter((path) => path && /\.pdf$/i.test(path))),
    );

    if (normalizedPaths.length === 0) {
      feedback.error({
        title: t("feedback.library.import.error.title"),
        description: t("feedback.library.import.error.description"),
      });
      return [] as LibraryItem[];
    }

    try {
      const preferredFolderId = folderIdOverride && folderIdOverride !== TRASH_FOLDER_ID
        ? folderIdOverride
        : selectedFolderId !== TRASH_FOLDER_ID
          ? selectedFolderId
          : folderTree[0]?.id ?? DEFAULT_FOLDER.id;
      const targetFolder = findFolder(folderTree, preferredFolderId) ?? folderTree[0];
      if (!targetFolder) return [] as LibraryItem[];

      setIsLoading(true);
      void preloadPdfCoreRuntime();

      const importedPaths: string[] = [];
      for (const sourcePath of normalizedPaths) {
        const importedPath: string = await invoke("import_pdf_to_folder", {
          sourcePath,
          folderPath: targetFolder.path,
        });
        importedPaths.push(importedPath);
        void preloadPdfDocument(importedPath);
      }

      const focusedImportedPath = importedPaths[importedPaths.length - 1];
      const pages: number = await invoke("load_pdf", { path: focusedImportedPath });
      const refreshedTree = await refreshLibrary(targetFolder.id);
      const importedItems = importedPaths.map((importedPath) => (
        findItem(refreshedTree, importedPath) ?? createLibraryItem(importedPath)
      ));
      const focusedItem = importedItems[importedItems.length - 1];

      setOpenTabs((prev) => {
        if (prev.find((tab) => tab.id === focusedItem.id)) return prev;
        return [...prev, {
          id: focusedItem.id,
          item: focusedItem,
          totalPages: pages,
          dimensions: createPlaceholderDimensions(pages),
          currentPage: 1,
        }];
      });
      setActiveTabId(focusedItem.id);
      setSelectedItemId(focusedItem.id);

      feedback.success({
        title: t("feedback.library.import.success.title"),
        description: importedItems.length === 1
          ? t("feedback.library.import.success.description", {
              title: focusedItem.title || focusedItem.attachments[0]?.name || trimmedFileName(normalizedPaths[0]),
            })
          : t("feedback.library.import.success.multipleDescription", {
              count: importedItems.length,
            }),
      });

      return importedItems;
    } catch (err) {
      console.error("Failed to import PDF", err);
      feedback.error({
        title: t("feedback.library.import.error.title"),
        description: t("feedback.library.import.error.description"),
      });
      return [] as LibraryItem[];
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddItem = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (selected && typeof selected === "string") {
        await importPdfPaths([selected]);
      }
    } catch (err) {
      console.error("Failed to select PDF", err);
      feedback.error({
        title: t("feedback.library.import.error.title"),
        description: t("feedback.library.import.error.description"),
      });
    }
  };

  const handleOpenItem = async (item: LibraryItem) => {
    if (openTabs.find(t => t.id === item.id)) {
      setActiveTabId(item.id);
      return;
    }
    try {
      setIsLoading(true);
      const pdfPath = item.attachments?.[0]?.path || item.id;
      void preloadPdfCoreRuntime();
      void preloadPdfDocument(pdfPath);
      const pages: number = await invoke("load_pdf", { path: pdfPath });
      
      setOpenTabs(prev => [...prev, {
        id: item.id,
        item,
        totalPages: pages,
        dimensions: createPlaceholderDimensions(pages),
        currentPage: 1
      }]);
      setActiveTabId(item.id);
      setIsLoading(false);
    } catch (err) {
      console.error("Failed to open PDF", err);
      feedback.error({
        title: t("feedback.library.openError.title"),
        description: t("feedback.library.openError.description"),
      });
      setIsLoading(false);
    }
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs(prev => {
      const closingTab = prev.find(t => t.id === id);
      if (closingTab) {
        clearCacheForPdf(closingTab.item.attachments?.[0]?.path || closingTab.id);
      }
      const next = prev.filter(t => t.id !== id);
      if (activeTabId === id) {
        const nextActiveId = next.length > 0 ? next[next.length - 1].id : 'library';
        setActiveTabId(nextActiveId);
        if (nextActiveId && nextActiveId !== 'library') setSelectedItemId(nextActiveId);
      }
      return next;
    });
  };

  const handlePageJump = (page: number) => {
    if (!activeTabId || activeTabId === "library") return;
    setOpenTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, currentPage: page } : t));

    const pageElementId = `pdf-page-${encodeURIComponent(activeTabId)}-${page}`;
    const scrollIntoTarget = (retriesLeft: number) => {
      const el = document.getElementById(pageElementId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }

      if (retriesLeft > 0) {
        window.requestAnimationFrame(() => {
          scrollIntoTarget(retriesLeft - 1);
        });
      }
    };

    scrollIntoTarget(6);
  };
  
  const updateCurrentPage = (page: number) => {
      setOpenTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, currentPage: page } : t));
  };

  const updatePageDimension = (tabId: string, pageIndex: number, dimension: PageDimension) => {
    setOpenTabs((tabs) => tabs.map((tab) => {
      if (tab.id !== tabId) {
        return tab;
      }

      const current = tab.dimensions[pageIndex];
      if (current && current.width === dimension.width && current.height === dimension.height) {
        return tab;
      }

      const nextDimensions = tab.dimensions.length === tab.totalPages
        ? [...tab.dimensions]
        : createPlaceholderDimensions(tab.totalPages);

      nextDimensions[pageIndex] = dimension;
      return { ...tab, dimensions: nextDimensions };
    }));
  };


  const handleAddFolder = async (parentId: string, name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const parent = findFolder(folderTree, parentId);
    if (!parent) return;

    try {
      const createdPath: string = await invoke("create_library_folder", {
        parentPath: parent.path,
        name: trimmedName,
      });
      await refreshLibrary(createdPath);
      setSelectedFolderId(createdPath);
    } catch (err) {
      console.error("Failed to create folder", err);
      feedback.error({
        title: t("feedback.library.folder.createError.title"),
        description: t("feedback.library.folder.createError.description", { name: trimmedName }),
      });
    }
  };

  const handleDeleteItem = async (item: LibraryItem) => {
    try {
      await invoke("delete_library_pdf", { path: item.id });
      await refreshLibrary(selectedFolderId === TRASH_FOLDER_ID ? TRASH_FOLDER_ID : selectedFolderId);

      setOpenTabs(prev => {
        const next = prev.filter(tab => tab.id !== item.id);
        if (activeTabId === item.id) {
          setActiveTabId(next.length > 0 ? next[next.length - 1].id : "library");
        }
        return next;
      });
      setSelectedItemId(prev => prev === item.id ? null : prev);
      feedback.success({
        title: t("feedback.library.item.deleteSuccess.title"),
        description: t("feedback.library.item.deleteSuccess.description", { title: item.title || item.attachments[0]?.name || pathBaseName(item.id) || item.id }),
      });
    } catch (err) {
      console.error("Failed to delete Item", err);
      feedback.error({
        title: t("feedback.library.item.deleteError.title"),
        description: t("feedback.library.item.deleteError.description"),
      });
    }
  };

  const handleRenameItem = async (item: LibraryItem, nextName: string) => {
    const trimmedName = nextName.trim();
    if (!trimmedName || trimmedName === (item.title || item.attachments[0]?.name)) return;

    try {
      const renamedPath: string = await invoke("rename_library_pdf", {
        path: item.id,
        newName: trimmedName,
      });
      const refreshedTree = await refreshLibrary(selectedFolderId);
      const renamedItem = findItem(refreshedTree, renamedPath) ?? createLibraryItem(renamedPath);

      setOpenTabs(prev => prev.map(tab => {
        if (tab.id !== item.id) return tab;
        return { ...tab, id: renamedItem.id, item: renamedItem };
      }));
      setSelectedItemId(prev => prev === item.id ? renamedItem.id : prev);
      setActiveTabId(prev => prev === item.id ? renamedItem.id : prev);
      feedback.success({
        title: t("feedback.library.item.renameSuccess.title"),
        description: t("feedback.library.item.renameSuccess.description", { title: trimmedName }),
      });
    } catch (err) {
      console.error("Failed to rename Item", err);
      feedback.error({
        title: t("feedback.library.item.renameError.title"),
        description: t("feedback.library.item.renameError.description"),
      });
    }
  };

  const handleRenameFolder = async (folder: FolderNode, nextName: string) => {
    const trimmedName = nextName.trim();
    if (!trimmedName || trimmedName === folder.name) return;

    try {
      const renamedPath: string = await invoke("rename_library_folder", {
        path: folder.path,
        newName: trimmedName,
      });

      const nextSelectedFolderId = replacePathPrefix(selectedFolderId, folder.path, renamedPath);
      const nextSelectedItemId = selectedItemId ? replacePathPrefix(selectedItemId, folder.path, renamedPath) : null;
      const nextActiveTabId = activeTabId && activeTabId !== "library"
        ? replacePathPrefix(activeTabId, folder.path, renamedPath)
        : activeTabId;

      const refreshedTree = await refreshLibrary(nextSelectedFolderId);

      setOpenTabs(prev => prev.map(tab => {
        if (!pathHasPrefix(tab.id, folder.path)) {
          return tab;
        }
        const renamedItemPath = replacePathPrefix(tab.item.attachments[0]?.path || tab.item.id, folder.path, renamedPath);
        const renamedItem = findItem(refreshedTree, renamedItemPath) ?? createLibraryItem(renamedItemPath);
        return { ...tab, id: renamedItem.id, item: renamedItem };
      }));

      setSelectedFolderId(nextSelectedFolderId);
      setSelectedItemId(nextSelectedItemId);
      setActiveTabId(nextActiveTabId);
      feedback.success({
        title: t("feedback.library.folder.renameSuccess.title"),
        description: t("feedback.library.folder.renameSuccess.description", { name: trimmedName }),
      });
    } catch (err) {
      console.error("Failed to rename folder", err);
      feedback.error({
        title: t("feedback.library.folder.renameError.title"),
        description: t("feedback.library.folder.renameError.description"),
      });
    }
  };

  const handleDeleteFolder = async (folder: FolderNode) => {
    if (folder.id === DEFAULT_FOLDER.id || !folder.path) return;

    try {
      setIsLoading(true);
      await invoke("delete_library_folder", { path: folder.path });

      const parentFolderId = pathDirName(folder.path) || DEFAULT_FOLDER.id;
      await refreshLibrary(parentFolderId);

      setOpenTabs(prev => {
        const next = prev.filter(tab => !pathHasPrefix(tab.id, folder.path));
        if (activeTabId && pathHasPrefix(activeTabId, folder.path)) {
          const nextActiveId = next.length > 0 ? next[next.length - 1].id : "library";
          setActiveTabId(nextActiveId);
          setSelectedItemId(nextActiveId !== "library" ? nextActiveId : null);
        }
        return next;
      });

      setSelectedFolderId(parentFolderId);
      setSelectedItemId(prev => (prev && pathHasPrefix(prev, folder.path)) ? null : prev);
      feedback.success({
        title: t("feedback.library.folder.deleteSuccess.title"),
        description: t("feedback.library.folder.deleteSuccess.description", { name: folder.name }),
      });
    } catch (err) {
      console.error("Failed to delete folder", err);
      feedback.error({
        title: t("feedback.library.folder.deleteError.title"),
        description: t("feedback.library.folder.deleteError.description"),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleMoveItemToFolder = async (itemId: string, targetFolderId: string) => {
    const item = findItem(folderTree, itemId);
    const targetFolder = findFolder(folderTree, targetFolderId);
    if (!item || !targetFolder) return;
    if (item.folder_path === targetFolder.path) return;

    try {
      setIsLoading(true);
      const movedPath: string = await invoke("move_library_pdf", {
        path: item.id,
        targetFolderPath: targetFolder.path,
      });

      const refreshedTree = await refreshLibrary(selectedFolderId);
      const movedItem = findItem(refreshedTree, movedPath) ?? createLibraryItem(movedPath);

      setOpenTabs(prev => prev.map(tab => {
        if (tab.id !== item.id) return tab;
        return { ...tab, id: movedItem.id, item: movedItem };
      }));
      setSelectedItemId(prev => prev === item.id ? movedItem.id : prev);
      setActiveTabId(prev => prev === item.id ? movedItem.id : prev);
      feedback.success({
        title: t("feedback.library.item.moveSuccess.title"),
        description: t("feedback.library.item.moveSuccess.description", { folder: targetFolder.name }),
      });
    } catch (err) {
      console.error("Failed to move Item", err);
      feedback.error({
        title: t("feedback.library.item.moveError.title"),
        description: t("feedback.library.item.moveError.description"),
      });
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleItemUpdatedLocally = async () => {
       const tree = await refreshLibrary(selectedFolderId);
       if (selectedItemId) {
          const updatedItem = findItem(tree, selectedItemId) ?? trashItems.find(item => item.id === selectedItemId) ?? null;
          if (updatedItem) {
            setOpenTabs(prevTabs => 
              prevTabs.map(tab => tab.id === selectedItemId ? { ...tab, item: updatedItem } : tab)
            );
          }
       }
  }

  const handleRestoreTrashItem = async (item: LibraryItem) => {
    try {
      setIsLoading(true);
      const restoredPath: string = await invoke("restore_library_pdf", { path: item.id });
      const refreshedTree = await refreshLibrary(TRASH_FOLDER_ID);
      const restoredItem = findItem(refreshedTree, restoredPath) ?? createLibraryItem(restoredPath);
      setOpenTabs((prev) => prev.map((tab) => tab.id === item.id ? { ...tab, id: restoredItem.id, item: restoredItem } : tab));
      setSelectedItemId(prev => prev === item.id ? restoredItem.id : prev);
      setActiveTabId(prev => prev === item.id ? restoredItem.id : prev);
      feedback.success({
        title: t("feedback.library.trash.restoreSuccess.title"),
        description: t("feedback.library.trash.restoreSuccess.description", { title: item.title || item.attachments[0]?.name || pathBaseName(item.id) }),
      });
    } catch (err) {
      console.error("Failed to restore item from trash", err);
      feedback.error({
        title: t("feedback.library.trash.restoreError.title"),
        description: t("feedback.library.trash.restoreError.description"),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmptyTrash = async () => {
    try {
      setIsLoading(true);
      await invoke("empty_trash");
      await refreshLibrary(TRASH_FOLDER_ID);
      setSelectedItemId((prev) => trashItems.some((item) => item.id === prev) ? null : prev);
      setOpenTabs((prev) => prev.filter((tab) => !trashItems.some((item) => item.id === tab.id)));
      if (activeTabId && trashItems.some((item) => item.id === activeTabId)) {
        setActiveTabId("library");
      }
      feedback.success({
        title: t("feedback.library.item.trash.emptySuccess.title"),
        description: t("feedback.library.item.trash.emptySuccess.description"),
      });
    } catch (err) {
      console.error("Failed to empty trash", err);
      feedback.error({
        title: t("feedback.library.item.trash.emptyError.title"),
        description: t("feedback.library.item.trash.emptyError.description"),
      });
    } finally {
      setIsLoading(false);
    }
  };

  return {
    openTabs,
    activeTabId,
    setActiveTabId,
    activeTab,
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
    refreshLibrary,
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
  };
}

function trimmedFileName(path: string) {
  return path.split(/[/\\]/).pop()?.replace(/\.pdf$/i, "") || path;
}
