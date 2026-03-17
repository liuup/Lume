/**
 * Module: src/types/index.ts
 * Purpose: Defines all shared TypeScript interfaces and foundational data structures representing the application state and domain models.
 * Capabilities:
 *  - Provides standard structures for Library Items, Attachments, and Folders.
 *  - Defines UI-specific types like ToolType, PageDimension, and OpenTab configurations.
 * Context: Extracted from monolithic App.tsx to ensure clear, reusable type boundaries across components.
 */

export type PageDimension = { width: number; height: number };
export type ToolType = 'none' | 'draw' | 'highlight' | 'text-highlight' | 'eraser';

export interface SearchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfSearchMatch {
  pageIndex: number;
  rects: SearchRect[];
}

export interface Attachment {
  id: string;
  item_id: string;
  name: string;
  path: string;
  attachment_type: string;
}

export interface LibraryItem {
  id: string;
  item_type: string;
  title: string;
  authors: string;
  year: string;
  abstract: string;
  doi: string;
  arxiv_id: string;
  publication: string;
  volume: string;
  issue: string;
  pages: string;
  publisher: string;
  isbn: string;
  url: string;
  language: string;
  date_added: string;
  date_modified: string;
  folder_path: string;
  tags: string[];
  attachments: Attachment[];
}

export interface FolderNode {
  id: string;
  name: string;
  path: string;
  children: FolderNode[];
  items: LibraryItem[];
}

export const DEFAULT_FOLDER: FolderNode = {
  id: "root",
  name: "My Library",
  path: "",
  children: [],
  items: [],
};

export const TRASH_FOLDER_ID = "__trash__";

export interface OpenTab {
  id: string;
  item: LibraryItem;
  totalPages: number;
  dimensions: PageDimension[];
  currentPage: number;
}

/** A tag in the library with its usage count and optional display color. */
export interface TagInfo {
  tag: string;
  count: number;
  /** Hex color string, e.g. '#6366f1'. Empty string means use the default color. */
  color: string;
}

export interface SavedAnnotationPoint {
  x: number;
  y: number;
}

export interface SavedAnnotationPath {
  tool: ToolType;
  points: SavedAnnotationPoint[];
}

export interface SavedTextAnnotation {
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

export interface SavedPdfPageAnnotations {
  paths: SavedAnnotationPath[];
  textAnnotations: SavedTextAnnotation[];
}

export interface SavedPdfAnnotationsDocument {
  version: number;
  pages: Record<string, SavedPdfPageAnnotations>;
}

export interface AiDigestEntry {
  page: number;
  text: string;
  reason: string;
}

export interface AiDigestSection {
  id: string;
  title: string;
  summary: string;
  entries: AiDigestEntry[];
}

export interface AiAnnotationDigestStats {
  textAnnotations: number;
  highlightStrokes: number;
  inkStrokes: number;
}

export interface AiAnnotationDigest {
  overview: string;
  coverageNote: string;
  limitations: string;
  stats: AiAnnotationDigestStats;
  sections: AiDigestSection[];
  markdown: string;
}

export interface AiPaperSummary {
  title: string;
  summary: string;
  keyPoints: string[];
  limitations: string[];
  language: string;
  sourceExcerpt: string;
}

export interface AiTranslationResult {
  translation: string;
  sourceLanguageHint: string;
  targetLanguage: string;
  originalText: string;
}

export interface CliOpenRequest {
  target: string;
  source: string;
  focus: boolean;
}

export interface CliLibraryChangedPayload {
  reason: string;
}
