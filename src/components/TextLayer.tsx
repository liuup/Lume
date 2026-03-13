import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface TextNode {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextLayerProps {
  pdfPath: string;
  pageIndex: number;
  scale: number;
  width: number;
  height: number;
  isVisible: boolean;
  shouldLoad: boolean;
}

const textLayerCache = new Map<string, TextNode[]>();

function getTextLayerCacheKey(pdfPath: string, pageIndex: number) {
  return `${pdfPath}::${pageIndex}`;
}

export function TextLayer({ pdfPath, pageIndex, scale, width, height, isVisible, shouldLoad }: TextLayerProps) {
  const [textNodes, setTextNodes] = useState<TextNode[]>([]);
  const cacheKey = getTextLayerCacheKey(pdfPath, pageIndex);

  useEffect(() => {
    if (textLayerCache.has(cacheKey)) {
      const cached = textLayerCache.get(cacheKey) ?? [];
      setTextNodes(cached);
      return;
    }

    setTextNodes([]);

    if (!shouldLoad) return;
    let isMounted = true;

    const loadTextLayer = async () => {
      try {
        const nodes = await invoke<TextNode[]>("get_page_text", { path: pdfPath, pageIndex });
        if (isMounted) {
          textLayerCache.set(cacheKey, nodes);
          setTextNodes(nodes);
        }
      } catch (err) {
        console.error(`Failed to load text for page ${pageIndex}`, err);
      }
    };

    if (isVisible) {
      loadTextLayer();
      return () => {
        isMounted = false;
      };
    }

    const scheduler = window.requestIdleCallback
      ? window.requestIdleCallback
      : (callback: IdleRequestCallback) => window.setTimeout(() => callback({
          didTimeout: false,
          timeRemaining: () => 0,
        } as IdleDeadline), 180);
    const cancelScheduler = window.cancelIdleCallback
      ? window.cancelIdleCallback
      : (handle: number) => window.clearTimeout(handle);

    const taskId = scheduler(loadTextLayer);

    return () => {
      isMounted = false;
      cancelScheduler(taskId);
    };
  }, [cacheKey, isVisible, pageIndex, pdfPath, shouldLoad]);

  // We render if we have data, regardless of visibility, so native Cmd+F works
  if (textNodes.length === 0) return null;

  return (
    <div
      className="absolute inset-0 z-0 origin-top-left"
      style={{
        width,
        height,
      }}
    >
      {textNodes.map((node, i) => {
        // We scale the raw PDF coordinates by the current display scale
        const scaledX = node.x * scale;
        const scaledY = node.y * scale;
        const scaledWidth = node.width * scale;
        const scaledHeight = node.height * scale;
        
        // Font size approx based on rect height, typically slightly smaller to fit baseline well
        const fontSize = scaledHeight;

        return (
          <span
            key={`t-${pageIndex}-${i}`}
            // Reactivate pointer events on the actual text nodes so they can be selected
            className="absolute text-transparent select-text cursor-text origin-bottom-left selection:bg-blue-400/40 selection:text-transparent"
            style={{
              left: scaledX,
              top: scaledY,
              width: scaledWidth,
              height: scaledHeight,
              fontSize: `${fontSize}px`,
              lineHeight: `${scaledHeight}px`,
              fontFamily: 'sans-serif',
              whiteSpace: 'pre',
              pointerEvents: 'auto',
              display: 'inline-block',
              overflow: 'hidden', // prevent text spillage from confusing the browser's selection bounds
            }}
          >
            {node.text}
          </span>
        );
      })}
    </div>
  );
}
