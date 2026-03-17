import { convertFileSrc } from "@tauri-apps/api/core";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/pdf";

type PdfJsModule = typeof import("pdfjs-dist");

const pdfDocumentCache = new Map<string, PDFDocumentProxy>();
const inflightDocuments = new Map<string, Promise<PDFDocumentProxy>>();
const pdfPageCache = new Map<string, Promise<PDFPageProxy>>();

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;
let pdfJsConfigured = false;

function getPageCacheKey(pdfPath: string, pageIndex: number) {
  return `${pdfPath}::${pageIndex}`;
}

export async function loadPdfJs() {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfJs, workerUrlModule]) => {
      if (!pdfJsConfigured) {
        pdfJs.GlobalWorkerOptions.workerSrc = workerUrlModule.default;
        pdfJsConfigured = true;
      }
      return pdfJs;
    });
  }

  return pdfJsModulePromise;
}

export async function preloadPdfEngine() {
  await loadPdfJs();
}

export async function loadPdfDocument(pdfPath: string) {
  const normalizedPath = pdfPath.trim();
  if (!normalizedPath) {
    throw new Error("Cannot load an empty PDF path");
  }

  const cached = pdfDocumentCache.get(normalizedPath);
  if (cached) {
    return cached;
  }

  const inflight = inflightDocuments.get(normalizedPath);
  if (inflight) {
    return inflight;
  }

  const pdfJs = await loadPdfJs();
  const loadingTask = pdfJs.getDocument({
    url: convertFileSrc(normalizedPath),
  });

  const nextDocument = loadingTask.promise
    .then((document) => {
      pdfDocumentCache.set(normalizedPath, document);
      inflightDocuments.delete(normalizedPath);
      return document;
    })
    .catch((error) => {
      inflightDocuments.delete(normalizedPath);
      throw error;
    });

  inflightDocuments.set(normalizedPath, nextDocument);
  return nextDocument;
}

export async function preloadPdfDocument(pdfPath: string) {
  const normalizedPath = pdfPath.trim();
  if (!normalizedPath) {
    return;
  }

  const document = await loadPdfDocument(normalizedPath);
  void document.getPage(1)
    .then((page) => {
      page.getViewport({ scale: 1 });
    })
    .catch(() => {
      // Ignore warmup failures; the viewer will retry on demand.
    });
}

export async function loadPdfPage(pdfPath: string, pageIndex: number) {
  const normalizedPath = pdfPath.trim();
  const cacheKey = getPageCacheKey(normalizedPath, pageIndex);
  const cached = pdfPageCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const nextPage = loadPdfDocument(normalizedPath).then((document) => document.getPage(pageIndex + 1));
  pdfPageCache.set(cacheKey, nextPage);
  return nextPage;
}

export async function warmPdfPage(pdfPath: string, pageIndex: number) {
  const page = await loadPdfPage(pdfPath, pageIndex);
  await page.getOperatorList();
}

export function clearPdfDocumentCache(pdfPath: string) {
  const normalizedPath = pdfPath.trim();
  if (!normalizedPath) {
    return;
  }

  for (const key of pdfPageCache.keys()) {
    if (key.startsWith(`${normalizedPath}::`)) {
      pdfPageCache.delete(key);
    }
  }

  inflightDocuments.delete(normalizedPath);

  const document = pdfDocumentCache.get(normalizedPath);
  if (document) {
    pdfDocumentCache.delete(normalizedPath);
    void document.destroy().catch(() => {
      // Ignore cleanup errors when the user closes a tab during active rendering.
    });
  }
}
