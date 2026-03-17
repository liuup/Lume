const pdfCacheCleanupMap = new Map<string, () => void>();

export function registerPdfCacheCleanup(pdfPath: string, cleanup: (() => void) | null) {
  if (!pdfPath) {
    return;
  }

  if (cleanup) {
    pdfCacheCleanupMap.set(pdfPath, cleanup);
    return;
  }

  pdfCacheCleanupMap.delete(pdfPath);
}

export function clearCacheForPdf(pdfPath: string) {
  if (!pdfPath) {
    return;
  }

  pdfCacheCleanupMap.get(pdfPath)?.();
  pdfCacheCleanupMap.delete(pdfPath);
}
