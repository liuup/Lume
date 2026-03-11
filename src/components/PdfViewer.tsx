import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PageDimension, ToolType } from "../types";
import { AnnotationLayer } from "./AnnotationLayer";
import { TextLayer } from "./TextLayer";

interface PdfViewerProps {
  pdfPath: string;
  totalPages: number;
  dimensions: PageDimension[];
  scale: number;
  activeTool: ToolType;
  currentPage: number;
  onAnnotationsSaved?: (pdfPath: string) => void;
}

const pageImageCache = new Map<string, string>();
const inflightRenders = new Map<string, Promise<string>>();
const renderQueue: Array<() => void> = [];
const MAX_RENDER_CONCURRENCY = 2;
const MAX_CACHE_ENTRIES = 120;
let activeRenderCount = 0;

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

async function requestRenderedPage(pdfPath: string, pageIndex: number, scale: number) {
  const cacheKey = getCacheKey(pdfPath, pageIndex, scale);

  if (pageImageCache.has(cacheKey)) {
    return pageImageCache.get(cacheKey)!;
  }

  const pending = inflightRenders.get(cacheKey);
  if (pending) {
    return pending;
  }

  const nextRequest = enqueueRender(() => invoke<string>("render_page", {
    path: pdfPath,
    pageIndex,
    scale,
  })).then((base64) => {
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

export function PdfViewer({ pdfPath, totalPages, dimensions, scale, activeTool, currentPage, onAnnotationsSaved }: PdfViewerProps) {
  const prefetchPages = useMemo(() => {
    if (dimensions.length === 0) return [];
    const indices: number[] = [];
    const centerIndex = Math.max(0, currentPage - 1);

    for (let offset = -1; offset <= 2; offset += 1) {
      const nextIndex = centerIndex + offset;
      if (nextIndex >= 0 && nextIndex < totalPages) {
        indices.push(nextIndex);
      }
    }

    return indices;
  }, [currentPage, totalPages, dimensions.length]);

  useEffect(() => {
    if (dimensions.length === 0) return;
    prefetchPages.forEach((pageIndex) => {
      requestRenderedPage(pdfPath, pageIndex, getPreviewRenderScale(scale)).catch((error) => {
        console.error(`Failed to prefetch page ${pageIndex}`, error);
      });
    });
  }, [pdfPath, prefetchPages, scale, dimensions.length]);

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
                Page {i + 1}
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
          key={`page-${i}`}
          pdfPath={pdfPath}
          pageIndex={i}
          dimension={dim}
          scale={scale}
          activeTool={activeTool}
          shouldPrefetch={prefetchPages.includes(i)}
          shouldLoadText={true}
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
  onAnnotationsSaved?: (pdfPath: string) => void;
}

function PageRender({ pdfPath, pageIndex, dimension, scale, activeTool, shouldPrefetch, shouldLoadText, onAnnotationsSaved }: PageRenderProps) {
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

    if (!isVisible && !shouldPrefetch) return;
    let isMounted = true;

    const loadPage = async () => {
      try {
        const base64 = await requestRenderedPage(pdfPath, pageIndex, previewScale);
        if (isMounted) setImgSrc(base64);
      } catch (err: any) {
        const errMsg = String(err);
        if (errMsg.includes('No PDF loaded') || errMsg.includes('no pdf loaded')) {
          // Backend cache was cleared (e.g. app restart/tab switch race). Re-load the PDF then retry.
          try {
            await invoke('load_pdf', { path: pdfPath });
            const base64 = await requestRenderedPage(pdfPath, pageIndex, previewScale);
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

    requestRenderedPage(pdfPath, pageIndex, fullScale)
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
           Page {pageIndex + 1}
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
            alt={`Page ${pageIndex + 1}`} 
            className="absolute inset-0 w-full h-full object-contain pointer-events-none transition-opacity duration-300 ease-in" 
            onLoad={(e) => (e.currentTarget.style.opacity = "1")}
            style={{ opacity: 0 }}
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-50 to-zinc-100 animate-pulse" />
        )}

        {!imgSrc && (
          <div className="absolute top-3 right-3 rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium text-zinc-400 shadow-sm backdrop-blur-sm">
            Page {pageIndex + 1}
          </div>
        )}
        
        <TextLayer pdfPath={pdfPath} pageIndex={pageIndex} scale={scale} width={width} height={height} isVisible={isVisible} shouldLoad={shouldLoadText} />
        <AnnotationLayer pdfPath={pdfPath} pageIndex={pageIndex} width={width} height={height} scale={scale} activeTool={activeTool} onAnnotationsSaved={onAnnotationsSaved} />
      </div>
    </div>
  );
}

const MemoPageRender = memo(PageRender);
