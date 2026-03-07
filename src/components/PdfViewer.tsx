import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PageDimension, ToolType } from "../App";
import { AnnotationLayer } from "./AnnotationLayer";
import { TextLayer } from "./TextLayer";

interface PdfViewerProps {
  pdfPath: string;
  totalPages: number;
  dimensions: PageDimension[];
  scale: number;
  activeTool: ToolType;
}

export function PdfViewer({ pdfPath, totalPages, dimensions, scale, activeTool }: PdfViewerProps) {
  if (dimensions.length === 0) return null;

  return (
    <div className="flex flex-col items-center py-6 space-y-4 min-w-full">
      {Array.from({ length: totalPages }).map((_, i) => (
        <PageRender 
          key={`page-${i}`} 
          pdfPath={pdfPath}
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
  pdfPath: string;
  pageIndex: number;
  dimension: PageDimension;
  scale: number;
  activeTool: ToolType;
}

function PageRender({ pdfPath, pageIndex, dimension, scale, activeTool }: PageRenderProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setIsVisible(true);
        }
      },
      { rootMargin: "3000px" } 
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    let isMounted = true;

    const timer = setTimeout(async () => {
      try {
        const base64 = await invoke<string>("render_page", { 
          path: pdfPath,
          pageIndex, 
          scale: scale * (window.devicePixelRatio || 1) // High resolution rendering
        });
        if (isMounted) {
          setImgSrc(base64);
        }
      } catch (err) {
        console.error(`Failed to load page ${pageIndex}`, err);
      }
    }, 150);

    return () => { 
      isMounted = false;
      clearTimeout(timer);
    };
  }, [isVisible, pageIndex, scale, pdfPath]);

  const width = dimension.width * scale;
  const height = dimension.height * scale;

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
          <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4">
            <div className="w-8 h-8 border-2 border-zinc-200 border-t-zinc-400 rounded-full animate-spin" />
            <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-tighter">
              Loading Page {pageIndex + 1}
            </div>
          </div>
        )}
        
        <TextLayer pdfPath={pdfPath} pageIndex={pageIndex} scale={scale} width={width} height={height} isVisible={isVisible} />
        <AnnotationLayer pageIndex={pageIndex} width={width} height={height} scale={scale} activeTool={activeTool} />
      </div>
    </div>
  );
}
