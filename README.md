# Lume

[English](README.md) | [中文](README.zh-CN.md)

> [!WARNING]
> Lume is still a prototype. Expect bugs, rough edges, and breaking changes in both data flow and UX.

Lume is a local-first desktop app for reading and organizing academic PDFs. It combines a paper library, reader, annotations, notes, metadata enrichment, translation, AI summaries, and citation export in one Tauri application.

## What It Does Today

- Local library with folders, subfolders, trash, rename, move, and search
- PDF import from file picker and drag-and-drop into the app window
- Multi-tab reading with lazy page loading, zoom presets, and in-document search
- Local annotations stored alongside PDFs and paper-level Markdown notes
- Metadata extraction from the PDF itself, then remote enrichment via arXiv, Crossref, and OpenAlex
- Metadata trace/report so you can inspect which provider filled which fields
- Citation generation and export
- Selection translation with `google`, `bing` web, or `llm`
- AI paper summary and annotation digest
- Native CLI for listing, searching, exporting, tagging, and opening items

## Current Architecture

### Frontend

- `React 19 + TypeScript + Vite`
- `Tailwind CSS` for styling
- `src/App.tsx` orchestrates the shell layout, drag-drop import, tabs, reader panels, and library interactions
- State is split into focused hooks:
  - `useLibrary` for library actions and Tauri command calls
  - `useSettings` for persisted settings and theme/font application
  - `useFeedback` for toast notifications
  - `useI18n` for runtime locale loading

### Backend

- `Tauri v2 + Rust`
- `src-tauri/src/lib.rs` wires shared app state, plugins, CLI IPC, and command registration
- `src-tauri/src/library_commands.rs` owns library CRUD, search, notes, tags, export, translation, annotation sidecars, and settings persistence
- `src-tauri/src/metadata_fetch.rs` owns metadata parsing, provider orchestration, retries, caching, merge policy, and fetch reports
- `src-tauri/src/pdf_handlers.rs` owns PDFium-backed page rendering, text extraction, selection rects, and PDF-derived metadata hints
- `src-tauri/src/cli.rs` and `src-tauri/src/cli_ipc.rs` implement the native CLI and single-instance handoff to the GUI

### PDF Pipeline

Lume currently uses a hybrid PDF stack:

- `pdfium-render` in Rust for raster rendering, text extraction, text-rect lookup, and metadata hints
- `pdfjs-dist` in the frontend for document/page caching and warmup

So the project is no longer accurately described as a pure “PDFium app” or a pure “PDF.js app”; both are part of the current runtime.

### Storage Model

Application data lives under Tauri `app_data_dir()`:

- `library/` for imported PDFs
- `trash/` for soft-deleted PDFs
- `lume_library.db` for SQLite-backed items, attachments, notes, tags, settings, and caches
- per-PDF annotation sidecars stored next to the imported file as `.<filename>.Lume-annotations.json`

The app is local-first: imported files are copied into Lume-managed storage instead of being referenced in place.

## Metadata Retrieval Flow

Lume’s current metadata flow is modeled as a staged pipeline rather than a single lookup:

1. Parse candidate title/authors/year/DOI/arXiv ID directly from the PDF.
2. Run exact identifier lookups first (`arXiv ID`, `Crossref DOI`, `OpenAlex DOI`).
3. If metadata is still incomplete, run fuzzy title searches (`OpenAlex`, `Crossref`, `arXiv`) with title variants plus author/year scoring.
4. Merge results field-by-field with provider priority and preprint-aware rules.
5. Cache the result and persist a metadata fetch report for later inspection in the UI.

This is designed to improve noisy PDF imports and avoid letting preprint metadata overwrite a confirmed venue/publication result.

## AI and Translation

- AI summaries and LLM translation use a user-configured OpenAI-compatible completion endpoint
- Non-LLM selection translation can use:
  - `google` via the public web endpoint
  - `bing` via the Bing Translator web flow
- `llm` translation requires the AI endpoint settings to be configured

## Quick Start

### Local Development

```bash
npm install
npm run tauri dev
```

### CLI

Examples:

```bash
Lume list
Lume list --json
Lume search "transformer" --json
Lume export --format bibtex -o refs.bib
Lume open /absolute/path/to/paper.pdf
```

During development:

```bash
npm run cli:list
```

### Build

```bash
npm run tauri build
```

Detailed packaging and release notes are in [docs/build-and-release-guide.md](docs/build-and-release-guide.md).

## Tech Stack

- Desktop shell: `Tauri v2`
- Frontend: `React 19`, `TypeScript`, `Vite`
- Styling: `Tailwind CSS`
- Backend: `Rust`
- Database: `SQLite` via `rusqlite`
- PDF engines: `pdfium-render` and `pdfjs-dist`
- Network metadata sources: `arXiv`, `Crossref`, `OpenAlex`

## Project Status

The app is moving fast. The current codebase already contains the foundations for a serious local research workflow, but it is not stable yet. If you are evaluating the project, the best framing is:

- usable for development and experimentation
- not yet safe to trust as your only literature manager

For roadmap context, see [docs/zotero-gap-analysis.md](docs/zotero-gap-analysis.md).
