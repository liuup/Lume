import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LibraryView } from "./LibraryView";
import type { FolderNode, LibraryItem } from "../../types";

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

const folderTree: FolderNode[] = [{
  id: "root",
  name: "My Library",
  path: "root",
  children: [],
  items: [item],
}];

describe("LibraryView", () => {
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
});
