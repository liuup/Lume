# Lume

[English](README.md) | [中文](README.zh-CN.md)

> [!WARNING]
> Lume is still in a prototype stage. It currently contains many bugs, incomplete features, and rough edges. Please do not rely on it yet for important data or production research workflows.

Lume is a desktop literature tool built for academic reading and knowledge organization. It brings PDF reading, annotations, metadata editing, tags, notes, and citation export into one lightweight local-first app.

Built with Tauri + React + TypeScript + PDFium, Lume is not trying to be just another PDF viewer. It is designed to become a smooth research workspace.

---

## Why Lume

- **Local-first**: your papers, annotations, and notes stay under your control
- **Reading + organization in one flow**: not just reading, but turning material into reusable knowledge
- **Lightweight desktop experience**: fast startup, clean UI, cross-platform
- **Built for research workflows**: tags, metadata, annotations, and exports are centered around academic use cases

---

## Current Core Capabilities

### Library Management
- Local paper library management
- Folder / subfolder organization
- PDF import, delete, rename, and move
- Global search with field filters
- Tag system with color management

### PDF Reading
- Multi-tab reading
- Page rendering with lazy loading
- Zoom in / out, fit width, fit height
- Text layer loading and text selection
- In-document PDF search (`Ctrl+F`)

### Annotation and Knowledge Workflow
- Drawing, highlight, and text annotations
- Local annotation persistence
- Paper-level Markdown notes
- Metadata completion from DOI / arXiv
- Citation preview and multi-format export

---

## Who Is It For

Lume is especially suitable for:

- Students and researchers who read papers frequently
- Users who want reading, annotation, notes, and citations in one place
- Zotero / PDF Expert / Skim users who prefer a local-first and lightweight workflow

---

## Development Status

Lume is evolving quickly. Current priorities include:

- Annotation management view
- Automatic metadata recognition when dropping PDFs in
- BibTeX / RIS import
- More reader shortcuts and stronger UX polish

See [docs/zotero-gap-analysis.md](docs/zotero-gap-analysis.md) for the full product gap analysis and roadmap.

---

## Quick Start

### Local Development

```bash
npm install
npm run tauri dev
```

### CLI

Lume now ships with a native CLI in both the main app binary and the standalone `lume-cli` helper binary.

List the currently saved papers:

```bash
Lume list
```

Print the same list as JSON:

```bash
Lume list --json
```

Search the library or export citations:

```bash
Lume search "transformer" --json
Lume export --format bibtex -o refs.bib
```

Open a library item or any PDF path in the GUI:

```bash
Lume open /absolute/path/to/paper.pdf
```

During development, run the standalone helper from the repo root:

```bash
npm run cli:list
```

### Build

```bash
npm run tauri build
```

Detailed local build, packaging, platform-specific notes, and manual GitHub Actions build instructions are available here:

- [docs/build-and-release-guide.md](docs/build-and-release-guide.md)

---

## Release Outputs

The repository currently supports manual GitHub Actions builds for:

- **macOS**: `.app` / `.dmg`
- **Windows Portable**: runnable `Lume.exe + pdfium.dll`
- **Windows Installer**: NSIS installer `.exe`

For local packaging or CI adjustments, see [docs/build-and-release-guide.md](docs/build-and-release-guide.md).

---

## Tech Stack

- **Desktop Shell**: Tauri v2
- **Frontend**: React + TypeScript + Vite
- **Styling**: Tailwind CSS
- **Backend**: Rust
- **PDF Engine**: PDFium
- **Storage**: SQLite + local sidecar annotation files

---

## Vision

Lume is not trying to solve the problem of “building another PDF reader”, but rather:

> How can we make the path from “opening a paper” to “organizing knowledge” as short, light, and natural as possible?

If you care about literature management, academic reading workflows, or alternatives to Zotero, this project is worth following.
