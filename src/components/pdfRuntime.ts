import { preloadPdfEngine } from "./pdfDocumentRuntime";

let pdfViewerModulePromise: Promise<typeof import("./PdfViewer")> | null = null;
let toolbarModulePromise: Promise<typeof import("./Toolbar")> | null = null;
let searchBarModulePromise: Promise<typeof import("./SearchBar")> | null = null;
let aiPanelModulePromise: Promise<typeof import("./layout/AIPanel")> | null = null;
let metaPanelModulePromise: Promise<typeof import("./layout/MetaPanel")> | null = null;

export function loadPdfViewerModule() {
  if (!pdfViewerModulePromise) {
    pdfViewerModulePromise = import("./PdfViewer");
  }

  return pdfViewerModulePromise;
}

export function preloadPdfCoreRuntime() {
  return Promise.all([
    loadPdfViewerModule().then(() => undefined),
    loadPdfToolbarModule().then(() => undefined),
    loadPdfSearchBarModule().then(() => undefined),
    preloadPdfEngine(),
  ]).then(() => undefined);
}

export function preloadPdfSidebarRuntime() {
  return Promise.all([
    loadPdfAIPanelModule().then(() => undefined),
    loadPdfMetaPanelModule().then(() => undefined),
  ]).then(() => undefined);
}

export function preloadPdfRuntime() {
  return Promise.all([
    preloadPdfCoreRuntime(),
    preloadPdfSidebarRuntime(),
  ]).then(() => undefined);
}

export function loadPdfToolbarModule() {
  if (!toolbarModulePromise) {
    toolbarModulePromise = import("./Toolbar");
  }
  return toolbarModulePromise;
}

export function loadPdfSearchBarModule() {
  if (!searchBarModulePromise) {
    searchBarModulePromise = import("./SearchBar");
  }
  return searchBarModulePromise;
}

export function loadPdfAIPanelModule() {
  if (!aiPanelModulePromise) {
    aiPanelModulePromise = import("./layout/AIPanel");
  }
  return aiPanelModulePromise;
}

export function loadPdfMetaPanelModule() {
  if (!metaPanelModulePromise) {
    metaPanelModulePromise = import("./layout/MetaPanel");
  }
  return metaPanelModulePromise;
}
