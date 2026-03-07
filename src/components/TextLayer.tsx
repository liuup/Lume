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
  pageIndex: number;
  scale: number;
  width: number;
  height: number;
  isVisible: boolean;
}

export function TextLayer({ pageIndex, scale, width, height, isVisible }: TextLayerProps) {
  const [textNodes, setTextNodes] = useState<TextNode[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!isVisible || isLoaded) return;
    let isMounted = true;

    async function loadText() {
      try {
        const nodes = await invoke<TextNode[]>("get_page_text", { pageIndex });
        if (isMounted) {
          setTextNodes(nodes);
          setIsLoaded(true);
        }
      } catch (err) {
        console.error(`Failed to load text for page ${pageIndex}`, err);
      }
    }

    loadText();
    return () => {
      isMounted = false;
    };
  }, [isVisible, pageIndex, isLoaded]);

  // We only render when we have both visibility and data
  if (!isVisible || textNodes.length === 0) return null;

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
        const fontSize = scaledHeight * 0.9;

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
              lineHeight: 1,
              fontFamily: 'sans-serif',
              whiteSpace: 'pre',
              pointerEvents: 'auto',
              // We anchor text to its bottom/height to align standard web fonts closely with PDF baselines
              display: 'flex',
              alignItems: 'flex-end',
            }}
          >
            {node.text}
          </span>
        );
      })}
    </div>
  );
}
