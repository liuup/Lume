/**
 * Module: src/hooks/useLibrary.ts
 * Purpose: Encapsulates all state management and Tauri command invocations related to the library, folders, and items.
 * Capabilities:
 *  - Manages folderTree, openTabs, and selected items/folders state.
 *  - Provides bound functions for adding, deleting, renaming, and opening PDFs.
 *  - Handles syncing PDF context to the Rust backend before rendering.
 * Context: Extracted from App.tsx to decouple complex local state logic from layout and rendering structure.
 */

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { 
  FolderNode, 
  LibraryItem, 
  OpenTab, 
  PageDimension, 
  DEFAULT_FOLDER 
} from "../types";

export function useLibrary() {
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const [folderTree, setFolderTree] = useState<FolderNode[]>([DEFAULT_FOLDER]);
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
  // Also re-fetch dimensions if they are somehow missing (guards against white screen).
  useEffect(() => {
    if (!pdfPath) return;
    let isMounted = true;
    (async () => {
      try {
        setIsLoading(true);
        await invoke("load_pdf", { path: pdfPath });
        if (!isMounted) return;

        // If the active tab has no dimensions (e.g. data was lost), re-fetch them now.
        // Read current tabs to check, then kick off an async fetch OUTSIDE setState.
        const currentTabs = openTabs;
        const tab = currentTabs.find(t => t.item.attachments?.[0]?.path === pdfPath || t.item.id === pdfPath);
        if (tab && tab.dimensions.length === 0) {
          try {
            const dims = await invoke<PageDimension[]>("get_pdf_dimensions", { path: pdfPath });
            if (!isMounted) return;
            setOpenTabs(tabs => tabs.map(t =>
              (t.item.attachments?.[0]?.path === pdfPath || t.item.id === pdfPath)
                ? { ...t, dimensions: dims }
                : t
            ));
          } catch (err) {
            console.error("Failed to recover PDF dimensions", err);
          }
        }

        if (isMounted) setIsLoading(false);
      } catch (err) {
        console.error("Failed to switch PDF context", err);
        if (isMounted) setIsLoading(false);
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
    if (path.startsWith(`${oldPrefix}/`)) {
      return `${newPrefix}${path.slice(oldPrefix.length)}`;
    }
    return path;
  }

  function createLibraryItem(path: string): LibraryItem {
    const fileName = path.split("/").pop() ?? path;
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
    const tree = await invoke<FolderNode[]>("load_library_tree");
    setFolderTree(tree);

    const rootId = tree[0]?.id ?? DEFAULT_FOLDER.id;
    setSelectedFolderId(prev => {
      const nextId = preferredFolderId ?? prev;
      return nextId && findFolder(tree, nextId) ? nextId : rootId;
    });
    return tree;
  }

  useEffect(() => {
    refreshLibrary().catch(err => console.error("Failed to load library", err));
  }, []);

  const handleAddItem = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    try {
      const targetFolder = findFolder(folderTree, selectedFolderId);
      if (!targetFolder) return;

      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (selected && typeof selected === "string") {
        setIsLoading(true);
        const importedPath: string = await invoke("import_pdf_to_folder", {
          sourcePath: selected,
          folderPath: targetFolder.path,
        });
        const pages: number = await invoke("load_pdf", { path: importedPath });
        const dims: PageDimension[] = await invoke("get_pdf_dimensions", { path: importedPath });
        const refreshedTree = await refreshLibrary(targetFolder.id);
        const newItem = findItem(refreshedTree, importedPath) ?? createLibraryItem(importedPath);
        
        setOpenTabs(prev => {
          if (prev.find(tab => tab.id === newItem.id)) return prev;
          return [...prev, {
            id: newItem.id,
            item: newItem,
            totalPages: pages,
            dimensions: dims,
            currentPage: 1
          }];
        });
        setActiveTabId(newItem.id);
        setSelectedItemId(newItem.id);
        setIsLoading(false);
      }
    } catch (err) {
      console.error("Failed to open PDF", err);
      setIsLoading(false);
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
      const pages: number = await invoke("load_pdf", { path: pdfPath });
      const dims: PageDimension[] = await invoke("get_pdf_dimensions", { path: pdfPath });
      
      setOpenTabs(prev => [...prev, {
        id: item.id,
        item,
        totalPages: pages,
        dimensions: dims,
        currentPage: 1
      }]);
      setActiveTabId(item.id);
      setIsLoading(false);
    } catch (err) {
      console.error("Failed to open PDF", err);
      setIsLoading(false);
    }
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs(prev => {
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
    const el = document.getElementById(`pdf-page-${page}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
      setOpenTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, currentPage: page } : t));
    }
  };
  
  const updateCurrentPage = (page: number) => {
      setOpenTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, currentPage: page } : t));
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
    }
  };

  const handleDeleteItem = async (item: LibraryItem) => {
    try {
      await invoke("delete_library_pdf", { path: item.id });
      await refreshLibrary(selectedFolderId);

      setOpenTabs(prev => {
        const next = prev.filter(tab => tab.id !== item.id);
        if (activeTabId === item.id) {
          setActiveTabId(next.length > 0 ? next[next.length - 1].id : "library");
        }
        return next;
      });
      setSelectedItemId(prev => prev === item.id ? null : prev);
    } catch (err) {
      console.error("Failed to delete Item", err);
      window.alert("Failed to delete Item.");
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
    } catch (err) {
      console.error("Failed to rename Item", err);
      window.alert("Failed to rename Item.");
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
        if (tab.id !== folder.path && !tab.id.startsWith(`${folder.path}/`)) {
          return tab;
        }
        const renamedItemPath = replacePathPrefix(tab.item.attachments[0]?.path || tab.item.id, folder.path, renamedPath);
        const renamedItem = findItem(refreshedTree, renamedItemPath) ?? createLibraryItem(renamedItemPath);
        return { ...tab, id: renamedItem.id, item: renamedItem };
      }));

      setSelectedFolderId(nextSelectedFolderId);
      setSelectedItemId(nextSelectedItemId);
      setActiveTabId(nextActiveTabId);
    } catch (err) {
      console.error("Failed to rename folder", err);
      window.alert("Failed to rename folder.");
    }
  };

  const handleDeleteFolder = async (folder: FolderNode) => {
    if (folder.id === DEFAULT_FOLDER.id || !folder.path) return;

    try {
      setIsLoading(true);
      await invoke("delete_library_folder", { path: folder.path });

      const parentFolderId = folder.path.split("/").slice(0, -1).join("/") || DEFAULT_FOLDER.id;
      await refreshLibrary(parentFolderId);

      setOpenTabs(prev => {
        const next = prev.filter(tab => !(tab.id === folder.path || tab.id.startsWith(`${folder.path}/`)));
        if (activeTabId && (activeTabId === folder.path || activeTabId.startsWith(`${folder.path}/`))) {
          const nextActiveId = next.length > 0 ? next[next.length - 1].id : "library";
          setActiveTabId(nextActiveId);
          setSelectedItemId(nextActiveId !== "library" ? nextActiveId : null);
        }
        return next;
      });

      setSelectedFolderId(parentFolderId);
      setSelectedItemId(prev => prev && (prev === folder.path || prev.startsWith(`${folder.path}/`)) ? null : prev);
    } catch (err) {
      console.error("Failed to delete folder", err);
      window.alert("Failed to delete folder.");
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
    } catch (err) {
      console.error("Failed to move Item", err);
      window.alert("Failed to move Item.");
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleItemUpdatedLocally = async () => {
       const tree = await refreshLibrary(selectedFolderId);
       if (selectedItemId) {
          const updatedItem = findItem(tree, selectedItemId);
          if (updatedItem) {
            setOpenTabs(prevTabs => 
              prevTabs.map(tab => tab.id === selectedItemId ? { ...tab, item: updatedItem } : tab)
            );
          }
       }
  }

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
    selectedFolderId,
    setSelectedFolderId,
    selectedItemId,
    setSelectedItemId,
    refreshLibrary,
    findItem,
    handleAddItem,
    handleOpenItem,
    handleCloseTab,
    handlePageJump,
    updateCurrentPage,
    handleAddFolder,
    handleDeleteItem,
    handleRenameItem,
    handleMoveItemToFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleItemUpdatedLocally
  };
}
