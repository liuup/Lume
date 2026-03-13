import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PageDimension, PdfSearchMatch, ToolType } from "../types";
import { AnnotationLayer } from "./AnnotationLayer";
import { TextLayer } from "./TextLayer";
import { useI18n } from "../hooks/useI18n";

interface PdfViewerProps {
  pdfPath: string;
  totalPages: number;
  dimensions: PageDimension[];
  scale: number;
  activeTool: ToolType;
  currentPage: number;
  searchMatches: PdfSearchMatch[];
  activeSearchIndex: number;
  onAnnotationsSaved?: (pdfPath: string) => void;
}

type RenderSource = "prefetch" | "visible" | "refine";

interface PerfProfile {
  prefetchBefore: number;
  prefetchAfter: number;
  textBefore: number;
  textAfter: number;
  prefetchBudget: number;
}

interface RenderMetricsSnapshot {
  sampleCount: number;
  avgQueueDepth: number;
  avgQueueWaitMs: number;
  avgRenderMs: number;
  avgEndToEndMs: number;
  sourceCount: Record<RenderSource, number>;
}

const pageImageCache = new Map<string, string>();
const inflightRenders = new Map<string, Promise<string>>();
const inflightPdfLoads = new Map<string, Promise<void>>();
const renderQueue: Array<() => void> = [];
const MAX_RENDER_CONCURRENCY = 2;
const MAX_CACHE_ENTRIES = 120;
const DEFAULT_PREFETCH_BUDGET = 3;
const PERF_ALPHA = 0.18;
let activeRenderCount = 0;

const DEFAULT_PERF_PROFILE: PerfProfile = {
  prefetchBefore: -1,
  prefetchAfter: 1,
  textBefore: -2,
  textAfter: 2,
  prefetchBudget: DEFAULT_PREFETCH_BUDGET,
};

const renderMetrics: RenderMetricsSnapshot = {
  sampleCount: 0,
  avgQueueDepth: 0,
  avgQueueWaitMs: 0,
  avgRenderMs: 0,
  avgEndToEndMs: 0,
  sourceCount: {
    prefetch: 0,
    visible: 0,
    refine: 0,
  },
};

function updateEwma(current: number, next: number) {
  if (current === 0) {
    return next;
  }
  return current * (1 - PERF_ALPHA) + next * PERF_ALPHA;
}

function runNextRender() {
  if (activeRenderCount >= MAX_RENDER_CONCURRENCY || renderQueue.length === 0) {
    return;
  }

  const nextJob = renderQueue.shift();
  if (!nextJob) return;

  activeRenderCount += 1;
  nextJob();
}

function enqueueRender<T>(job: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    renderQueue.push(() => {
      job()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeRenderCount -= 1;
          runNextRender();
        });
    });

    runNextRender();
  });
}

function getPendingRenderJobs() {
  return activeRenderCount + renderQueue.length;
}

function recordRenderMetrics(
  source: RenderSource,
  queueDepth: number,
  queueWaitMs: number,
  renderMs: number,
  endToEndMs: number
) {
  renderMetrics.sampleCount += 1;
  renderMetrics.sourceCount[source] += 1;
  renderMetrics.avgQueueDepth = updateEwma(renderMetrics.avgQueueDepth, queueDepth);
  renderMetrics.avgQueueWaitMs = updateEwma(renderMetrics.avgQueueWaitMs, queueWaitMs);
  renderMetrics.avgRenderMs = updateEwma(renderMetrics.avgRenderMs, renderMs);
  renderMetrics.avgEndToEndMs = updateEwma(renderMetrics.avgEndToEndMs, endToEndMs);
}

function getRenderMetricsSnapshot(): RenderMetricsSnapshot {
  return {
    sampleCount: renderMetrics.sampleCount,
    avgQueueDepth: renderMetrics.avgQueueDepth,
    avgQueueWaitMs: renderMetrics.avgQueueWaitMs,
    avgRenderMs: renderMetrics.avgRenderMs,
    avgEndToEndMs: renderMetrics.avgEndToEndMs,
    sourceCount: { ...renderMetrics.sourceCount },
  };
}

function getPerfProfile(snapshot: RenderMetricsSnapshot): PerfProfile {
  if (snapshot.sampleCount < 8) {
    return DEFAULT_PERF_PROFILE;
  }

  const highPressure = snapshot.avgQueueDepth >= 5 || snapshot.avgEndToEndMs >= 240;
  const mediumPressure = snapshot.avgQueueDepth >= 3 || snapshot.avgEndToEndMs >= 160;

  if (highPressure) {
    return {
      prefetchBefore: -1,
      prefetchAfter: 0,
      textBefore: -1,
      textAfter: 1,
      prefetchBudget: 2,
    };
  }

  if (mediumPressure) {
    return {
      prefetchBefore: -1,
      prefetchAfter: 1,
      textBefore: -2,
      textAfter: 2,
      prefetchBudget: 3,
    };
  }

  return {
    prefetchBefore: -1,
    prefetchAfter: 2,
    textBefore: -2,
    textAfter: 3,
    prefetchBudget: 5,
  };
}

function isSamePerfProfile(current: PerfProfile, next: PerfProfile) {
  return (
    current.prefetchBefore === next.prefetchBefore &&
    current.prefetchAfter === next.prefetchAfter &&
    current.textBefore === next.textBefore &&
    current.textAfter === next.textAfter &&
    current.prefetchBudget === next.prefetchBudget
  );
}

function rememberRenderedPage(cacheKey: string, value: string) {
  if (pageImageCache.has(cacheKey)) {
    pageImageCache.delete(cacheKey);
  }

  pageImageCache.set(cacheKey, value);

  if (pageImageCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = pageImageCache.keys().next().value;
    if (oldestKey) {
      pageImageCache.delete(oldestKey);
    }
  }
}

function getPreviewRenderScale(scale: number) {
  return scale;
}

function getFullRenderScale(scale: number) {
  const deviceScale = Math.min(window.devicePixelRatio || 1, 1.2);
  return scale * deviceScale;
}

function getCacheKey(pdfPath: string, pageIndex: number, scale: number) {
  return `${pdfPath}::${pageIndex}::${scale.toFixed(2)}`;
}

async function requestRenderedPage(
  pdfPath: string,
  pageIndex: number,
  scale: number,
  source: RenderSource = "visible"
) {
  const cacheKey = getCacheKey(pdfPath, pageIndex, scale);

  if (pageImageCache.has(cacheKey)) {
    return pageImageCache.get(cacheKey)!;
  }

  const pending = inflightRenders.get(cacheKey);
  if (pending) {
    return pending;
  }

  const enqueuedAt = performance.now();
  const queueDepthAtEnqueue = getPendingRenderJobs();

  const nextRequest = enqueueRender(async () => {
    const startedAt = performance.now();

    try {
      return await invoke<string>("render_page", {
        path: pdfPath,
        pageIndex,
        scale,
      });
    } finally {
      const finishedAt = performance.now();
      recordRenderMetrics(
        source,
        queueDepthAtEnqueue,
        startedAt - enqueuedAt,
        finishedAt - startedAt,
        finishedAt - enqueuedAt
      );
    }
  }).then((base64) => {
    rememberRenderedPage(cacheKey, base64);
    inflightRenders.delete(cacheKey);
    return base64;
  }).catch((error) => {
    inflightRenders.delete(cacheKey);
    throw error;
  });

  inflightRenders.set(cacheKey, nextRequest);
  return nextRequest;
}

async function ensurePdfLoaded(pdfPath: string) {
  const pending = inflightPdfLoads.get(pdfPath);
  if (pending) {
    return pending;
  }

  const loadTask = invoke("load_pdf", { path: pdfPath })
    .then(() => undefined)
    .finally(() => {
      inflightPdfLoads.delete(pdfPath);
    });

  inflightPdfLoads.set(pdfPath, loadTask);
  return loadTask;
}

/** Evict all cached pages / inflight renders for a given PDF so memory is reclaimed on tab close. */
export function clearCacheForPdf(pdfPath: string) {
  const prefix = `${pdfPath}::`;
  for (const key of pageImageCache.keys()) {
    if (key.startsWith(prefix)) {
      pageImageCache.delete(key);
    }
  }
  for (const key of inflightRenders.keys()) {
    if (key.startsWith(prefix)) {
      inflightRenders.delete(key);
    }
  }
}

export function PdfViewer({
  pdfPath,
  totalPages,
  dimensions,
  scale,
  activeTool,
  currentPage,
  searchMatches,
  activeSearchIndex,
  onAnnotationsSaved,
}: PdfViewerProps) {
  const { t } = useI18n();
  const [perfProfile, setPerfProfile] = useState<PerfProfile>(DEFAULT_PERF_PROFILE);
  const lastPerfLogAtRef = useRef(0);

  useEffect(() => {
    const updatePerfProfile = () => {
      const snapshot = getRenderMetricsSnapshot();
      const nextProfile = getPerfProfile(snapshot);

      setPerfProfile((current) => {
        if (isSamePerfProfile(current, nextProfile)) {
          return current;
        }
        return nextProfile;
      });

      if (import.meta.env.DEV) {
        const now = Date.now();
        if (now - lastPerfLogAtRef.current > 5000 && snapshot.sampleCount > 0) {
          lastPerfLogAtRef.current = now;
          console.debug("[PdfViewer perf]", {
            sampleCount: snapshot.sampleCount,
            avgQueueDepth: Number(snapshot.avgQueueDepth.toFixed(2)),
            avgQueueWaitMs: Number(snapshot.avgQueueWaitMs.toFixed(2)),
            avgRenderMs: Number(snapshot.avgRenderMs.toFixed(2)),
            avgEndToEndMs: Number(snapshot.avgEndToEndMs.toFixed(2)),
            sourceCount: snapshot.sourceCount,
            profile: nextProfile,
          });
        }
      }
    };

    const intervalId = window.setInterval(updatePerfProfile, 1500);
    updatePerfProfile();

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);
  const searchMatchesByPage = useMemo(() => {
    const grouped = new Map<number, Array<{ match: PdfSearchMatch; globalIndex: number }>>();

    searchMatches.forEach((match, globalIndex) => {
      const pageMatches = grouped.get(match.pageIndex) ?? [];
      pageMatches.push({ match, globalIndex });
      grouped.set(match.pageIndex, pageMatches);
    });

    return grouped;
  }, [searchMatches]);

  const prefetchPages = useMemo(() => {
    if (dimensions.length === 0) return new Set<number>();
    const indices = new Set<number>();
    const centerIndex = Math.max(0, currentPage - 1);

    for (let offset = perfProfile.prefetchBefore; offset <= perfProfile.prefetchAfter; offset += 1) {
      const nextIndex = centerIndex + offset;
      if (nextIndex >= 0 && nextIndex < totalPages) {
        indices.add(nextIndex);
      }
    }

    return indices;
  }, [currentPage, dimensions.length, perfProfile.prefetchAfter, perfProfile.prefetchBefore, totalPages]);

  const textLoadPages = useMemo(() => {
    if (dimensions.length === 0) return new Set<number>();
    const indices = new Set<number>();
    const centerIndex = Math.max(0, currentPage - 1);

    for (let offset = perfProfile.textBefore; offset <= perfProfile.textAfter; offset += 1) {
      const nextIndex = centerIndex + offset;
      if (nextIndex >= 0 && nextIndex < totalPages) {
        indices.add(nextIndex);
      }
    }

    return indices;
  }, [currentPage, dimensions.length, perfProfile.textAfter, perfProfile.textBefore, totalPages]);

  useEffect(() => {
    if (dimensions.length === 0) return;
    for (const pageIndex of prefetchPages) {
      if (getPendingRenderJobs() >= perfProfile.prefetchBudget) {
        break;
      }

      requestRenderedPage(pdfPath, pageIndex, getPreviewRenderScale(scale), "prefetch").catch((error) => {
        console.error(`Failed to prefetch page ${pageIndex}`, error);
      });
    }
  }, [dimensions.length, pdfPath, perfProfile.prefetchBudget, prefetchPages, scale]);

  if (dimensions.length === 0) {
    // Show a loading skeleton instead of a blank white screen while dimensions are loading
    return (
      <div className="flex flex-col items-center py-6 space-y-4 min-w-full">
        {Array.from({ length: Math.max(totalPages, 1) }).map((_, i) => (
          <div key={i} className="flex flex-col items-center space-y-3 group">
            <div
              className="bg-white shadow-[0_10px_30px_-10px_rgba(0,0,0,0.1)] relative shrink-0 border border-zinc-200/50 rounded-sm overflow-hidden"
              style={{ width: 680, height: 880 }}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-zinc-50 to-zinc-100 animate-pulse" />
              <div className="absolute top-3 right-3 rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium text-zinc-400 shadow-sm backdrop-blur-sm">
                {t("pdfViewer.pageLabel", { page: i + 1 })}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center py-6 space-y-4 min-w-full">
      {dimensions.map((dim, i) => (
        <MemoPageRender
          key={`${pdfPath}::page-${i}`}
          pdfPath={pdfPath}
          pageIndex={i}
          dimension={dim}
          scale={scale}
          activeTool={activeTool}
          shouldPrefetch={prefetchPages.has(i)}
          shouldLoadText={textLoadPages.has(i)}
          pageSearchMatches={searchMatchesByPage.get(i) ?? []}
          activeSearchIndex={activeSearchIndex}
          onAnnotationsSaved={onAnnotationsSaved}
        />
      ))}
    </div>
  );
}

interface PageRenderProps {
  pdfPath: string;
  pageIndex: number;
  dimension: PageDimension;
  scale: number;
  activeTool: ToolType;
  shouldPrefetch: boolean;
  shouldLoadText: boolean;
  pageSearchMatches: Array<{ match: PdfSearchMatch; globalIndex: number }>;
  activeSearchIndex: number;
  onAnnotationsSaved?: (pdfPath: string) => void;
}

function PageRender({
  pdfPath,
  pageIndex,
  dimension,
  scale,
  activeTool,
  shouldPrefetch,
  shouldLoadText,
  pageSearchMatches,
  activeSearchIndex,
  onAnnotationsSaved,
}: PageRenderProps) {
  const { t } = useI18n();
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const width = dimension.width * scale;
  const height = dimension.height * scale;
  const previewScale = getPreviewRenderScale(scale);
  const fullScale = getFullRenderScale(scale);
  const previewCacheKey = getCacheKey(pdfPath, pageIndex, previewScale);
  const fullCacheKey = getCacheKey(pdfPath, pageIndex, fullScale);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setIsVisible(true);
        }
      },
      { rootMargin: "1200px", threshold: 0.01 } 
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const bestCached = pageImageCache.get(fullCacheKey) ?? pageImageCache.get(previewCacheKey) ?? null;
    if (bestCached) {
      setImgSrc(bestCached);
      return;
    }

    setImgSrc(null);

    if (!isVisible && !shouldPrefetch) return;
    let isMounted = true;

    const loadPage = async () => {
      const source: RenderSource = isVisible ? "visible" : "prefetch";

      try {
        const base64 = await requestRenderedPage(pdfPath, pageIndex, previewScale, source);
        if (isMounted) setImgSrc(base64);
      } catch (err: any) {
        const errMsg = String(err);
        if (errMsg.includes('No PDF loaded') || errMsg.includes('no pdf loaded')) {
          // Backend cache was cleared (e.g. app restart/tab switch race). Re-load the PDF then retry.
          try {
            await ensurePdfLoaded(pdfPath);
            const base64 = await requestRenderedPage(pdfPath, pageIndex, previewScale, source);
            if (isMounted) setImgSrc(base64);
          } catch (retryErr) {
            console.error(`Failed to recover page ${pageIndex} after reload`, retryErr);
          }
        } else {
          console.error(`Failed to load page ${pageIndex}`, err);
        }
      }
    };

    loadPage();

    return () => { 
      isMounted = false;
    };
  }, [fullCacheKey, isVisible, pageIndex, pdfPath, previewCacheKey, previewScale, shouldPrefetch]);

  useEffect(() => {
    if ((!isVisible && !shouldPrefetch) || Math.abs(fullScale - previewScale) < 0.05) {
      return;
    }

    let isMounted = true;

    requestRenderedPage(pdfPath, pageIndex, fullScale, "refine")
      .then((base64) => {
        if (isMounted) {
          setImgSrc(base64);
        }
      })
      .catch((err) => {
        console.error(`Failed to refine page ${pageIndex}`, err);
      });

    return () => {
      isMounted = false;
    };
  }, [fullScale, isVisible, pageIndex, pdfPath, previewScale, shouldPrefetch]);

  return (
    <div id={`pdf-page-${pageIndex + 1}`} data-page-number={pageIndex + 1} className="flex flex-col items-center space-y-3 group">
      <div className="flex items-center justify-between w-full px-2">
         <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
           {t("pdfViewer.pageLabel", { page: pageIndex + 1 })}
         </span>
      </div>
      
      <div 
        ref={containerRef}
        className="bg-white shadow-[0_10px_30px_-10px_rgba(0,0,0,0.1),0_1px_4px_rgba(0,0,0,0.05)] relative select-text shrink-0 border border-zinc-200/50 rounded-sm overflow-hidden transition-shadow hover:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.15)]"
        style={{ width, height }}
      >
        {imgSrc ? (
          <img 
            src={imgSrc} 
            alt={t("pdfViewer.pageAlt", { page: pageIndex + 1 })}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none transition-opacity duration-300 ease-in" 
            onLoad={(e) => (e.currentTarget.style.opacity = "1")}
            style={{ opacity: 0 }}
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-50 to-zinc-100 animate-pulse" />
        )}

        {!imgSrc && (
          <div className="absolute top-3 right-3 rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium text-zinc-400 shadow-sm backdrop-blur-sm">
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
        
        <TextLayer pdfPath={pdfPath} pageIndex={pageIndex} scale={scale} width={width} height={height} isVisible={isVisible} shouldLoad={shouldLoadText} />
        <AnnotationLayer pdfPath={pdfPath} pageIndex={pageIndex} width={width} height={height} scale={scale} activeTool={activeTool} onAnnotationsSaved={onAnnotationsSaved} />
      </div>
    </div>
  );
}

const MemoPageRender = memo(PageRender);
