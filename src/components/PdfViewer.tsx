import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PageDimension, ToolType } from "../App";
import { AnnotationLayer } from "./AnnotationLayer";

interface PdfViewerProps {
  totalPages: number;
  dimensions: PageDimension[];
  scale: number;
  activeTool: ToolType;
}

export function PdfViewer({ totalPages, dimensions, scale, activeTool }: PdfViewerProps) {
  // If dimensions aren't loaded yet, don't render.
  if (dimensions.length === 0) return null;

  return (
    <div className="flex flex-col items-center py-8 space-y-6">
      {Array.from({ length: totalPages }).map((_, i) => (
        <PageRender 
          key={`page-${i}`} 
          pageIndex={i} 
          dimension={dimensions[i]} 
          scale={scale} 
          activeTool={activeTool}
        />
      ))}
    </div>
  );
}

interface PageRenderProps {
  pageIndex: number;
  dimension: PageDimension;
  scale: number;
  activeTool: ToolType;
}

function PageRender({ pageIndex, dimension, scale, activeTool }: PageRenderProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Intersection Observer for Lazy Loading
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // use rootMargin to preload pages right outside the viewport
        if (entries[0].isIntersecting) {
          setIsVisible(true);
        }
      },
      { rootMargin: "400px" } 
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fetch Page Image over IPC
  useEffect(() => {
    if (!isVisible) return;
    let isMounted = true;

    async function loadPage() {
      try {
        const base64 = await invoke<string>("render_page", { 
          pageIndex, 
          scale 
        });
        if (isMounted) {
          setImgSrc(base64);
        }
      } catch (err) {
        console.error(`Failed to load page ${pageIndex}`, err);
      }
    }

    loadPage();
    return () => { isMounted = false; };
  }, [isVisible, pageIndex, scale]);

  const width = dimension.width * scale;
  const height = dimension.height * scale;

  return (
    <div 
      ref={containerRef}
      className="bg-white shadow-xl relative select-none shrink-0 border border-gray-100"
      style={{ width, height }}
    >
      {imgSrc ? (
        <img 
          src={imgSrc} 
          alt={`Page ${pageIndex + 1}`} 
          className="absolute inset-0 w-full h-full object-contain pointer-events-none" 
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-gray-300 font-mono">
          Page {pageIndex + 1}
        </div>
      )}
      
      {/* 
        Phase 5 annotation layer mounts right here on top of the image container. 
        It has precise width and height matching the page.
      */}
      <AnnotationLayer pageIndex={pageIndex} width={width} height={height} scale={scale} activeTool={activeTool} />
    </div>
  );
}
