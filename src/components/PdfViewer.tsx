import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RenderTask } from "pdfjs-dist/types/src/pdf";
import { AiTranslationResult, PageDimension, PdfSearchMatch, ToolType } from "../types";
import { AnnotationLayer } from "./AnnotationLayer";
import { TextLayer, TextLayerSelectionController, TextLayerSelectionSnapshot } from "./TextLayer";
import { registerPdfCacheCleanup } from "./pdfCacheRegistry";
import { clearPdfDocumentCache, loadPdfDocument, loadPdfPage, warmPdfPage } from "./pdfDocumentRuntime";
import { useI18n } from "../hooks/useI18n";
import { useSettings } from "../hooks/useSettings";

interface PdfViewerProps {
  tabId: string;
  pdfPath: string;
  totalPages: number;
  dimensions: PageDimension[];
  scale: number;
  isColorInverted: boolean;
  activeTool: ToolType;
  currentPage: number;
  searchMatches: PdfSearchMatch[];
  activeSearchIndex: number;
  onDimensionResolved?: (tabId: string, pageIndex: number, dimension: PageDimension) => void;
  onCurrentPageChange?: (page: number) => void;
  onAnnotationsSaved?: (pdfPath: string) => void;
}

type RenderSource = "prefetch" | "visible" | "refine";
type RenderProfile = "preview" | "full";

interface PerfProfile {
  prefetchBefore: number;
  prefetchAfter: number;
  textBefore: number;
  textAfter: number;
  prefetchBudget: number;
}

interface RenderQueueJob {
  priority: number;
  run: () => void;
}

interface TranslationPopupState {
  selectedText: string;
  x: number;
  y: number;
  result: AiTranslationResult | null;
  isLoading: boolean;
  error: string | null;
}

const DEFAULT_PERF_PROFILE: PerfProfile = {
  prefetchBefore: -1,
  prefetchAfter: 1,
  textBefore: -1,
  textAfter: 1,
  prefetchBudget: 2,
};

const VISIBLE_RENDER_PRIORITY = 0;
const REFINE_RENDER_PRIORITY = 1;
const PREFETCH_RENDER_PRIORITY = 4;
const MAX_RENDER_CONCURRENCY = 2;
const PAGE_WINDOW_RADIUS = 5;
const PAGE_VERTICAL_GAP = 16;
const PAGE_HEADER_HEIGHT = 20;
const DEFAULT_PAGE_DIMENSION: PageDimension = {
  width: 612,
  height: 792,
};

const renderQueue: RenderQueueJob[] = [];
let activeRenderCount = 0;

function runNextRender() {
  if (activeRenderCount >= MAX_RENDER_CONCURRENCY || renderQueue.length === 0) {
    return;
  }

  const nextJob = renderQueue.shift();
  if (!nextJob) {
    return;
  }

  activeRenderCount += 1;
  nextJob.run();
}

function enqueueRender<T>(job: () => Promise<T>, priority: number) {
  return new Promise<T>((resolve, reject) => {
    const queuedJob: RenderQueueJob = {
      priority,
      run: () => {
        job()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            activeRenderCount -= 1;
            runNextRender();
          });
      },
    };

    const insertAt = renderQueue.findIndex((entry) => entry.priority > priority);
    if (insertAt === -1) {
      renderQueue.push(queuedJob);
    } else {
      renderQueue.splice(insertAt, 0, queuedJob);
    }

    runNextRender();
  });
}

function getPendingRenderJobs() {
  return activeRenderCount + renderQueue.length;
}

function getRenderPriority(source: RenderSource, profile: RenderProfile) {
  if (source === "prefetch") {
    return PREFETCH_RENDER_PRIORITY;
  }

  if (profile === "full" || source === "refine") {
    return REFINE_RENDER_PRIORITY;
  }

  return VISIBLE_RENDER_PRIORITY;
}

function getPreviewRenderScale(scale: number) {
  const previewCap = scale >= 1.1 ? 1.0 : 1.08;
  const deviceScale = Math.min(window.devicePixelRatio || 1, previewCap);
  return scale * deviceScale;
}

function getFullRenderScale(scale: number) {
  const fullCap = scale >= 1.1 ? 1.55 : 1.8;
  const deviceScale = Math.min(window.devicePixelRatio || 1, fullCap);
  return scale * deviceScale;
}

function isRenderCancelled(error: unknown) {
  return Boolean(
    error
      && typeof error === "object"
      && "name" in error
      && String((error as { name?: string }).name) === "RenderingCancelledException"
  );
}

function getEffectivePageDimension(dimensions: PageDimension[], pageIndex: number) {
  return dimensions[pageIndex] ?? DEFAULT_PAGE_DIMENSION;
}

function getPageOuterHeight(dimension: PageDimension, scale: number) {
  return (dimension.height * scale) + PAGE_HEADER_HEIGHT + PAGE_VERTICAL_GAP;
}

function clearPdfViewerCache(pdfPath: string) {
  clearPdfDocumentCache(pdfPath);
}

export function PdfViewer({
  tabId,
  pdfPath,
  totalPages,
  dimensions,
  scale,
  isColorInverted,
  activeTool,
  currentPage,
  searchMatches,
  activeSearchIndex,
  onDimensionResolved,
  onCurrentPageChange,
  onAnnotationsSaved,
}: PdfViewerProps) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const perfProfile = DEFAULT_PERF_PROFILE;
  const visiblePageRatiosRef = useRef<Map<number, number>>(new Map());
  const lastReportedPageRef = useRef(currentPage);
  const selectionControllersRef = useRef<Map<number, TextLayerSelectionController>>(new Map());
  const activeSelectionPageRef = useRef<number | null>(null);
  const translationRequestIdRef = useRef(0);
  const [translationPopup, setTranslationPopup] = useState<TranslationPopupState | null>(null);

  useEffect(() => {
    void loadPdfDocument(pdfPath).catch((error) => {
      console.error("Failed to load PDF document", error);
    });
  }, [pdfPath]);

  useEffect(() => {
    registerPdfCacheCleanup(pdfPath, () => {
      clearPdfViewerCache(pdfPath);
    });

    return () => {
      registerPdfCacheCleanup(pdfPath, null);
    };
  }, [pdfPath]);

  useEffect(() => {
    selectionControllersRef.current.clear();
    activeSelectionPageRef.current = null;
    setTranslationPopup(null);
  }, [pdfPath]);

  const searchMatchesByPage = useMemo(() => {
    const grouped = new Map<number, Array<{ match: PdfSearchMatch; globalIndex: number }>>();

    searchMatches.forEach((match, globalIndex) => {
      const pageMatches = grouped.get(match.pageIndex) ?? [];
      pageMatches.push({ match, globalIndex });
      grouped.set(match.pageIndex, pageMatches);
    });

    return grouped;
  }, [searchMatches]);

  const pageDimensions = useMemo(() => (
    Array.from({ length: totalPages }, (_, pageIndex) => getEffectivePageDimension(dimensions, pageIndex))
  ), [dimensions, totalPages]);

  const pageOffsets = useMemo(() => {
    const offsets: number[] = [];
    let runningOffset = 0;

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
      offsets.push(runningOffset);
      runningOffset += getPageOuterHeight(pageDimensions[pageIndex], scale);
    }

    return {
      offsets,
      totalHeight: runningOffset,
    };
  }, [pageDimensions, scale, totalPages]);

  useEffect(() => {
    lastReportedPageRef.current = currentPage;
  }, [currentPage]);

  const handlePageVisibilityChange = useCallback((page: number, ratio: number) => {
    const nextRatios = visiblePageRatiosRef.current;
    if (ratio <= 0.01) {
      nextRatios.delete(page);
    } else {
      nextRatios.set(page, ratio);
    }

    let bestPage = lastReportedPageRef.current;
    let bestRatio = -1;

    for (const [candidatePage, candidateRatio] of nextRatios.entries()) {
      if (candidateRatio > bestRatio || (candidateRatio === bestRatio && candidatePage < bestPage)) {
        bestPage = candidatePage;
        bestRatio = candidateRatio;
      }
    }

    if (bestRatio >= 0 && bestPage !== lastReportedPageRef.current) {
      lastReportedPageRef.current = bestPage;
      onCurrentPageChange?.(bestPage);
    }
  }, [onCurrentPageChange]);

  const hideTranslationPopup = useCallback(() => {
    activeSelectionPageRef.current = null;
    setTranslationPopup(null);
  }, []);

  const getActiveSelectionSnapshot = useCallback(() => {
    const activePage = activeSelectionPageRef.current;
    if (activePage === null) {
      return null;
    }

    return selectionControllersRef.current.get(activePage)?.getSelectionSnapshot() ?? null;
  }, []);

  const syncTranslationPopupPosition = useCallback(() => {
    setTranslationPopup((current) => {
      if (!current) {
        return null;
      }

      const nextSnapshot = getActiveSelectionSnapshot();
      if (!nextSnapshot?.selectedText) {
        return current.isLoading ? current : null;
      }

      return {
        ...current,
        selectedText: nextSnapshot.selectedText,
        x: nextSnapshot.x,
        y: nextSnapshot.y,
      };
    });
  }, [getActiveSelectionSnapshot]);

  useEffect(() => {
    if (!translationPopup) {
      return;
    }

    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setTranslationPopup((current) => (current?.isLoading ? current : null));
      }
    };

    document.addEventListener("mousedown", hideTranslationPopup);
    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("scroll", syncTranslationPopupPosition, true);
    window.addEventListener("resize", syncTranslationPopupPosition);

    return () => {
      document.removeEventListener("mousedown", hideTranslationPopup);
      document.removeEventListener("selectionchange", handleSelectionChange);
      window.removeEventListener("scroll", syncTranslationPopupPosition, true);
      window.removeEventListener("resize", syncTranslationPopupPosition);
    };
  }, [hideTranslationPopup, syncTranslationPopupPosition, translationPopup]);

  const registerSelectionController = useCallback((pageIndex: number, controller: TextLayerSelectionController | null) => {
    if (controller) {
      selectionControllersRef.current.set(pageIndex, controller);
      return;
    }

    selectionControllersRef.current.delete(pageIndex);
    if (activeSelectionPageRef.current === pageIndex) {
      hideTranslationPopup();
    }
  }, [hideTranslationPopup]);

  const handleSelectionRequest = useCallback(async (pageIndex: number, snapshot: TextLayerSelectionSnapshot) => {
    const selectedText = snapshot.selectedText.trim();
    if (!selectedText) {
      return;
    }

    activeSelectionPageRef.current = pageIndex;
    const translateEngine = (settings.aiTranslateEngine || "google").trim().toLowerCase();
    const aiIsConfigured = translateEngine !== "llm"
      || Boolean(settings.aiApiKey.trim() && settings.aiCompletionUrl.trim() && settings.aiModel.trim());

    if (!aiIsConfigured) {
      setTranslationPopup({
        selectedText,
        x: snapshot.x,
        y: snapshot.y,
        result: null,
        isLoading: false,
        error: t("textLayer.translation.notConfigured"),
      });
      return;
    }

    const requestId = translationRequestIdRef.current + 1;
    translationRequestIdRef.current = requestId;

    setTranslationPopup({
      selectedText,
      x: snapshot.x,
      y: snapshot.y,
      result: null,
      isLoading: true,
      error: null,
    });

    try {
      const result = await invoke<AiTranslationResult>("translate_selection", {
        text: selectedText,
        targetLanguage: settings.aiTranslateTargetLanguage,
      });

      if (translationRequestIdRef.current !== requestId) {
        return;
      }

      const latestSnapshot = getActiveSelectionSnapshot() ?? snapshot;
      setTranslationPopup({
        selectedText: latestSnapshot.selectedText,
        x: latestSnapshot.x,
        y: latestSnapshot.y,
        result,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      if (translationRequestIdRef.current !== requestId) {
        return;
      }

      console.error("Failed to translate selection", error);
      const latestSnapshot = getActiveSelectionSnapshot() ?? snapshot;
      setTranslationPopup({
        selectedText: latestSnapshot.selectedText,
        x: latestSnapshot.x,
        y: latestSnapshot.y,
        result: null,
        isLoading: false,
        error: t("textLayer.translation.error"),
      });
    }
  }, [
    getActiveSelectionSnapshot,
    settings.aiApiKey,
    settings.aiCompletionUrl,
    settings.aiModel,
    settings.aiTranslateEngine,
    settings.aiTranslateTargetLanguage,
    t,
  ]);

  const prefetchPages = useMemo(() => {
    if (totalPages === 0) return new Set<number>();
    const indices = new Set<number>();
    const centerIndex = Math.max(0, currentPage - 1);

    for (let offset = perfProfile.prefetchBefore; offset <= perfProfile.prefetchAfter; offset += 1) {
      const nextIndex = centerIndex + offset;
      if (nextIndex >= 0 && nextIndex < totalPages) {
        indices.add(nextIndex);
      }
    }

    return indices;
  }, [currentPage, perfProfile.prefetchAfter, perfProfile.prefetchBefore, totalPages]);

  const textLoadPages = useMemo(() => {
    if (totalPages === 0) return new Set<number>();
    const indices = new Set<number>();
    const centerIndex = Math.max(0, currentPage - 1);

    for (let offset = perfProfile.textBefore; offset <= perfProfile.textAfter; offset += 1) {
      const nextIndex = centerIndex + offset;
      if (nextIndex >= 0 && nextIndex < totalPages) {
        indices.add(nextIndex);
      }
    }

    return indices;
  }, [currentPage, perfProfile.textAfter, perfProfile.textBefore, totalPages]);

  const mountedPageRange = useMemo(() => {
    if (totalPages === 0) {
      return { start: 0, end: -1 };
    }

    const currentIndex = Math.max(0, currentPage - 1);
    const activeSearchPage = activeSearchIndex >= 0 ? searchMatches[activeSearchIndex]?.pageIndex : undefined;
    const anchorIndex = typeof activeSearchPage === "number" ? activeSearchPage : currentIndex;

    const start = Math.max(0, Math.min(currentIndex, anchorIndex) - PAGE_WINDOW_RADIUS);
    const end = Math.min(totalPages - 1, Math.max(currentIndex, anchorIndex) + PAGE_WINDOW_RADIUS);

    return { start, end };
  }, [activeSearchIndex, currentPage, searchMatches, totalPages]);

  const mountedPageIndices = useMemo(() => {
    if (mountedPageRange.end < mountedPageRange.start) {
      return [] as number[];
    }

    return Array.from(
      { length: mountedPageRange.end - mountedPageRange.start + 1 },
      (_, offset) => mountedPageRange.start + offset
    );
  }, [mountedPageRange.end, mountedPageRange.start]);

  useEffect(() => {
    if (totalPages === 0) {
      return;
    }

    let isMounted = true;
    let retryTimeoutId: number | null = null;

    const prefetch = () => {
      if (!isMounted) {
        return;
      }

      if (activeRenderCount > 0 || renderQueue.length > 0) {
        retryTimeoutId = window.setTimeout(prefetch, 180);
        return;
      }

      for (const pageIndex of prefetchPages) {
        if (getPendingRenderJobs() >= perfProfile.prefetchBudget) {
          break;
        }

        void enqueueRender(
          () => warmPdfPage(pdfPath, pageIndex),
          getRenderPriority("prefetch", "preview")
        ).catch((error) => {
          if (!isRenderCancelled(error)) {
            console.error(`Failed to prefetch page ${pageIndex + 1}`, error);
          }
        });
      }
    };

    retryTimeoutId = window.setTimeout(prefetch, 120);

    return () => {
      isMounted = false;
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [pdfPath, perfProfile.prefetchBudget, prefetchPages, totalPages]);

  if (totalPages === 0) {
    return (
      <div className="flex flex-col items-center py-6 space-y-4 min-w-full">
        {Array.from({ length: 1 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center space-y-3 group">
            <div
              className="bg-white dark:bg-zinc-950 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.1)] relative shrink-0 border border-zinc-200/50 dark:border-zinc-800 rounded-sm overflow-hidden"
              style={{ width: 680, height: 880 }}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-800 animate-pulse" />
              <div className="absolute top-3 right-3 rounded-full bg-white/80 dark:bg-zinc-900/80 px-2 py-0.5 text-[10px] font-medium text-zinc-400 dark:text-zinc-500 shadow-sm backdrop-blur-sm">
                {t("pdfViewer.pageLabel", { page: i + 1 })}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="relative min-w-full" style={{ height: pageOffsets.totalHeight }}>
        {mountedPageIndices.map((pageIndex) => (
        <MemoPageRender
          key={`${pdfPath}::page-${pageIndex}`}
          tabId={tabId}
          pdfPath={pdfPath}
          pageIndex={pageIndex}
          dimension={pageDimensions[pageIndex]}
          scale={scale}
          isColorInverted={isColorInverted}
          activeTool={activeTool}
          shouldPrefetch={prefetchPages.has(pageIndex)}
          shouldLoadText={textLoadPages.has(pageIndex)}
          pageSearchMatches={searchMatchesByPage.get(pageIndex) ?? []}
          activeSearchIndex={activeSearchIndex}
          topOffset={pageOffsets.offsets[pageIndex] ?? 0}
          onDimensionResolved={onDimensionResolved}
          onSelectionRequest={handleSelectionRequest}
          registerSelectionController={registerSelectionController}
          onVisibilityRatioChange={handlePageVisibilityChange}
          onAnnotationsSaved={onAnnotationsSaved}
        />
      ))}
      {translationPopup && (
        <div
          className="fixed z-[70] w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-[0_18px_45px_-18px_rgba(0,0,0,0.28)] backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/95"
          style={{
            left: translationPopup.x,
            top: translationPopup.y,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-300">
            {t("textLayer.translation.title", { language: settings.aiTranslateTargetLanguage || "zh-CN" })}
          </div>
          <div className="mt-1 text-xs leading-relaxed text-zinc-500 line-clamp-3 dark:text-zinc-400">
            {translationPopup.selectedText}
          </div>
          <div className="mt-2 text-sm leading-relaxed text-zinc-700 whitespace-pre-wrap dark:text-zinc-200">
            {translationPopup.isLoading
              ? t("textLayer.translation.loading")
              : translationPopup.error
                ? translationPopup.error
                : translationPopup.result?.translation}
          </div>
        </div>
      )}
    </div>
  );
}

interface PageRenderProps {
  tabId: string;
  pdfPath: string;
  pageIndex: number;
  dimension: PageDimension;
  scale: number;
  isColorInverted: boolean;
  activeTool: ToolType;
  shouldPrefetch: boolean;
  shouldLoadText: boolean;
  pageSearchMatches: Array<{ match: PdfSearchMatch; globalIndex: number }>;
  activeSearchIndex: number;
  topOffset: number;
  onDimensionResolved?: (tabId: string, pageIndex: number, dimension: PageDimension) => void;
  onSelectionRequest?: (pageIndex: number, snapshot: TextLayerSelectionSnapshot) => void;
  registerSelectionController?: (pageIndex: number, controller: TextLayerSelectionController | null) => void;
  onVisibilityRatioChange?: (page: number, ratio: number) => void;
  onAnnotationsSaved?: (pdfPath: string) => void;
}

function PageRender({
  tabId,
  pdfPath,
  pageIndex,
  dimension,
  scale,
  isColorInverted,
  activeTool,
  shouldPrefetch,
  shouldLoadText,
  pageSearchMatches,
  activeSearchIndex,
  topOffset,
  onDimensionResolved,
  onSelectionRequest,
  registerSelectionController,
  onVisibilityRatioChange,
  onAnnotationsSaved,
}: PageRenderProps) {
  const { t } = useI18n();
  const [isVisible, setIsVisible] = useState(false);
  const [hasRenderedBitmap, setHasRenderedBitmap] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderRequestIdRef = useRef(0);
  const reportedDimensionRef = useRef<string>("");

  const width = dimension.width * scale;
  const height = dimension.height * scale;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nextRatio = entry?.intersectionRatio ?? 0;
        setIsVisible(Boolean(entry?.isIntersecting));
        onVisibilityRatioChange?.(pageIndex + 1, nextRatio);
      },
      { rootMargin: "320px 0px 320px 0px", threshold: [0.01, 0.2, 0.4, 0.6, 0.8, 1] }
    );

    observer.observe(element);
    return () => {
      onVisibilityRatioChange?.(pageIndex + 1, 0);
      observer.disconnect();
    };
  }, [onVisibilityRatioChange, pageIndex]);

  useEffect(() => {
    const source: RenderSource = isVisible ? "visible" : "prefetch";
    if (!isVisible && !shouldPrefetch) {
      return;
    }

    let isMounted = true;
    const requestId = renderRequestIdRef.current + 1;
    renderRequestIdRef.current = requestId;

    const renderIntoCanvas = async (renderScale: number, priority: number) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const page = await loadPdfPage(pdfPath, pageIndex);
      const baseViewport = page.getViewport({ scale: 1 });
      const nextDimension = {
        width: baseViewport.width,
        height: baseViewport.height,
      };
      const nextDimensionKey = `${nextDimension.width.toFixed(2)}x${nextDimension.height.toFixed(2)}`;
      if (reportedDimensionRef.current !== nextDimensionKey) {
        reportedDimensionRef.current = nextDimensionKey;
        onDimensionResolved?.(tabId, pageIndex, nextDimension);
      }

      const viewport = page.getViewport({ scale: renderScale });
      const context = canvas.getContext("2d", { alpha: false });

      if (!context) {
        return;
      }

      const targetWidth = Math.max(1, Math.round(viewport.width));
      const targetHeight = Math.max(1, Math.round(viewport.height));

      return enqueueRender(async () => {
        if (!isMounted || requestId !== renderRequestIdRef.current) {
          return;
        }

        renderTaskRef.current?.cancel();

        canvas.width = targetWidth;
        canvas.height = targetHeight;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";

        const task = page.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        renderTaskRef.current = task;

        await task.promise;

        if (!isMounted || requestId !== renderRequestIdRef.current) {
          return;
        }

        setHasRenderedBitmap(true);
      }, priority);
    };

    void renderIntoCanvas(
      getPreviewRenderScale(scale),
      getRenderPriority(source, "preview")
    ).catch((error) => {
      if (!isRenderCancelled(error)) {
        console.error(`Failed to render page ${pageIndex + 1}`, error);
      }
    });

    return () => {
      isMounted = false;
      renderTaskRef.current?.cancel();
    };
  }, [height, isVisible, pageIndex, pdfPath, scale, shouldPrefetch, width]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    const fullScale = getFullRenderScale(scale);
    const previewScale = getPreviewRenderScale(scale);
    if (Math.abs(fullScale - previewScale) < 0.05) {
      return;
    }

    let isMounted = true;
    const requestId = renderRequestIdRef.current + 1;
    renderRequestIdRef.current = requestId;

    const timeoutId = window.setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      void loadPdfPage(pdfPath, pageIndex)
        .then((page) => {
          const viewport = page.getViewport({ scale: fullScale });
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) {
            return;
          }

          return enqueueRender(async () => {
            if (!isMounted || requestId !== renderRequestIdRef.current) {
              return;
            }

            renderTaskRef.current?.cancel();

            canvas.width = Math.max(1, Math.round(viewport.width));
            canvas.height = Math.max(1, Math.round(viewport.height));
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;

            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = "high";

            const task = page.render({
              canvas,
              canvasContext: context,
              viewport,
            });
            renderTaskRef.current = task;

            await task.promise;

            if (!isMounted || requestId !== renderRequestIdRef.current) {
              return;
            }

            setHasRenderedBitmap(true);
          }, getRenderPriority("refine", "full"));
        })
        .catch((error) => {
          if (!isRenderCancelled(error)) {
            console.error(`Failed to refine page ${pageIndex + 1}`, error);
          }
        });
    }, 120);

    return () => {
      isMounted = false;
      window.clearTimeout(timeoutId);
      renderTaskRef.current?.cancel();
    };
  }, [height, isVisible, onDimensionResolved, pageIndex, pdfPath, scale, tabId, width]);

  const pageElementId = `pdf-page-${encodeURIComponent(tabId)}-${pageIndex + 1}`;
  const shouldMountTextLayer = isVisible;
  const shouldMountAnnotationLayer = isVisible;

  return (
    <div
      id={pageElementId}
      data-page-number={pageIndex + 1}
      className="absolute left-1/2 flex flex-col items-center space-y-3 group -translate-x-1/2"
      style={{ top: topOffset }}
    >
      <div className="flex items-center justify-between w-full px-2">
        <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
          {t("pdfViewer.pageLabel", { page: pageIndex + 1 })}
        </span>
      </div>

      <div
        ref={containerRef}
        className="bg-white dark:bg-zinc-950 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.1),0_1px_4px_rgba(0,0,0,0.05)] relative select-text shrink-0 border border-zinc-200/50 dark:border-zinc-800 rounded-sm overflow-hidden transition-shadow hover:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.15)]"
        style={{ width, height }}
      >
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 w-full h-full ${isColorInverted ? "pdf-canvas-inverted" : ""}`}
          style={{ opacity: hasRenderedBitmap ? 1 : 0 }}
        />

        {!hasRenderedBitmap && (
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-800 animate-pulse" />
        )}

        {!hasRenderedBitmap && (
          <div className="absolute top-3 right-3 rounded-full bg-white/80 dark:bg-zinc-900/80 px-2 py-0.5 text-[10px] font-medium text-zinc-400 dark:text-zinc-500 shadow-sm backdrop-blur-sm">
            {t("pdfViewer.pageLabel", { page: pageIndex + 1 })}
          </div>
        )}

        {pageSearchMatches.length > 0 && (
          <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
            {pageSearchMatches.flatMap(({ match, globalIndex }) =>
              match.rects.map((rect, rectIndex) => {
                const isActive = globalIndex === activeSearchIndex;

                return (
                  <div
                    key={`search-${pageIndex}-${globalIndex}-${rectIndex}`}
                    data-search-match-id={rectIndex === 0 ? String(globalIndex) : undefined}
                    className="absolute rounded-sm transition-all duration-150"
                    style={{
                      left: rect.x * scale,
                      top: rect.y * scale,
                      width: rect.width * scale,
                      height: rect.height * scale,
                      backgroundColor: isActive ? "rgba(245, 158, 11, 0.45)" : "rgba(250, 204, 21, 0.28)",
                      boxShadow: isActive
                        ? "0 0 0 1px rgba(217, 119, 6, 0.65), 0 0 0 3px rgba(251, 191, 36, 0.22)"
                        : "0 0 0 1px rgba(234, 179, 8, 0.2)",
                    }}
                  />
                );
              })
            )}
          </div>
        )}

        {shouldMountTextLayer && (
          <TextLayer
            pdfPath={pdfPath}
            pageIndex={pageIndex}
            scale={scale}
            width={width}
            height={height}
            isVisible={isVisible}
            shouldLoad={shouldLoadText}
            onSelectionRequest={onSelectionRequest}
            registerSelectionController={registerSelectionController}
          />
        )}

        {shouldMountAnnotationLayer && (
          <AnnotationLayer
            pdfPath={pdfPath}
            pageIndex={pageIndex}
            width={width}
            height={height}
            scale={scale}
            isColorInverted={isColorInverted}
            activeTool={activeTool}
            onAnnotationsSaved={onAnnotationsSaved}
          />
        )}
      </div>
    </div>
  );
}

const MemoPageRender = memo(PageRender);
