/**
 * Module: src/hooks/useLibrary.ts
 * Purpose: Encapsulates all state management and Tauri command invocations related to the library, folders, and items.
 * Capabilities:
 *  - Manages folderTree, openTabs, and selected items/folders state.
 *  - Provides bound functions for adding, deleting, renaming, and opening PDFs.
 *  - Handles syncing PDF context to the Rust backend before rendering.
 * Context: Extracted from App.tsx to decouple complex local state logic from layout and rendering structure.
 */

import { useState, useEffect, useEffectEvent, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useFeedback } from "./useFeedback";
import { useI18n } from "./useI18n";
import {
  CliLibraryChangedPayload,
  CliOpenRequest,
  DUPLICATES_FOLDER_ID,
  DuplicateGroup,
  FAVORITES_FOLDER_ID,
  FolderNode, 
  IdentifierImportResult,
  LibraryItemMetadataUpdatedPayload,
  LibraryItem, 
  OpenTab, 
  PageBookmark,
  PageDimension, 
  RecentDocument,
  ReferenceImportResult,
  SMART_COLLECTION_PREFIX,
  SmartCollection,
  SmartCollectionDraft,
  SmartCollectionMatchMode,
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

const RECENT_DOCUMENTS_KEY = "recentDocuments";
const FAVORITE_ITEM_IDS_KEY = "favoriteItemIds";
const PAGE_BOOKMARKS_KEY = "pageBookmarks";
const SMART_COLLECTIONS_KEY = "smartCollections";
const MAX_RECENT_DOCUMENTS = 8;

type StoredSetting = {
  key: string;
  value: string;
};

type MergeDuplicateItemsResult = {
  item: LibraryItem;
  survivorItemId: string;
  mergedItemIds: string[];
};

function createPlaceholderDimensions(totalPages: number): PageDimension[] {
  return Array.from({ length: Math.max(totalPages, 0) }, () => ({ ...DEFAULT_PAGE_DIMENSION }));
}

function clampRecentPage(value: unknown) {
  const page = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function normalizeRecentDocumentEntry(value: unknown): RecentDocument | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<RecentDocument>;
  const itemId = typeof candidate.itemId === "string" ? candidate.itemId.trim() : "";
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const subtitle = typeof candidate.subtitle === "string" ? candidate.subtitle.trim() : "";
  const lastOpenedAt = typeof candidate.lastOpenedAt === "string" ? candidate.lastOpenedAt.trim() : "";

  if (!itemId || !title || !lastOpenedAt) {
    return null;
  }

  return {
    itemId,
    title,
    subtitle,
    lastPage: clampRecentPage(candidate.lastPage),
    lastOpenedAt,
  };
}

function parseRecentDocuments(value: string | undefined) {
  if (!value) {
    return [] as RecentDocument[];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [] as RecentDocument[];
    }

    return parsed
      .map((entry) => normalizeRecentDocumentEntry(entry))
      .filter((entry): entry is RecentDocument => Boolean(entry))
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
      .slice(0, MAX_RECENT_DOCUMENTS);
  } catch (error) {
    console.error("Failed to parse recent documents:", error);
    return [] as RecentDocument[];
  }
}

function normalizeStringIdList(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }

  return Array.from(new Set(
    value
      .map((entry) => typeof entry === "string" ? entry.trim() : "")
      .filter(Boolean),
  ));
}

function parseStringIdList(value: string | undefined) {
  if (!value) {
    return [] as string[];
  }

  try {
    return normalizeStringIdList(JSON.parse(value));
  } catch (error) {
    console.error("Failed to parse string id list:", error);
    return [] as string[];
  }
}

function normalizePageBookmark(value: unknown): PageBookmark | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<PageBookmark>;
  const page = clampRecentPage(candidate.page);
  const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt.trim() : "";

  if (!createdAt) {
    return null;
  }

  return { page, createdAt };
}

function normalizePageBookmarksMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, PageBookmark[]>;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([itemId, bookmarks]) => {
        const normalizedItemId = itemId.trim();
        if (!normalizedItemId || !Array.isArray(bookmarks)) {
          return null;
        }

        const normalizedBookmarks = bookmarks
          .map((bookmark) => normalizePageBookmark(bookmark))
          .filter((bookmark): bookmark is PageBookmark => Boolean(bookmark))
          .sort((left, right) => left.page - right.page || left.createdAt.localeCompare(right.createdAt))
          .filter((bookmark, index, entries) => entries.findIndex((entry) => entry.page === bookmark.page) === index);

        return [normalizedItemId, normalizedBookmarks] as const;
      })
      .filter((entry): entry is readonly [string, PageBookmark[]] => Boolean(entry)),
  );
}

function parsePageBookmarks(value: string | undefined) {
  if (!value) {
    return {} as Record<string, PageBookmark[]>;
  }

  try {
    return normalizePageBookmarksMap(JSON.parse(value));
  } catch (error) {
    console.error("Failed to parse page bookmarks:", error);
    return {} as Record<string, PageBookmark[]>;
  }
}

function normalizeSmartCollectionMatchMode(value: unknown): SmartCollectionMatchMode {
  return value === "any" ? "any" : "all";
}

function normalizeSmartCollection(value: unknown): SmartCollection | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<SmartCollection>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const query = typeof candidate.query === "string" ? candidate.query.trim() : "";
  const year = typeof candidate.year === "string" ? candidate.year.trim() : "";
  const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt.trim() : "";
  const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt.trim() : "";

  if (!id || !name || !createdAt || !updatedAt) {
    return null;
  }

  return {
    id,
    name,
    query,
    year,
    tags: normalizeStringIdList(candidate.tags),
    favoritesOnly: Boolean(candidate.favoritesOnly),
    matchMode: normalizeSmartCollectionMatchMode(candidate.matchMode),
    createdAt,
    updatedAt,
  };
}

function parseSmartCollections(value: string | undefined) {
  if (!value) {
    return [] as SmartCollection[];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [] as SmartCollection[];
    }

    return parsed
      .map((entry) => normalizeSmartCollection(entry))
      .filter((entry): entry is SmartCollection => Boolean(entry))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  } catch (error) {
    console.error("Failed to parse smart collections:", error);
    return [] as SmartCollection[];
  }
}

function moveListItem<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length || fromIndex === toIndex) {
    return items;
  }

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) {
    return items;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

function parseSmartCollectionFolderId(folderId: string) {
  return folderId.startsWith(SMART_COLLECTION_PREFIX)
    ? folderId.slice(SMART_COLLECTION_PREFIX.length)
    : null;
}

function isVirtualFolderId(folderId: string) {
  return folderId === TRASH_FOLDER_ID
    || folderId === DUPLICATES_FOLDER_ID
    || folderId === FAVORITES_FOLDER_ID
    || folderId.startsWith(SMART_COLLECTION_PREFIX);
}

function buildSmartCollectionSearchText(item: LibraryItem) {
  return [
    item.title,
    item.authors,
    item.abstract,
    item.publication,
    item.publisher,
    item.doi,
    item.arxiv_id,
    item.url,
    item.folder_path,
    item.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

function buildRecentDocument(item: LibraryItem, page: number): RecentDocument {
  const title = item.title || item.attachments?.[0]?.name || trimmedFileName(item.id);
  const subtitle = item.authors && item.authors !== "—"
    ? item.authors
    : item.publication || item.folder_path || "";

  return {
    itemId: item.id,
    title,
    subtitle,
    lastPage: clampRecentPage(page),
    lastOpenedAt: new Date().toISOString(),
  };
}

function collectAllItems(nodes: FolderNode[]): LibraryItem[] {
  return nodes.flatMap((node) => [
    ...node.items,
    ...collectAllItems(node.children),
  ]);
}

function getPrimaryPdfPath(item: LibraryItem) {
  return item.attachments.find((attachment) => attachment.attachment_type.toLowerCase() === "pdf")?.path ?? null;
}

function normalizeDuplicateText(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDuplicateDoi(value: string) {
  const normalized = normalizeDuplicateText(value)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .trim();
  return normalized || null;
}

function normalizeDuplicateArxiv(value: string) {
  const normalized = normalizeDuplicateText(value)
    .replace(/^https?:\/\/arxiv\.org\/abs\//, "")
    .replace(/^arxiv:\s*/, "")
    .trim();
  return normalized || null;
}

function normalizeDuplicateAuthorSeed(value: string) {
  const firstAuthor = value.split(/[;,]/, 1)[0] ?? value;
  const normalized = normalizeDuplicateText(firstAuthor).replace(/[^a-z0-9]+/g, " ").trim();
  return normalized || null;
}

function normalizeDuplicateTitle(value: string) {
  const normalized = normalizeDuplicateText(value).replace(/[^a-z0-9]+/g, " ").trim();
  return normalized.length >= 12 ? normalized : null;
}

function buildDuplicateMetadataKey(item: LibraryItem) {
  const title = normalizeDuplicateTitle(item.title);
  const author = normalizeDuplicateAuthorSeed(item.authors);
  const year = item.year.trim();

  if (!title || !author || !/^\d{4}$/.test(year)) {
    return null;
  }

  return `${title}::${author}::${year}`;
}

export function useLibrary() {
  const feedback = useFeedback();
  const { t } = useI18n();
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const [folderTree, setFolderTree] = useState<FolderNode[]>([DEFAULT_FOLDER]);
  const [trashItems, setTrashItems] = useState<LibraryItem[]>([]);
  const [recentDocuments, setRecentDocuments] = useState<RecentDocument[]>([]);
  const [favoriteItemIds, setFavoriteItemIds] = useState<string[]>([]);
  const [pageBookmarksByItemId, setPageBookmarksByItemId] = useState<Record<string, PageBookmark[]>>({});
  const [smartCollections, setSmartCollections] = useState<SmartCollection[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>(DEFAULT_FOLDER.id);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Active Tab Derived State
  const activeTab = openTabs.find(t => t.id === activeTabId) || null;
  const pdfPath = activeTab?.item.attachments?.[0]?.path || null;
  const totalPages = activeTab?.totalPages || 0;
  const dimensions = activeTab?.dimensions || [];
  const currentPage = activeTab?.currentPage || 1;
  const libraryItems = collectAllItems(folderTree);
  const favoriteDocuments = favoriteItemIds
    .map((itemId) => libraryItems.find((item) => item.id === itemId))
    .filter((item): item is LibraryItem => Boolean(item));
  const duplicateGroups = useMemo(() => {
    const consumedItemIds = new Set<string>();
    const groups: DuplicateGroup[] = [];

    const collectGroups = (
      reason: DuplicateGroup["reason"],
      keyBuilder: (item: LibraryItem) => string | null,
    ) => {
      const grouped = new Map<string, LibraryItem[]>();

      for (const item of libraryItems) {
        if (consumedItemIds.has(item.id)) {
          continue;
        }

        const key = keyBuilder(item);
        if (!key) {
          continue;
        }

        const existing = grouped.get(key) ?? [];
        existing.push(item);
        grouped.set(key, existing);
      }

      for (const [key, items] of grouped.entries()) {
        if (items.length < 2) {
          continue;
        }

        const sortedItems = [...items].sort((left, right) => {
          const dateComparison = right.date_added.localeCompare(left.date_added);
          if (dateComparison !== 0) {
            return dateComparison;
          }
          return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
        });

        sortedItems.forEach((item) => consumedItemIds.add(item.id));
        groups.push({
          id: `${reason}:${key}`,
          reason,
          matchValue: key,
          items: sortedItems,
        });
      }
    };

    collectGroups("doi", (item) => normalizeDuplicateDoi(item.doi));
    collectGroups("arxiv", (item) => normalizeDuplicateArxiv(item.arxiv_id));
    collectGroups("metadata", buildDuplicateMetadataKey);

    return groups.sort((left, right) => {
      if (right.items.length !== left.items.length) {
        return right.items.length - left.items.length;
      }
      return left.items[0]?.title.localeCompare(right.items[0]?.title ?? "", undefined, { sensitivity: "base" }) ?? 0;
    });
  }, [libraryItems]);

  const matchesSmartCollection = useCallback((item: LibraryItem, collection: SmartCollectionDraft) => {
    const checks: boolean[] = [];
    const searchText = buildSmartCollectionSearchText(item);

    if (collection.query) {
      checks.push(searchText.includes(collection.query.toLowerCase()));
    }

    if (collection.year) {
      checks.push(item.year === collection.year);
    }

    if (collection.tags.length > 0) {
      const normalizedItemTags = item.tags.map((tag) => tag.toLowerCase());
      const normalizedRuleTags = collection.tags.map((tag) => tag.toLowerCase());
      checks.push(
        collection.matchMode === "any"
          ? normalizedRuleTags.some((tag) => normalizedItemTags.includes(tag))
          : normalizedRuleTags.every((tag) => normalizedItemTags.includes(tag))
      );
    }

    if (collection.favoritesOnly) {
      checks.push(favoriteItemIds.includes(item.id));
    }

    if (checks.length === 0) {
      return false;
    }

    return collection.matchMode === "any"
      ? checks.some(Boolean)
      : checks.every(Boolean);
  }, [favoriteItemIds]);

  const getSmartCollectionPreviewItems = useCallback((collection: SmartCollectionDraft | null | undefined) => {
    if (!collection) {
      return [] as LibraryItem[];
    }

    return libraryItems.filter((item) => matchesSmartCollection(item, collection));
  }, [libraryItems, matchesSmartCollection]);

  const getSmartCollectionItems = useCallback((collectionId: string) => {
    const collection = smartCollections.find((entry) => entry.id === collectionId);
    return getSmartCollectionPreviewItems(collection);
  }, [getSmartCollectionPreviewItems, smartCollections]);

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

  function findItemFolderId(nodes: FolderNode[], itemId: string): string | null {
    for (const node of nodes) {
      if (node.items.some((item) => item.id === itemId)) {
        return node.id;
      }
      const nested = findItemFolderId(node.children, itemId);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  function findItemInLibraryState(nodes: FolderNode[], nextTrashItems: LibraryItem[], id: string) {
    return findItem(nodes, id) ?? nextTrashItems.find((item) => item.id === id) ?? null;
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

  const persistRecentDocuments = useCallback((updater: (previous: RecentDocument[]) => RecentDocument[]) => {
    setRecentDocuments((previous) => {
      const next = updater(previous)
        .map((entry) => normalizeRecentDocumentEntry(entry))
        .filter((entry): entry is RecentDocument => Boolean(entry))
        .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
        .slice(0, MAX_RECENT_DOCUMENTS);

      void invoke("save_setting", {
        key: RECENT_DOCUMENTS_KEY,
        value: JSON.stringify(next),
      }).catch((error) => {
        console.error("Failed to persist recent documents:", error);
      });

      return next;
    });
  }, []);

  const touchRecentDocument = useCallback((item: LibraryItem, page: number) => {
    const entry = buildRecentDocument(item, page);
    persistRecentDocuments((previous) => [
      entry,
      ...previous.filter((candidate) => candidate.itemId !== item.id),
    ]);
  }, [persistRecentDocuments]);

  const removeRecentDocument = useCallback((itemId: string) => {
    persistRecentDocuments((previous) => previous.filter((entry) => entry.itemId !== itemId));
  }, [persistRecentDocuments]);

  const clearRecentDocuments = useCallback(() => {
    persistRecentDocuments(() => []);
  }, [persistRecentDocuments]);

  const replaceRecentDocument = useCallback((previousItemId: string, item: LibraryItem, page?: number) => {
    persistRecentDocuments((previous) => {
      const existing = previous.find((entry) => entry.itemId === previousItemId || entry.itemId === item.id);
      const nextEntry = buildRecentDocument(item, page ?? existing?.lastPage ?? 1);
      return [
        nextEntry,
        ...previous.filter((entry) => entry.itemId !== previousItemId && entry.itemId !== item.id),
      ];
    });
  }, [persistRecentDocuments]);

  const replaceRecentDocumentsByPrefix = useCallback((previousPrefix: string, nextPrefix: string) => {
    persistRecentDocuments((previous) => previous.map((entry) => {
      if (!pathHasPrefix(entry.itemId, previousPrefix)) {
        return entry;
      }

      return {
        ...entry,
        itemId: replacePathPrefix(entry.itemId, previousPrefix, nextPrefix),
      };
    }));
  }, [persistRecentDocuments]);

  const persistFavoriteItemIds = useCallback((updater: (previous: string[]) => string[]) => {
    setFavoriteItemIds((previous) => {
      const next = normalizeStringIdList(updater(previous));

      void invoke("save_setting", {
        key: FAVORITE_ITEM_IDS_KEY,
        value: JSON.stringify(next),
      }).catch((error) => {
        console.error("Failed to persist favorite items:", error);
      });

      return next;
    });
  }, []);

  const toggleFavoriteItem = useCallback((itemId: string) => {
    const normalizedItemId = itemId.trim();
    if (!normalizedItemId) {
      return;
    }

    persistFavoriteItemIds((previous) => (
      previous.includes(normalizedItemId)
        ? previous.filter((entry) => entry !== normalizedItemId)
        : [normalizedItemId, ...previous]
    ));
  }, [persistFavoriteItemIds]);

  const replaceFavoriteItemId = useCallback((previousItemId: string, nextItemId: string) => {
    const normalizedNextItemId = nextItemId.trim();
    if (!normalizedNextItemId) {
      return;
    }

    persistFavoriteItemIds((previous) => {
      if (!previous.includes(previousItemId)) {
        return previous;
      }
      const next = previous.map((entry) => entry === previousItemId ? normalizedNextItemId : entry);
      return next;
    });
  }, [persistFavoriteItemIds]);

  const replaceFavoriteItemsByPrefix = useCallback((previousPrefix: string, nextPrefix: string) => {
    persistFavoriteItemIds((previous) => previous.map((entry) => (
      pathHasPrefix(entry, previousPrefix)
        ? replacePathPrefix(entry, previousPrefix, nextPrefix)
        : entry
    )));
  }, [persistFavoriteItemIds]);

  const persistPageBookmarks = useCallback((updater: (previous: Record<string, PageBookmark[]>) => Record<string, PageBookmark[]>) => {
    setPageBookmarksByItemId((previous) => {
      const next = normalizePageBookmarksMap(updater(previous));

      void invoke("save_setting", {
        key: PAGE_BOOKMARKS_KEY,
        value: JSON.stringify(next),
      }).catch((error) => {
        console.error("Failed to persist page bookmarks:", error);
      });

      return next;
    });
  }, []);

  const persistSmartCollections = useCallback((updater: (previous: SmartCollection[]) => SmartCollection[]) => {
    setSmartCollections((previous) => {
      const next = updater(previous)
        .map((entry) => normalizeSmartCollection(entry))
        .filter((entry): entry is SmartCollection => Boolean(entry));

      void invoke("save_setting", {
        key: SMART_COLLECTIONS_KEY,
        value: JSON.stringify(next),
      }).catch((error) => {
        console.error("Failed to persist smart collections:", error);
      });

      return next;
    });
  }, []);

  const createSmartCollection = useCallback((input: Omit<SmartCollection, "id" | "createdAt" | "updatedAt">) => {
    const now = new Date().toISOString();
    const nextCollection: SmartCollection = {
      ...input,
      id: `smart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
    };

    persistSmartCollections((previous) => [...previous, nextCollection]);
    return nextCollection;
  }, [persistSmartCollections]);

  const updateSmartCollection = useCallback((collectionId: string, input: Omit<SmartCollection, "id" | "createdAt" | "updatedAt">) => {
    persistSmartCollections((previous) => previous.map((entry) => (
      entry.id === collectionId
        ? {
            ...entry,
            ...input,
            updatedAt: new Date().toISOString(),
          }
        : entry
    )));
  }, [persistSmartCollections]);

  const deleteSmartCollection = useCallback((collectionId: string) => {
    persistSmartCollections((previous) => previous.filter((entry) => entry.id !== collectionId));
    setSelectedFolderId((previous) => (
      parseSmartCollectionFolderId(previous) === collectionId
        ? DEFAULT_FOLDER.id
        : previous
    ));
  }, [persistSmartCollections]);

  const moveSmartCollection = useCallback((collectionId: string, direction: "up" | "down") => {
    persistSmartCollections((previous) => {
      const currentIndex = previous.findIndex((entry) => entry.id === collectionId);
      if (currentIndex === -1) {
        return previous;
      }

      const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      return moveListItem(previous, currentIndex, targetIndex);
    });
  }, [persistSmartCollections]);

  const togglePageBookmark = useCallback((itemId: string, page: number) => {
    const normalizedItemId = itemId.trim();
    const normalizedPage = clampRecentPage(page);
    if (!normalizedItemId) {
      return;
    }

    persistPageBookmarks((previous) => {
      const currentEntries = previous[normalizedItemId] ?? [];
      const nextEntries = currentEntries.some((entry) => entry.page === normalizedPage)
        ? currentEntries.filter((entry) => entry.page !== normalizedPage)
        : [...currentEntries, { page: normalizedPage, createdAt: new Date().toISOString() }];

      if (nextEntries.length === 0) {
        const { [normalizedItemId]: _removed, ...rest } = previous;
        return rest;
      }

      return {
        ...previous,
        [normalizedItemId]: nextEntries,
      };
    });
  }, [persistPageBookmarks]);

  const replacePageBookmarkItemId = useCallback((previousItemId: string, nextItemId: string) => {
    const normalizedNextItemId = nextItemId.trim();
    if (!normalizedNextItemId) {
      return;
    }

    persistPageBookmarks((previous) => {
      const currentEntries = previous[previousItemId];
      if (!currentEntries || currentEntries.length === 0) {
        return previous;
      }

      const existingNextEntries = previous[normalizedNextItemId] ?? [];
      const mergedEntries = [...existingNextEntries, ...currentEntries]
        .sort((left, right) => left.page - right.page || left.createdAt.localeCompare(right.createdAt))
        .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.page === entry.page) === index);

      const { [previousItemId]: _removed, ...rest } = previous;
      return {
        ...rest,
        [normalizedNextItemId]: mergedEntries,
      };
    });
  }, [persistPageBookmarks]);

  const replacePageBookmarksByPrefix = useCallback((previousPrefix: string, nextPrefix: string) => {
    persistPageBookmarks((previous) => (
      Object.fromEntries(
        Object.entries(previous).map(([itemId, bookmarks]) => [
          pathHasPrefix(itemId, previousPrefix)
            ? replacePathPrefix(itemId, previousPrefix, nextPrefix)
            : itemId,
          bookmarks,
        ]),
      )
    ));
  }, [persistPageBookmarks]);

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
      if (isVirtualFolderId(nextId)) {
        return nextId;
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

  useEffect(() => {
    let isMounted = true;

    (async () => {
      try {
        const settings = await invoke<StoredSetting[]>("get_settings");
        if (!isMounted) {
          return;
        }

        const recentSetting = settings.find((entry) => entry.key === RECENT_DOCUMENTS_KEY)?.value;
        const favoriteSetting = settings.find((entry) => entry.key === FAVORITE_ITEM_IDS_KEY)?.value;
        const pageBookmarksSetting = settings.find((entry) => entry.key === PAGE_BOOKMARKS_KEY)?.value;
        const smartCollectionsSetting = settings.find((entry) => entry.key === SMART_COLLECTIONS_KEY)?.value;
        setRecentDocuments(parseRecentDocuments(recentSetting));
        setFavoriteItemIds(parseStringIdList(favoriteSetting));
        setPageBookmarksByItemId(parsePageBookmarks(pageBookmarksSetting));
        setSmartCollections(parseSmartCollections(smartCollectionsSetting));
      } catch (error) {
        console.error("Failed to load recent documents:", error);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

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
    let unlistenMetadataUpdated: (() => void) | null = null;

    (async () => {
      unlistenOpen = await listen<CliOpenRequest>("cli-open-request", (event) => {
        void handleCliOpen(event.payload);
      });

      unlistenChanged = await listen<CliLibraryChangedPayload>("cli-library-changed", () => {
        void handleCliLibraryChanged();
      });

      unlistenMetadataUpdated = await listen<LibraryItemMetadataUpdatedPayload>("library-item-metadata-updated", () => {
        void handleItemUpdatedLocally();
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
      if (unlistenMetadataUpdated) unlistenMetadataUpdated();
    };
  }, []);

  useEffect(() => {
    if (!activeTabId || activeTabId === "library") {
      return;
    }

    const activeEntry = openTabs.find((tab) => tab.id === activeTabId);
    if (activeEntry) {
      touchRecentDocument(activeEntry.item, activeEntry.currentPage);
    }
  }, [activeTabId, touchRecentDocument]);

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

  const importIdentifier = async (
    identifier: string,
    folderIdOverride?: string | null,
    options?: { silent?: boolean },
  ) => {
    const trimmedIdentifier = identifier.trim();
    const isSilent = Boolean(options?.silent);
    if (!trimmedIdentifier) {
      if (!isSilent) {
        feedback.error({
          title: t("feedback.library.identifierImport.error.title"),
          description: t("feedback.library.identifierImport.error.description"),
        });
      }
      return null as IdentifierImportResult | null;
    }

    try {
      const preferredFolderId = folderIdOverride && folderIdOverride !== TRASH_FOLDER_ID
        ? folderIdOverride
        : selectedFolderId !== TRASH_FOLDER_ID
          ? selectedFolderId
          : folderTree[0]?.id ?? DEFAULT_FOLDER.id;
      const targetFolder = findFolder(folderTree, preferredFolderId) ?? folderTree[0];
      if (!targetFolder) return null;

      setIsLoading(true);
      const result = await invoke<IdentifierImportResult>("import_identifier_to_folder", {
        identifier: trimmedIdentifier,
        folderPath: targetFolder.path,
      });
      const refreshedTree = await refreshLibrary(targetFolder.id);
      const importedItem = findItem(refreshedTree, result.item.id) ?? result.item;
      const containingFolderId = findItemFolderId(refreshedTree, importedItem.id);
      if (containingFolderId) {
        setSelectedFolderId(containingFolderId);
      }
      setSelectedItemId(importedItem.id);

      if (!isSilent) {
        if (result.created) {
          feedback.success({
            title: t("feedback.library.identifierImport.success.title"),
            description: t("feedback.library.identifierImport.success.description", {
              title: importedItem.title || trimmedIdentifier,
            }),
          });
        } else {
          feedback.info({
            title: t("feedback.library.identifierImport.existing.title"),
            description: t("feedback.library.identifierImport.existing.description", {
              title: importedItem.title || trimmedIdentifier,
            }),
          });
        }
      }

      return {
        ...result,
        item: importedItem,
      };
    } catch (err) {
      console.error("Failed to import identifier", err);
      if (!isSilent) {
        feedback.error({
          title: t("feedback.library.identifierImport.error.title"),
          description: t("feedback.library.identifierImport.error.description"),
        });
      }
      return null as IdentifierImportResult | null;
    } finally {
      setIsLoading(false);
    }
  };

  const importReferenceFiles = async (paths: string[], folderIdOverride?: string | null) => {
    const normalizedPaths = Array.from(
      new Set(
        paths
          .map((path) => path.trim())
          .filter((path) => path && /\.(bib|bibtex|ris|json)$/i.test(path)),
      ),
    );

    if (normalizedPaths.length === 0) {
      feedback.error({
        title: t("feedback.library.referenceImport.error.title"),
        description: t("feedback.library.referenceImport.error.description"),
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

      const importedItems: LibraryItem[] = [];
      let createdCount = 0;
      let existingCount = 0;
      const sourceFormats = new Set<string>();

      for (const filePath of normalizedPaths) {
        const result = await invoke<ReferenceImportResult>("import_reference_file_to_folder", {
          filePath,
          folderPath: targetFolder.path,
        });
        importedItems.push(...result.items);
        createdCount += result.createdCount;
        existingCount += result.existingCount;
        sourceFormats.add(result.sourceFormat.toUpperCase());
      }

      const formatLabel = Array.from(sourceFormats).join(", ");

      const refreshedTree = await refreshLibrary(targetFolder.id);
      const resolvedItems = importedItems.map((item) => findItem(refreshedTree, item.id) ?? item);
      const focusedItem = resolvedItems[resolvedItems.length - 1] ?? null;
      if (focusedItem) {
        const containingFolderId = findItemFolderId(refreshedTree, focusedItem.id);
        if (containingFolderId) {
          setSelectedFolderId(containingFolderId);
        }
        setSelectedItemId(focusedItem.id);
      }

      if (createdCount > 0 && existingCount > 0) {
        feedback.success({
          title: t("feedback.library.referenceImport.success.title"),
          description: t("feedback.library.referenceImport.success.mixedDescription", {
            created: createdCount,
            existing: existingCount,
            format: formatLabel,
          }),
        });
      } else if (createdCount > 0) {
        feedback.success({
          title: t("feedback.library.referenceImport.success.title"),
          description: t("feedback.library.referenceImport.success.description", {
            count: createdCount,
            format: formatLabel,
          }),
        });
      } else {
        feedback.info({
          title: t("feedback.library.referenceImport.success.title"),
          description: t("feedback.library.referenceImport.success.existingDescription", {
            count: existingCount,
          }),
        });
      }

      return resolvedItems;
    } catch (error) {
      console.error("Failed to import reference files", error);
      feedback.error({
        title: t("feedback.library.referenceImport.error.title"),
        description: t("feedback.library.referenceImport.error.description"),
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
        multiple: true,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (typeof selected === "string") {
        await importPdfPaths([selected]);
      } else if (Array.isArray(selected) && selected.length > 0) {
        await importPdfPaths(selected);
      }
    } catch (err) {
      console.error("Failed to select PDF", err);
      feedback.error({
        title: t("feedback.library.import.error.title"),
        description: t("feedback.library.import.error.description"),
      });
    }
  };

  const handleAddReferenceFile = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "Reference Files", extensions: ["bib", "bibtex", "ris", "json"] }],
      });

      if (typeof selected === "string") {
        await importReferenceFiles([selected]);
      } else if (Array.isArray(selected) && selected.length > 0) {
        await importReferenceFiles(selected);
      }
    } catch (error) {
      console.error("Failed to select reference files", error);
      feedback.error({
        title: t("feedback.library.referenceImport.error.title"),
        description: t("feedback.library.referenceImport.error.description"),
      });
    }
  };

  const handleOpenItem = async (item: LibraryItem) => {
    const pdfPath = getPrimaryPdfPath(item);
    if (!pdfPath) {
      setSelectedItemId(item.id);
      feedback.info({
        title: t("feedback.library.openNoPdf.title"),
        description: t("feedback.library.openNoPdf.description"),
      });
      return;
    }

    const existingTab = openTabs.find((tab) => tab.id === item.id);
    if (existingTab) {
      setActiveTabId(item.id);
      touchRecentDocument(existingTab.item, existingTab.currentPage);
      return;
    }
    try {
      setIsLoading(true);
      const restoredPage = recentDocuments.find((entry) => entry.itemId === item.id)?.lastPage ?? 1;
      void preloadPdfCoreRuntime();
      void preloadPdfDocument(pdfPath);
      const pages: number = await invoke("load_pdf", { path: pdfPath });
      
      setOpenTabs(prev => [...prev, {
        id: item.id,
        item,
        totalPages: pages,
        dimensions: createPlaceholderDimensions(pages),
        currentPage: Math.min(restoredPage, pages)
      }]);
      setActiveTabId(item.id);
      touchRecentDocument(item, Math.min(restoredPage, pages));
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
      const activeTabSnapshot = openTabs.find((tab) => tab.id === activeTabId);
      setOpenTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, currentPage: page } : t));
      if (activeTabSnapshot) {
        touchRecentDocument(activeTabSnapshot.item, page);
      }
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
      removeRecentDocument(item.id);
      persistFavoriteItemIds((previous) => previous.filter((entry) => entry !== item.id));

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
      if (renamedPath !== item.id) {
        replaceRecentDocument(item.id, renamedItem);
        replaceFavoriteItemId(item.id, renamedItem.id);
        replacePageBookmarkItemId(item.id, renamedItem.id);
      }

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
      replaceRecentDocumentsByPrefix(folder.path, renamedPath);
      replaceFavoriteItemsByPrefix(folder.path, renamedPath);
      replacePageBookmarksByPrefix(folder.path, renamedPath);

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
      persistRecentDocuments((previous) => previous.filter((entry) => !pathHasPrefix(entry.itemId, folder.path)));
      persistFavoriteItemIds((previous) => previous.filter((entry) => !pathHasPrefix(entry, folder.path)));
      persistPageBookmarks((previous) => Object.fromEntries(
        Object.entries(previous).filter(([itemId]) => !pathHasPrefix(itemId, folder.path)),
      ));

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
      if (movedPath !== item.id) {
        replaceRecentDocument(item.id, movedItem);
        replaceFavoriteItemId(item.id, movedItem.id);
        replacePageBookmarkItemId(item.id, movedItem.id);
      }

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
  
  const handleItemUpdatedLocally = useEffectEvent(async () => {
       const [tree, nextTrashItems] = await Promise.all([
         invoke<FolderNode[]>("load_library_tree"),
         invoke<LibraryItem[]>("load_trash_items"),
       ]);
       setFolderTree(tree);
       setTrashItems(nextTrashItems);

       const rootId = tree[0]?.id ?? DEFAULT_FOLDER.id;
       setSelectedFolderId(prev => {
         if (isVirtualFolderId(prev)) {
           return prev;
         }
         return prev && findFolder(tree, prev) ? prev : rootId;
       });

       setOpenTabs((prevTabs) =>
         prevTabs.map((tab) => {
           const updatedItem = findItemInLibraryState(tree, nextTrashItems, tab.id);
           return updatedItem ? { ...tab, item: updatedItem } : tab;
         })
       );

       persistRecentDocuments((previous) => previous.filter((entry) => {
         const updatedItem = findItemInLibraryState(tree, nextTrashItems, entry.itemId);
         return Boolean(updatedItem) && !nextTrashItems.some((item) => item.id === entry.itemId);
       }));
       persistFavoriteItemIds((previous) => previous.filter((itemId) => Boolean(findItem(tree, itemId))));
       persistPageBookmarks((previous) => Object.fromEntries(
         Object.entries(previous).filter(([itemId]) => Boolean(findItemInLibraryState(tree, nextTrashItems, itemId))),
       ));

       if (selectedItemId) {
          const updatedSelectedItem = findItemInLibraryState(tree, nextTrashItems, selectedItemId);
          if (!updatedSelectedItem) {
            setSelectedItemId(null);
          }
       }
  });

  const handleRestoreTrashItem = async (item: LibraryItem) => {
    try {
      setIsLoading(true);
      const restoredPath: string = await invoke("restore_library_pdf", { path: item.id });
      const refreshedTree = await refreshLibrary(TRASH_FOLDER_ID);
      const restoredItem = findItem(refreshedTree, restoredPath) ?? createLibraryItem(restoredPath);
      replaceRecentDocument(item.id, restoredItem);
      replacePageBookmarkItemId(item.id, restoredItem.id);
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
      persistRecentDocuments((previous) => previous.filter((entry) => !trashItems.some((item) => item.id === entry.itemId)));
      persistPageBookmarks((previous) => Object.fromEntries(
        Object.entries(previous).filter(([itemId]) => !trashItems.some((item) => item.id === itemId)),
      ));
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

  const handleOpenRecentDocument = async (itemId: string) => {
    const existingItem = findItemInLibraryState(folderTree, trashItems, itemId);

    if (!existingItem || trashItems.some((item) => item.id === itemId)) {
      removeRecentDocument(itemId);
      return;
    }

    if (existingItem.folder_path && findFolder(folderTree, existingItem.folder_path)) {
      setSelectedFolderId(existingItem.folder_path);
    }
    setSelectedItemId(existingItem.id);
    await handleOpenItem(existingItem);
  };

  const mergeDuplicateGroup = async (group: DuplicateGroup, preferredItemId?: string) => {
    const duplicateItemIds = Array.from(new Set(
      group.items
        .map((item) => item.id.trim())
        .filter(Boolean),
    ));

    if (duplicateItemIds.length < 2) {
      return;
    }

    try {
      setIsLoading(true);
      const result = await invoke<MergeDuplicateItemsResult>("merge_duplicate_items", {
        primaryItemId: preferredItemId ?? duplicateItemIds[0],
        duplicateItemIds,
      });
      const refreshedTree = await refreshLibrary(selectedFolderId);
      const mergedItem = findItem(refreshedTree, result.item.id) ?? result.item;

      for (const mergedItemId of result.mergedItemIds) {
        replaceRecentDocument(mergedItemId, mergedItem);
        replaceFavoriteItemId(mergedItemId, mergedItem.id);
        replacePageBookmarkItemId(mergedItemId, mergedItem.id);
      }

      setOpenTabs((previous) => {
        const mergedIds = new Set(result.mergedItemIds);
        let survivorTabPresent = false;

        return previous.flatMap((tab) => {
          if (tab.id === mergedItem.id) {
            survivorTabPresent = true;
            return [{ ...tab, item: mergedItem }];
          }

          if (!mergedIds.has(tab.id)) {
            return [tab];
          }

          if (!survivorTabPresent) {
            survivorTabPresent = true;
            return [{ ...tab, id: mergedItem.id, item: mergedItem }];
          }

          return [];
        });
      });

      setSelectedItemId(mergedItem.id);
      setActiveTabId((previous) => {
        if (!previous) {
          return previous;
        }
        return result.mergedItemIds.includes(previous) ? mergedItem.id : previous;
      });

      feedback.success({
        title: t("feedback.library.item.mergeSuccess.title"),
        description: t("feedback.library.item.mergeSuccess.description", {
          title: mergedItem.title || mergedItem.attachments[0]?.name || trimmedFileName(mergedItem.id),
          count: duplicateItemIds.length,
        }),
      });
    } catch (error) {
      console.error("Failed to merge duplicate group", error);
      feedback.error({
        title: t("feedback.library.item.mergeError.title"),
        description: t("feedback.library.item.mergeError.description"),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const isFavoriteItem = useCallback((itemId: string) => favoriteItemIds.includes(itemId), [favoriteItemIds]);
  const getPageBookmarks = useCallback((itemId: string) => pageBookmarksByItemId[itemId] ?? [], [pageBookmarksByItemId]);
  const isPageBookmarked = useCallback((itemId: string, page: number) => (
    (pageBookmarksByItemId[itemId] ?? []).some((entry) => entry.page === page)
  ), [pageBookmarksByItemId]);

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
    recentDocuments,
    favoriteItemIds,
    favoriteDocuments,
    duplicateGroups,
    pageBookmarksByItemId,
    smartCollections,
    selectedFolderId,
    setSelectedFolderId,
    selectedItemId,
    setSelectedItemId,
    refreshLibrary,
    findItem,
    findFolder,
    handleAddItem,
    handleAddReferenceFile,
    importPdfPaths,
    importIdentifier,
    importReferenceFiles,
    handleOpenItem,
    handleOpenRecentDocument,
    removeRecentDocument,
    clearRecentDocuments,
    mergeDuplicateGroup,
    handleCloseTab,
    handlePageJump,
    updateCurrentPage,
    updatePageDimension,
    isFavoriteItem,
    toggleFavoriteItem,
    getPageBookmarks,
    isPageBookmarked,
    togglePageBookmark,
    getSmartCollectionPreviewItems,
    getSmartCollectionItems,
    createSmartCollection,
    updateSmartCollection,
    deleteSmartCollection,
    moveSmartCollection,
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
