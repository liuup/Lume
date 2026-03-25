import type { ReactNode } from "react";

export type SortColumn = "title" | "authors" | "year" | "publication" | "dateAdded";
export type SortDirection = "asc" | "desc";
export type ColumnWidthMap = Record<SortColumn, number>;
export type ColumnVisibilityMap = Record<SortColumn, boolean>;
export type SortPreferences = {
  column: SortColumn;
  direction: SortDirection;
};

export const COLUMN_WIDTH_STORAGE_KEY = "lume.library.column-widths";
export const COLUMN_VISIBILITY_STORAGE_KEY = "lume.library.column-visibility";
export const SORT_PREFERENCES_STORAGE_KEY = "lume.library.sort-preferences";
export const DEFAULT_COLUMN_WIDTHS: ColumnWidthMap = {
  title: 260,
  authors: 150,
  year: 72,
  publication: 170,
  dateAdded: 116,
};
export const DEFAULT_SORT_PREFERENCES: SortPreferences = {
  column: "dateAdded",
  direction: "desc",
};
export const MIN_COLUMN_WIDTHS: ColumnWidthMap = {
  title: 180,
  authors: 110,
  year: 56,
  publication: 120,
  dateAdded: 96,
};
export const MAX_COLUMN_WIDTHS: ColumnWidthMap = {
  title: 560,
  authors: 360,
  year: 120,
  publication: 420,
  dateAdded: 180,
};
export const COLUMN_ORDER: SortColumn[] = ["title", "authors", "year", "publication", "dateAdded"];
export const DEFAULT_COLUMN_VISIBILITY: ColumnVisibilityMap = {
  title: true,
  authors: true,
  year: true,
  publication: true,
  dateAdded: true,
};

export function highlightText(text: string, query: string): ReactNode {
  if (!query.trim() || !text) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return [
    text.slice(0, idx),
    text.slice(idx, idx + query.length),
    highlightText(text.slice(idx + query.length), query),
  ];
}

export function formatDateLabel(value: string) {
  const numeric = Number(value);
  const asDate = !Number.isNaN(numeric) && numeric > 0
    ? new Date(numeric * 1000)
    : new Date(value);

  if (Number.isNaN(asDate.getTime())) {
    return value || "—";
  }

  return asDate.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function clampColumnWidth(column: SortColumn, width: number) {
  return Math.max(MIN_COLUMN_WIDTHS[column], Math.min(MAX_COLUMN_WIDTHS[column], Math.round(width)));
}

export function normalizeColumnWidths(value: unknown): ColumnWidthMap {
  const fallback = { ...DEFAULT_COLUMN_WIDTHS };
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const next = { ...fallback };
  for (const column of COLUMN_ORDER) {
    const raw = (value as Record<string, unknown>)[column];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      next[column] = clampColumnWidth(column, raw);
    }
  }
  return next;
}

export function normalizeColumnVisibility(value: unknown): ColumnVisibilityMap {
  const fallback = { ...DEFAULT_COLUMN_VISIBILITY };
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const next = { ...fallback };
  for (const column of COLUMN_ORDER) {
    if (column === "title") {
      next[column] = true;
      continue;
    }

    const raw = (value as Record<string, unknown>)[column];
    if (typeof raw === "boolean") {
      next[column] = raw;
    }
  }

  next.title = true;
  return next;
}

export function normalizeSortColumn(value: unknown): SortColumn {
  return typeof value === "string" && COLUMN_ORDER.includes(value as SortColumn)
    ? value as SortColumn
    : DEFAULT_SORT_PREFERENCES.column;
}

export function normalizeSortDirection(value: unknown): SortDirection {
  return value === "asc" || value === "desc"
    ? value
    : DEFAULT_SORT_PREFERENCES.direction;
}

export function normalizeSortPreferences(value: unknown): SortPreferences {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_SORT_PREFERENCES };
  }

  const candidate = value as Record<string, unknown>;
  return {
    column: normalizeSortColumn(candidate.column),
    direction: normalizeSortDirection(candidate.direction),
  };
}

export function getResponsiveColumns(listViewportWidth: number): SortColumn[] {
  if (listViewportWidth <= 0) {
    return COLUMN_ORDER;
  }

  if (listViewportWidth < 720) {
    return ["title", "year"];
  }

  if (listViewportWidth < 900) {
    return ["title", "authors", "year"];
  }

  if (listViewportWidth < 1080) {
    return ["title", "authors", "year", "publication"];
  }

  return COLUMN_ORDER;
}

export function getVisibleColumns(
  responsiveColumns: SortColumn[],
  columnVisibility: ColumnVisibilityMap,
): SortColumn[] {
  return responsiveColumns.filter((column) => column === "title" || columnVisibility[column]);
}
