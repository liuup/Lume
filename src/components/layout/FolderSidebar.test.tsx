import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FolderSidebar } from "./FolderSidebar";
import type { FolderNode, LibraryItem, SmartCollectionDraft } from "../../types";

vi.mock("../../hooks/useI18n", () => ({
  useI18n: () => ({
    t: (_key: string, params?: Record<string, string | number>, fallback?: string) => {
      if (fallback) {
        return fallback;
      }

      if (_key === "folderSidebar.smartCollections.create") {
        return "Create smart collection";
      }

      if (_key === "folderSidebar.smartCollections.moveUp") {
        return "Move up";
      }

      if (_key === "folderSidebar.smartCollections.moveDown") {
        return "Move down";
      }

      if (_key === "folderSidebar.smartCollections.dialog.namePlaceholder") {
        return "Example: NeurIPS favorites";
      }

      if (_key === "folderSidebar.smartCollections.dialog.queryPlaceholder") {
        return "title, authors, DOI, abstract...";
      }

      if (_key === "folderSidebar.recents.clear") {
        return "Clear all";
      }

      if (_key === "folderSidebar.recents.remove") {
        return "Remove from recent";
      }

      if (_key === "folderSidebar.favorites.remove") {
        return "Remove from favorites";
      }

      if (_key === "folderSidebar.tags.searchPlaceholder") {
        return "Filter tags";
      }

      if (_key === "folderSidebar.tags.emptySearch") {
        return "No tags match this filter.";
      }

      if (_key === "folderSidebar.tags.collapse") {
        return "Hide tags";
      }

      if (_key === "folderSidebar.tags.expand") {
        return "Show tags";
      }

      if (_key === "folderSidebar.smartCollections.dialog.preview.matches") {
        return `${params?.count ?? 0} matches`;
      }

      if (_key === "folderSidebar.smartCollections.dialog.preview.more") {
        return `${params?.count ?? 0} more`;
      }

      if (_key === "folderSidebar.smartCollections.count") {
        return String(params?.count ?? 0);
      }

      const parts = _key.split(".");
      return parts[parts.length - 1] ?? _key;
    },
  }),
}));

const itemA: LibraryItem = {
  id: "paper-1",
  item_type: "Journal Article",
  title: "Attention Is All You Need",
  authors: "Vaswani, Shazeer",
  year: "2017",
  abstract: "",
  doi: "",
  arxiv_id: "",
  publication: "NeurIPS",
  volume: "",
  issue: "",
  pages: "",
  publisher: "",
  isbn: "",
  url: "",
  language: "",
  date_added: "1710000000",
  date_modified: "1710000000",
  folder_path: "root",
  tags: ["transformer"],
  attachments: [],
};

const itemB: LibraryItem = {
  ...itemA,
  id: "paper-2",
  title: "Scaling Laws for Neural Language Models",
  authors: "Kaplan, McCandlish",
  year: "2020",
};

const rootFolder: FolderNode = {
  id: "root",
  name: "My Library",
  path: "",
  children: [],
  items: [itemA, itemB],
};

function createSmartCollectionPreviewItems(collection: SmartCollectionDraft | null | undefined) {
  if (!collection) {
    return [];
  }

  if (collection.query.toLowerCase().includes("attention")) {
    return [itemA, itemB];
  }

  if (collection.tags.includes("transformer")) {
    return [itemA];
  }

  return [];
}

function renderSidebar(overrides: Partial<ComponentProps<typeof FolderSidebar>> = {}) {
  return render(
    <FolderSidebar
      folderTree={[rootFolder]}
      isCollapsed={false}
      onToggleCollapse={() => undefined}
      selectedFolderId="root"
      onSelectFolder={() => undefined}
      trashCount={0}
      onAddFolder={async () => undefined}
      onRenameFolder={() => undefined}
      onDeleteFolder={() => undefined}
      draggedItemId={null}
      dragOverFolderId={null}
      onFolderHover={() => undefined}
      recentDocuments={[]}
      onOpenRecentDocument={() => undefined}
      onRemoveRecentDocument={() => undefined}
      onClearRecentDocuments={() => undefined}
      favoriteDocuments={[]}
      onOpenFavoriteDocument={() => undefined}
      onRemoveFavoriteDocument={() => undefined}
      duplicateGroups={[]}
      isDuplicatesSelected={false}
      onSelectDuplicates={() => undefined}
      smartCollections={[
        {
          id: "smart-1",
          name: "Transformers",
          query: "",
          year: "",
          tags: ["transformer"],
          favoritesOnly: false,
          matchMode: "all",
          createdAt: "2026-03-25T00:00:00Z",
          updatedAt: "2026-03-25T00:00:00Z",
        },
      ]}
      selectedSmartCollectionId={null}
      onSelectSmartCollection={() => undefined}
      onCreateSmartCollection={() => undefined}
      onUpdateSmartCollection={() => undefined}
      onDeleteSmartCollection={() => undefined}
      onMoveSmartCollection={() => undefined}
      getSmartCollectionPreviewItems={createSmartCollectionPreviewItems}
      allTags={[]}
      selectedTagFilter={null}
      onSelectTag={() => undefined}
      onSetTagColor={async () => undefined}
      onOpenSettings={() => undefined}
      {...overrides}
    />
  );
}

describe("FolderSidebar", () => {
  it("shows match counts for existing smart collections", () => {
    renderSidebar();

    const collectionButton = screen.getByTitle("Transformers");
    const row = collectionButton.closest(".group");

    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  it("shows a live preview while creating a smart collection", () => {
    renderSidebar();

    fireEvent.click(screen.getByTitle("Create smart collection"));
    fireEvent.change(screen.getByPlaceholderText("Example: NeurIPS favorites"), {
      target: { value: "Attention papers" },
    });
    fireEvent.change(screen.getByPlaceholderText("title, authors, DOI, abstract..."), {
      target: { value: "attention" },
    });

    expect(screen.getByText("Live Preview")).toBeInTheDocument();
    expect(screen.getByText("2 matches")).toBeInTheDocument();
    expect(screen.getByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText("Scaling Laws for Neural Language Models")).toBeInTheDocument();
  });

  it("emits reorder actions for smart collections", () => {
    const onMoveSmartCollection = vi.fn();

    renderSidebar({
      smartCollections: [
        {
          id: "smart-1",
          name: "Alpha",
          query: "",
          year: "",
          tags: [],
          favoritesOnly: false,
          matchMode: "all",
          createdAt: "2026-03-25T00:00:00Z",
          updatedAt: "2026-03-25T00:00:00Z",
        },
        {
          id: "smart-2",
          name: "Beta",
          query: "",
          year: "",
          tags: [],
          favoritesOnly: false,
          matchMode: "all",
          createdAt: "2026-03-25T00:00:00Z",
          updatedAt: "2026-03-25T00:00:00Z",
        },
      ],
      onMoveSmartCollection,
    });

    const moveUpButtons = screen.getAllByTitle("Move up");
    const moveDownButtons = screen.getAllByTitle("Move down");

    expect(moveUpButtons[0]).toBeDisabled();
    expect(moveDownButtons[1]).toBeDisabled();

    fireEvent.click(moveDownButtons[0]);
    fireEvent.click(moveUpButtons[1]);

    expect(onMoveSmartCollection).toHaveBeenNthCalledWith(1, "smart-1", "down");
    expect(onMoveSmartCollection).toHaveBeenNthCalledWith(2, "smart-2", "up");
  });

  it("allows removing one recent document and clearing the list", () => {
    const onOpenRecentDocument = vi.fn();
    const onRemoveRecentDocument = vi.fn();
    const onClearRecentDocuments = vi.fn();

    renderSidebar({
      recentDocuments: [
        {
          itemId: "paper-1",
          title: "Attention Is All You Need",
          subtitle: "NeurIPS 2017",
          lastPage: 9,
          lastOpenedAt: "2026-03-25T12:00:00Z",
        },
      ],
      onOpenRecentDocument,
      onRemoveRecentDocument,
      onClearRecentDocuments,
    });

    fireEvent.click(screen.getByTitle("Attention Is All You Need"));
    expect(onOpenRecentDocument).toHaveBeenCalledWith("paper-1");

    fireEvent.click(screen.getByTitle("Remove from recent"));
    expect(onRemoveRecentDocument).toHaveBeenCalledWith("paper-1");

    fireEvent.click(screen.getByTitle("Clear all"));
    expect(onClearRecentDocuments).toHaveBeenCalledTimes(1);
  });

  it("allows removing a favorite directly from the sidebar", () => {
    const onOpenFavoriteDocument = vi.fn();
    const onRemoveFavoriteDocument = vi.fn();

    renderSidebar({
      favoriteDocuments: [itemA],
      onOpenFavoriteDocument,
      onRemoveFavoriteDocument,
    });

    fireEvent.click(screen.getByTitle("Attention Is All You Need"));
    expect(onOpenFavoriteDocument).toHaveBeenCalledWith("paper-1");

    fireEvent.click(screen.getByTitle("Remove from favorites"));
    expect(onRemoveFavoriteDocument).toHaveBeenCalledWith("paper-1");
  });

  it("filters visible tags from the search field", () => {
    renderSidebar({
      allTags: [
        { tag: "transformer", count: 3, color: "" },
        { tag: "vision", count: 1, color: "" },
      ],
    });

    fireEvent.change(screen.getByPlaceholderText("Filter tags"), {
      target: { value: "trans" },
    });

    expect(screen.getByText("transformer")).toBeInTheDocument();
    expect(screen.queryByText("vision")).not.toBeInTheDocument();
  });

  it("supports collapsing the tags section", () => {
    renderSidebar({
      allTags: [
        { tag: "transformer", count: 3, color: "" },
      ],
    });

    fireEvent.click(screen.getByTitle("Hide tags"));
    expect(screen.queryByPlaceholderText("Filter tags")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Show tags"));
    expect(screen.getByPlaceholderText("Filter tags")).toBeInTheDocument();
  });
});
