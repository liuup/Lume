import { memo, RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookOpenText, Bookmark, FileText, Images } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/pdf";
import { AiTranslationResult, AnnotationFocusTarget, PageBookmark, PageDimension, PdfSearchMatch, SearchRect, ToolType } from "../types";
import { AnnotationHistoryController, AnnotationHistoryState, AnnotationLayer } from "./AnnotationLayer";
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
  isNavigationOpen: boolean;
  navigationMode: PdfNavigationMode;
  onNavigationModeChange?: (mode: PdfNavigationMode) => void;
  onNavigateToPage?: (page: number) => void;
  bookmarks: PageBookmark[];
  onToggleBookmarkPage?: (page: number) => void;
  annotationsRefreshKey?: number;
  annotationHistoryCommand?: AnnotationHistoryCommand | null;
  annotationFocusTarget?: AnnotationFocusTarget | null;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  onAnnotationHistoryStateChange?: (state: AnnotationHistoryState) => void;
  onDimensionResolved?: (tabId: string, pageIndex: number, dimension: PageDimension) => void;
  onCurrentPageChange?: (page: number) => void;
  onAnnotationsSaved?: (pdfPath: string) => void;
}

type PdfNavigationMode = "outline" | "thumbnails" | "bookmarks";
type AnnotationHistoryCommand = {
  type: "undo" | "redo";
  nonce: number;
};

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

interface ResolvedOutlineItem {
  title: string;
  page: number | null;
  items: ResolvedOutlineItem[];
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

async function resolveOutlineDestinationPage(document: PDFDocumentProxy, destination: string | Array<any> | null) {
  if (!destination) {
    return null;
  }

  try {
    const resolved = typeof destination === "string"
      ? await document.getDestination(destination)
      : destination;

    if (!resolved || resolved.length === 0 || !resolved[0]) {
      return null;
    }

    return (await document.getPageIndex(resolved[0])) + 1;
  } catch (error) {
    console.error("Failed to resolve outline destination", error);
    return null;
  }
}

async function resolveOutlineItems(
  document: PDFDocumentProxy,
  items: Array<{ title: string; dest: string | Array<any> | null; items: Array<any> }>,
): Promise<ResolvedOutlineItem[]> {
  return Promise.all(items.map(async (item) => ({
    title: item.title?.trim() || "Untitled section",
    page: await resolveOutlineDestinationPage(document, item.dest),
    items: await resolveOutlineItems(document, item.items ?? []),
  })));
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
  isNavigationOpen,
  navigationMode,
  onNavigationModeChange,
  onNavigateToPage,
  bookmarks,
  onToggleBookmarkPage,
  annotationsRefreshKey = 0,
  annotationHistoryCommand,
  annotationFocusTarget,
  scrollContainerRef,
  onAnnotationHistoryStateChange,
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
  const annotationControllersRef = useRef<Map<number, AnnotationHistoryController>>(new Map());
  const activeSelectionPageRef = useRef<number | null>(null);
  const lastAnnotationCommandRef = useRef<number>(0);
  const translationRequestIdRef = useRef(0);
  const [translationPopup, setTranslationPopup] = useState<TranslationPopupState | null>(null);
  const [outlineItems, setOutlineItems] = useState<ResolvedOutlineItem[]>([]);
  const [isOutlineLoading, setIsOutlineLoading] = useState(false);
  const [activeFocusNonce, setActiveFocusNonce] = useState<number | null>(null);

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
    annotationControllersRef.current.clear();
    activeSelectionPageRef.current = null;
    lastAnnotationCommandRef.current = 0;
    setTranslationPopup(null);
    setOutlineItems([]);
    onAnnotationHistoryStateChange?.({ canUndo: false, canRedo: false });
  }, [pdfPath]);

  useEffect(() => {
    let isMounted = true;
    setIsOutlineLoading(true);
    setOutlineItems([]);

    void loadPdfDocument(pdfPath)
      .then(async (document) => {
        const outline = await document.getOutline();
        if (!isMounted) {
          return;
        }

        if (!outline || outline.length === 0) {
          setOutlineItems([]);
          return;
        }

        const resolvedItems = await resolveOutlineItems(document, outline as Array<{ title: string; dest: string | Array<any> | null; items: Array<any> }>);
        if (isMounted) {
          setOutlineItems(resolvedItems);
        }
      })
      .catch((error) => {
        console.error("Failed to load PDF outline", error);
        if (isMounted) {
          setOutlineItems([]);
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsOutlineLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
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

  useEffect(() => {
    if (!annotationFocusTarget || !scrollContainerRef?.current) {
      return;
    }

    const targetPageIndex = Math.max(0, annotationFocusTarget.page - 1);
    const nextScrollTop = Math.max(
      0,
      (pageOffsets.offsets[targetPageIndex] ?? 0) + (annotationFocusTarget.y * scale) - (scrollContainerRef.current.clientHeight * 0.28),
    );

    const frameId = window.requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({
        top: nextScrollTop,
        behavior: "smooth",
      });
      setActiveFocusNonce(annotationFocusTarget.nonce);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [annotationFocusTarget, pageOffsets.offsets, scale, scrollContainerRef]);

  useEffect(() => {
    if (activeFocusNonce === null) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setActiveFocusNonce((current) => (current === activeFocusNonce ? null : current));
    }, 1800);

    return () => window.clearTimeout(timeoutId);
  }, [activeFocusNonce]);

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

  const emitActiveAnnotationHistoryState = useCallback((pageIndexOverride?: number) => {
    const targetPageIndex = typeof pageIndexOverride === "number"
      ? pageIndexOverride
      : Math.max(0, currentPage - 1);
    const controller = annotationControllersRef.current.get(targetPageIndex);
    onAnnotationHistoryStateChange?.(controller?.getHistoryState() ?? { canUndo: false, canRedo: false });
  }, [currentPage, onAnnotationHistoryStateChange]);

  const registerAnnotationHistoryController = useCallback((pageIndex: number, controller: AnnotationHistoryController | null) => {
    if (controller) {
      annotationControllersRef.current.set(pageIndex, controller);
    } else {
      annotationControllersRef.current.delete(pageIndex);
    }

    emitActiveAnnotationHistoryState(pageIndex === Math.max(0, currentPage - 1) ? pageIndex : undefined);
  }, [currentPage, emitActiveAnnotationHistoryState]);

  const handleAnnotationHistoryStateChange = useCallback((pageIndex: number, state: AnnotationHistoryState) => {
    if (pageIndex === Math.max(0, currentPage - 1)) {
      onAnnotationHistoryStateChange?.(state);
    }
  }, [currentPage, onAnnotationHistoryStateChange]);

  useEffect(() => {
    emitActiveAnnotationHistoryState();
  }, [currentPage, emitActiveAnnotationHistoryState]);

  useEffect(() => {
    if (!annotationHistoryCommand || annotationHistoryCommand.nonce === lastAnnotationCommandRef.current) {
      return;
    }

    lastAnnotationCommandRef.current = annotationHistoryCommand.nonce;
    const controller = annotationControllersRef.current.get(Math.max(0, currentPage - 1));
    if (!controller) {
      return;
    }

    if (annotationHistoryCommand.type === "undo") {
      controller.undo();
    } else {
      controller.redo();
    }
  }, [annotationHistoryCommand, currentPage]);

  const handleSelectionRequest = useCallback(async (pageIndex: number, snapshot: TextLayerSelectionSnapshot) => {
    const selectedText = snapshot.selectedText.trim();
    if (!selectedText) {
      return;
    }

    activeSelectionPageRef.current = pageIndex;

    if (activeTool === "highlight") {
      try {
        const rects = await invoke<SearchRect[]>("get_text_rects", {
          path: pdfPath,
          pageIndex,
          selection: {
            left: snapshot.selection.x,
            top: snapshot.selection.y,
            right: snapshot.selection.x + snapshot.selection.width,
            bottom: snapshot.selection.y + snapshot.selection.height,
          },
        });

        annotationControllersRef.current.get(pageIndex)?.addTextHighlightRects(rects);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        hideTranslationPopup();
      } catch (error) {
        console.error("Failed to create text highlight", error);
      }
      return;
    }

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
    activeTool,
    hideTranslationPopup,
    pdfPath,
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
    <div className="flex min-h-full min-w-full items-start gap-4 px-4 pb-6 pt-4">
      {isNavigationOpen && (
        <aside className="sticky top-4 z-20 h-[calc(100vh-9rem)] w-64 shrink-0 overflow-hidden rounded-2xl border border-zinc-200 bg-white/95 shadow-[0_18px_45px_-18px_rgba(0,0,0,0.18)] backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/95">
          <div className="flex items-center gap-1 border-b border-zinc-200 p-2 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => onNavigationModeChange?.("outline")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                navigationMode === "outline"
                  ? "bg-indigo-600 text-white dark:bg-indigo-700"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              <BookOpenText size={14} />
              {t("pdfViewer.navigation.outline")}
            </button>
            <button
              type="button"
              onClick={() => onNavigationModeChange?.("thumbnails")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                navigationMode === "thumbnails"
                  ? "bg-indigo-600 text-white dark:bg-indigo-700"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              <Images size={14} />
              {t("pdfViewer.navigation.pages")}
            </button>
            <button
              type="button"
              onClick={() => onNavigationModeChange?.("bookmarks")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                navigationMode === "bookmarks"
                  ? "bg-indigo-600 text-white dark:bg-indigo-700"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              <Bookmark size={14} className={navigationMode === "bookmarks" ? "fill-current" : undefined} />
              {t("pdfViewer.navigation.bookmarks")}
            </button>
          </div>
          <div className="h-[calc(100%-57px)] overflow-y-auto p-3">
            {navigationMode === "outline" ? (
              <OutlinePanel
                items={outlineItems}
                isLoading={isOutlineLoading}
                currentPage={currentPage}
                onNavigateToPage={onNavigateToPage}
              />
            ) : navigationMode === "thumbnails" ? (
              <ThumbnailPanel
                pdfPath={pdfPath}
                totalPages={totalPages}
                currentPage={currentPage}
                onNavigateToPage={onNavigateToPage}
              />
            ) : (
              <BookmarkPanel
                bookmarks={bookmarks}
                currentPage={currentPage}
                onNavigateToPage={onNavigateToPage}
                onToggleBookmarkPage={onToggleBookmarkPage}
              />
            )}
          </div>
        </aside>
      )}
      <div className="relative min-w-0 flex-1" style={{ height: pageOffsets.totalHeight }}>
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
            registerHistoryController={registerAnnotationHistoryController}
            annotationsRefreshKey={annotationsRefreshKey}
            focusTarget={annotationFocusTarget && annotationFocusTarget.page === pageIndex + 1 ? annotationFocusTarget : null}
            isFocusActive={activeFocusNonce === annotationFocusTarget?.nonce}
            onAnnotationHistoryStateChange={handleAnnotationHistoryStateChange}
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
  registerHistoryController?: (pageIndex: number, controller: AnnotationHistoryController | null) => void;
  annotationsRefreshKey?: number;
  focusTarget?: AnnotationFocusTarget | null;
  isFocusActive?: boolean;
  onAnnotationHistoryStateChange?: (pageIndex: number, state: AnnotationHistoryState) => void;
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
  registerHistoryController,
  annotationsRefreshKey = 0,
  focusTarget,
  isFocusActive = false,
  onAnnotationHistoryStateChange,
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

        {focusTarget && isFocusActive ? (
          <div
            className="pointer-events-none absolute rounded-lg border-2 border-indigo-500/80 bg-indigo-300/18 shadow-[0_0_0_8px_rgba(99,102,241,0.08)] animate-pulse"
            style={{
              left: focusTarget.x * scale,
              top: focusTarget.y * scale,
              width: Math.max(24, focusTarget.width * scale),
              height: Math.max(18, focusTarget.height * scale),
              zIndex: 6,
            }}
          />
        ) : null}

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
            refreshKey={annotationsRefreshKey}
            width={width}
            height={height}
            scale={scale}
            isColorInverted={isColorInverted}
            activeTool={activeTool}
            onAnnotationsSaved={onAnnotationsSaved}
            registerHistoryController={registerHistoryController}
            onHistoryStateChange={onAnnotationHistoryStateChange}
          />
        )}
      </div>
    </div>
  );
}

const MemoPageRender = memo(PageRender);

interface OutlinePanelProps {
  items: ResolvedOutlineItem[];
  isLoading: boolean;
  currentPage: number;
  onNavigateToPage?: (page: number) => void;
}

function OutlinePanel({
  items,
  isLoading,
  currentPage,
  onNavigateToPage,
}: OutlinePanelProps) {
  const { t } = useI18n();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={`outline-skeleton-${index}`}
            className="h-9 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900"
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-200 px-4 text-center dark:border-zinc-800">
        <FileText size={18} className="text-zinc-400 dark:text-zinc-500" />
        <p className="mt-3 text-sm font-medium text-zinc-600 dark:text-zinc-300">
          {t("pdfViewer.navigation.outlineEmpty")}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
          {t("pdfViewer.navigation.outlineHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {items.map((item, index) => (
        <OutlineTreeItem
          key={`${item.title}-${item.page ?? "none"}-${index}`}
          item={item}
          depth={0}
          currentPage={currentPage}
          onNavigateToPage={onNavigateToPage}
        />
      ))}
    </div>
  );
}

interface OutlineTreeItemProps {
  item: ResolvedOutlineItem;
  depth: number;
  currentPage: number;
  onNavigateToPage?: (page: number) => void;
}

function OutlineTreeItem({
  item,
  depth,
  currentPage,
  onNavigateToPage,
}: OutlineTreeItemProps) {
  const isActive = typeof item.page === "number" && item.page === currentPage;
  const isAncestorActive = typeof item.page === "number"
    ? item.page <= currentPage && item.items.some((child) => containsCurrentPage(child, currentPage))
    : item.items.some((child) => containsCurrentPage(child, currentPage));

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (item.page) {
            onNavigateToPage?.(item.page);
          }
        }}
        disabled={!item.page}
        className={`flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left transition-colors ${
          isActive
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-200"
            : isAncestorActive
              ? "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-default disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
        }`}
        style={{ paddingLeft: `${12 + (depth * 14)}px` }}
      >
        <span className="min-w-0 flex-1 text-xs font-medium leading-relaxed">{item.title}</span>
        {item.page && (
          <span className="shrink-0 rounded-md bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400 dark:bg-zinc-950/70 dark:text-zinc-500">
            {item.page}
          </span>
        )}
      </button>
      {item.items.length > 0 && (
        <div className="mt-1 space-y-1">
          {item.items.map((child, index) => (
            <OutlineTreeItem
              key={`${child.title}-${child.page ?? "none"}-${index}`}
              item={child}
              depth={depth + 1}
              currentPage={currentPage}
              onNavigateToPage={onNavigateToPage}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function containsCurrentPage(item: ResolvedOutlineItem, currentPage: number): boolean {
  if (item.page === currentPage) {
    return true;
  }

  return item.items.some((child) => containsCurrentPage(child, currentPage));
}

interface ThumbnailPanelProps {
  pdfPath: string;
  totalPages: number;
  currentPage: number;
  onNavigateToPage?: (page: number) => void;
}

function ThumbnailPanel({
  pdfPath,
  totalPages,
  currentPage,
  onNavigateToPage,
}: ThumbnailPanelProps) {
  return (
    <div className="space-y-3">
      {Array.from({ length: totalPages }, (_, pageIndex) => (
        <ThumbnailPreview
          key={`${pdfPath}-thumbnail-${pageIndex}`}
          pdfPath={pdfPath}
          pageIndex={pageIndex}
          isActive={currentPage === pageIndex + 1}
          onClick={() => onNavigateToPage?.(pageIndex + 1)}
        />
      ))}
    </div>
  );
}

interface ThumbnailPreviewProps {
  pdfPath: string;
  pageIndex: number;
  isActive: boolean;
  onClick: () => void;
}

function ThumbnailPreview({
  pdfPath,
  pageIndex,
  isActive,
  onClick,
}: ThumbnailPreviewProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [isVisible, setIsVisible] = useState(pageIndex < 6);
  const [hasRendered, setHasRendered] = useState(false);
  const [thumbnailHeight, setThumbnailHeight] = useState(192);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px 240px 0px", threshold: 0.01 }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    let isMounted = true;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    void loadPdfPage(pdfPath, pageIndex)
      .then((page) => {
        const baseViewport = page.getViewport({ scale: 1 });
        const previewWidth = 176;
        const previewScale = previewWidth / Math.max(baseViewport.width, 1);
        const viewport = page.getViewport({ scale: previewScale });
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) {
          return;
        }

        setThumbnailHeight(Math.max(120, Math.round(viewport.height)));

        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        renderTaskRef.current?.cancel();
        const renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        renderTaskRef.current = renderTask;

        return renderTask.promise.then(() => {
          if (!isMounted) {
            return;
          }
          setHasRendered(true);
        });
      })
      .catch((error) => {
        if (!isRenderCancelled(error)) {
          console.error(`Failed to render thumbnail for page ${pageIndex + 1}`, error);
        }
      });

    return () => {
      isMounted = false;
      renderTaskRef.current?.cancel();
    };
  }, [isVisible, pageIndex, pdfPath]);

  return (
    <button
      ref={containerRef}
      type="button"
      onClick={onClick}
      className={`group flex w-full flex-col rounded-2xl border p-2 text-left transition-all ${
        isActive
          ? "border-indigo-300 bg-indigo-50 shadow-[0_12px_28px_-18px_rgba(79,70,229,0.55)] dark:border-indigo-800 dark:bg-indigo-950/50"
          : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
      }`}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${
          isActive
            ? "text-indigo-600 dark:text-indigo-300"
            : "text-zinc-400 dark:text-zinc-500"
        }`}>
          {t("pdfViewer.pageLabel", { page: pageIndex + 1 })}
        </span>
      </div>
      <div
        className="relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
        style={{ minHeight: thumbnailHeight }}
      >
        {!hasRendered && (
          <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-900 dark:to-zinc-800" />
        )}
        <canvas
          ref={canvasRef}
          aria-label={t("pdfViewer.pageAlt", { page: pageIndex + 1 })}
          className={`relative mx-auto block max-w-full transition-opacity ${hasRendered ? "opacity-100" : "opacity-0"}`}
        />
      </div>
    </button>
  );
}

interface BookmarkPanelProps {
  bookmarks: PageBookmark[];
  currentPage: number;
  onNavigateToPage?: (page: number) => void;
  onToggleBookmarkPage?: (page: number) => void;
}

function BookmarkPanel({
  bookmarks,
  currentPage,
  onNavigateToPage,
  onToggleBookmarkPage,
}: BookmarkPanelProps) {
  const { t } = useI18n();

  if (bookmarks.length === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-200 px-4 text-center dark:border-zinc-800">
        <Bookmark size={18} className="text-zinc-400 dark:text-zinc-500" />
        <p className="mt-3 text-sm font-medium text-zinc-600 dark:text-zinc-300">
          {t("pdfViewer.navigation.bookmarksEmpty")}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
          {t("pdfViewer.navigation.bookmarksHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {bookmarks.map((bookmark) => {
        const isActive = bookmark.page === currentPage;
        return (
          <div
            key={`${bookmark.page}-${bookmark.createdAt}`}
            className={`flex items-center gap-2 rounded-2xl border p-2 ${
              isActive
                ? "border-indigo-200 bg-indigo-50 dark:border-indigo-900/70 dark:bg-indigo-950/30"
                : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
            }`}
          >
            <button
              type="button"
              onClick={() => onNavigateToPage?.(bookmark.page)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-900"
            >
              <div className={`rounded-lg p-1 ${
                isActive
                  ? "bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300"
                  : "bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300"
              }`}>
                <Bookmark size={13} className="fill-current" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
                  {t("pdfViewer.pageLabel", { page: bookmark.page })}
                </div>
                <div className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                  {new Date(bookmark.createdAt).toLocaleString()}
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => onToggleBookmarkPage?.(bookmark.page)}
              className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-rose-500 dark:text-zinc-500 dark:hover:bg-zinc-900 dark:hover:text-rose-300"
              title={t("toolbar.bookmarks.remove")}
            >
              <Bookmark size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
