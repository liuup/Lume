import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryView } from "./LibraryView";
import type { DuplicateGroup, FolderNode, LibraryItem } from "../../types";
import { SORT_PREFERENCES_STORAGE_KEY } from "./libraryViewUtils";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../../hooks/useI18n", () => ({
  useI18n: () => ({
    t: (_key: string, _params?: Record<string, string | number>, fallback?: string) => {
      const parts = _key.split(".");
      return fallback ?? parts[parts.length - 1] ?? _key;
    },
  }),
}));

vi.mock("./ExportModal", () => ({
  ExportModal: () => null,
}));

const item: LibraryItem = {
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
  tags: [],
  attachments: [{
    id: "att-1",
    item_id: "paper-1",
    name: "Attention Is All You Need",
    path: "/tmp/paper.pdf",
    attachment_type: "PDF",
  }],
};

const secondItem: LibraryItem = {
  ...item,
  id: "paper-2",
  title: "Scaling Laws for Neural Language Models",
  authors: "Kaplan, McCandlish",
  year: "2020",
  publication: "arXiv",
  date_added: "1720000000",
  attachments: [{
    id: "att-2",
    item_id: "paper-2",
    name: "Scaling Laws for Neural Language Models",
    path: "/tmp/scaling-laws.pdf",
    attachment_type: "PDF",
  }],
};

const folderTree: FolderNode[] = [{
  id: "root",
  name: "My Library",
  path: "root",
  children: [],
  items: [item, secondItem],
}];

const originalLocalStorage = window.localStorage;

function installLocalStorageMock(initialEntries: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialEntries));
  const getItem = vi.fn((key: string) => store.get(key) ?? null);
  const setItem = vi.fn((key: string, value: string) => {
    store.set(key, value);
  });
  const removeItem = vi.fn((key: string) => {
    store.delete(key);
  });
  const clear = vi.fn(() => {
    store.clear();
  });

  const storage = {
    get length() {
      return store.size;
    },
    clear,
    getItem,
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem,
    setItem,
  } satisfies Storage;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });

  return { storage, getItem, setItem, store };
}

describe("LibraryView", () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  afterEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it("shows a header context menu and keeps title visible", async () => {
    render(
      <LibraryView
        folderTree={folderTree}
        trashItems={[]}
        isTrashView={false}
        selectedFolderId="root"
        selectedItemId={null}
        onSelectItem={() => undefined}
        onOpenItem={() => undefined}
        onAddItem={() => undefined}
        onDeleteItem={() => undefined}
        onRestoreItem={() => undefined}
        onEmptyTrash={() => undefined}
        onRenameItem={() => undefined}
        onUpdateItemTags={() => undefined}
        onItemPointerDown={() => undefined}
        tagFilter={null}
        onClearTagFilter={() => undefined}
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /^title$/i }));

    const menuTitle = await screen.findByText("Visible Columns");
    expect(menuTitle).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();

    const menu = menuTitle.parentElement;
    expect(menu).not.toBeNull();

    fireEvent.click(within(menu as HTMLElement).getByRole("button", { name: /authors/i }));

    await waitFor(() => {
      expect(screen.queryByText("Authors")).not.toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /^title$/i })).toBeInTheDocument();
    expect(screen.getByText("Attention Is All You Need")).toBeInTheDocument();
  });

  it("renders even when localStorage is unavailable for writes", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
      },
    });

    render(
      <LibraryView
        folderTree={folderTree}
        trashItems={[]}
        isTrashView={false}
        selectedFolderId="root"
        selectedItemId={null}
        onSelectItem={() => undefined}
        onOpenItem={() => undefined}
        onAddItem={() => undefined}
        onDeleteItem={() => undefined}
        onRestoreItem={() => undefined}
        onEmptyTrash={() => undefined}
        onRenameItem={() => undefined}
        onUpdateItemTags={() => undefined}
        onItemPointerDown={() => undefined}
        tagFilter={null}
        onClearTagFilter={() => undefined}
      />
    );

    expect(screen.getByText("Attention Is All You Need")).toBeInTheDocument();
  });

  it("renders duplicate groups and triggers merge", async () => {
    const onMergeDuplicateGroup = vi.fn(async () => undefined);
    const duplicateGroups: DuplicateGroup[] = [
      {
        id: "dup-1",
        reason: "metadata",
        matchValue: "attention is all you need | vaswani | 2017",
        items: [
          item,
          {
            ...item,
            id: "paper-2",
            attachments: [],
          },
        ],
      },
    ];

    render(
      <LibraryView
        folderTree={folderTree}
        trashItems={[]}
        isTrashView={false}
        isDuplicatesView
        duplicateGroups={duplicateGroups}
        selectedFolderId="__duplicates__"
        selectedItemId={null}
        onSelectItem={() => undefined}
        onOpenItem={() => undefined}
        onAddItem={() => undefined}
        onMergeDuplicateGroup={onMergeDuplicateGroup}
        onDeleteItem={() => undefined}
        onRestoreItem={() => undefined}
        onEmptyTrash={() => undefined}
        onRenameItem={() => undefined}
        onUpdateItemTags={() => undefined}
        onItemPointerDown={() => undefined}
        tagFilter={null}
        onClearTagFilter={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /merge group/i }));

    await waitFor(() => {
      expect(onMergeDuplicateGroup).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/metadata only/i)).toBeInTheDocument();
  });

  it("splits batch DOI/arXiv imports into multiple requests", async () => {
    const onAddIdentifier = vi.fn(async () => ({
      item,
      created: true,
      matchedBy: "none",
    }));

    render(
      <LibraryView
        folderTree={folderTree}
        trashItems={[]}
        isTrashView={false}
        selectedFolderId="root"
        selectedItemId={null}
        onSelectItem={() => undefined}
        onOpenItem={() => undefined}
        onAddItem={() => undefined}
        onAddIdentifier={onAddIdentifier}
        onDeleteItem={() => undefined}
        onRestoreItem={() => undefined}
        onEmptyTrash={() => undefined}
        onRenameItem={() => undefined}
        onUpdateItemTags={() => undefined}
        onItemPointerDown={() => undefined}
        tagFilter={null}
        onClearTagFilter={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /add doi \/ arxiv/i }));

    fireEvent.change(screen.getByPlaceholderText(/10\.48550\/arxiv\.1706\.03762/i), {
      target: {
        value: "10.48550/arXiv.1706.03762\n1706.03762",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));

    await waitFor(() => {
      expect(onAddIdentifier).toHaveBeenCalledTimes(2);
    });
    expect(onAddIdentifier).toHaveBeenNthCalledWith(1, "10.48550/arXiv.1706.03762", { silent: true });
    expect(onAddIdentifier).toHaveBeenNthCalledWith(2, "1706.03762", { silent: true });
  });

  it("restores persisted sort preferences and updates them when toggled", () => {
    const { setItem } = installLocalStorageMock({
      [SORT_PREFERENCES_STORAGE_KEY]: JSON.stringify({ column: "year", direction: "asc" }),
    });

    const { container } = render(
      <LibraryView
        folderTree={folderTree}
        trashItems={[]}
        isTrashView={false}
        selectedFolderId="root"
        selectedItemId={null}
        onSelectItem={() => undefined}
        onOpenItem={() => undefined}
        onAddItem={() => undefined}
        onDeleteItem={() => undefined}
        onRestoreItem={() => undefined}
        onEmptyTrash={() => undefined}
        onRenameItem={() => undefined}
        onUpdateItemTags={() => undefined}
        onItemPointerDown={() => undefined}
        tagFilter={null}
        onClearTagFilter={() => undefined}
      />
    );

    const titleNodes = Array.from(container.querySelectorAll(".library-item-title"));
    expect(titleNodes.map((node) => node.textContent)).toEqual([
      "Attention Is All You Need",
      "Scaling Laws for Neural Language Models",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^year$/i }));

    expect(setItem).toHaveBeenCalledWith(
      SORT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ column: "year", direction: "desc" }),
    );
  });
});
