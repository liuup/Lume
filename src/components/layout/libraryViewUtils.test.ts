import { describe, expect, it } from "vitest";
import {
  clampColumnWidth,
  DEFAULT_SORT_PREFERENCES,
  formatDateLabel,
  getMetadataHealth,
  getResponsiveColumns,
  getVisibleColumns,
  normalizeColumnVisibility,
  normalizeColumnWidths,
  normalizeSortPreferences,
} from "./libraryViewUtils";

describe("libraryViewUtils", () => {
  it("keeps the title column always visible", () => {
    expect(normalizeColumnVisibility({ title: false, authors: false }).title).toBe(true);
    expect(getVisibleColumns(["title", "authors", "year"], normalizeColumnVisibility({ authors: false }))).toEqual(["title", "year"]);
  });

  it("clamps saved widths into allowed ranges", () => {
    const widths = normalizeColumnWidths({ title: 999, year: 1 });
    expect(widths.title).toBe(560);
    expect(widths.year).toBe(56);
    expect(clampColumnWidth("authors", 140)).toBe(140);
  });

  it("applies responsive column presets by viewport width", () => {
    expect(getResponsiveColumns(680)).toEqual(["title", "year"]);
    expect(getResponsiveColumns(880)).toEqual(["title", "authors", "year"]);
    expect(getResponsiveColumns(1040)).toEqual(["title", "authors", "year", "publication"]);
    expect(getResponsiveColumns(1280)).toEqual(["title", "authors", "year", "publication", "dateAdded"]);
  });

  it("normalizes persisted sort preferences", () => {
    expect(normalizeSortPreferences({ column: "year", direction: "asc" })).toEqual({
      column: "year",
      direction: "asc",
    });
    expect(normalizeSortPreferences({ column: "unknown", direction: "sideways" })).toEqual(DEFAULT_SORT_PREFERENCES);
    expect(normalizeSortPreferences(null)).toEqual(DEFAULT_SORT_PREFERENCES);
  });

  it("formats numeric timestamps and keeps invalid values readable", () => {
    expect(formatDateLabel("1710000000")).not.toBe("1710000000");
    expect(formatDateLabel("not-a-date")).toBe("not-a-date");
    expect(formatDateLabel("")).toBe("—");
  });

  it("marks items with missing core metadata for review", () => {
    expect(getMetadataHealth({
      title: "Attention Is All You Need",
      authors: "Vaswani et al.",
      year: "2017",
      publication: "NeurIPS",
    })).toEqual({
      missingFields: [],
      missingFieldCount: 0,
      status: "complete",
    });

    expect(getMetadataHealth({
      title: "Untitled import",
      authors: "",
      year: "",
      publication: "",
      doi: "",
      arxiv_id: "",
      url: "",
    })).toEqual({
      missingFields: ["authors", "year", "source"],
      missingFieldCount: 3,
      status: "needsReview",
    });
  });
});
