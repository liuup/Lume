import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SearchRect } from "../types";

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
  onSelectionRequest?: (pageIndex: number, snapshot: TextLayerSelectionSnapshot) => void;
  registerSelectionController?: (pageIndex: number, controller: TextLayerSelectionController | null) => void;
}

export interface TextLayerSelectionSnapshot {
  selectedText: string;
  x: number;
  y: number;
  selection: SearchRect;
}

export interface TextLayerSelectionController {
  getSelectionSnapshot: () => TextLayerSelectionSnapshot | null;
}

const textLayerCache = new Map<string, TextNode[]>();

function getTextLayerCacheKey(pdfPath: string, pageIndex: number) {
  return `${pdfPath}::${pageIndex}`;
}

function normalizeSelectedText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .trim();
}

export function TextLayer({
  pdfPath,
  pageIndex,
  scale,
  width,
  height,
  isVisible,
  shouldLoad,
  onSelectionRequest,
  registerSelectionController,
}: TextLayerProps) {
  const [textNodes, setTextNodes] = useState<TextNode[]>([]);
  const cacheKey = getTextLayerCacheKey(pdfPath, pageIndex);
  const layerRef = useRef<HTMLDivElement>(null);
  const spanRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const naturalWidthsRef = useRef<number[]>([]);
  const selectionSnapshotGetterRef = useRef<() => TextLayerSelectionSnapshot | null>(() => null);

  const extractSelectedTextFromLayer = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return "";
    }

    const range = selection.getRangeAt(0);
    const layerElement = layerRef.current;
    if (!layerElement) {
      return "";
    }

    const selectedSegments: Array<{ index: number; text: string; node: TextNode }> = [];

    spanRefs.current.forEach((span, index) => {
      if (!span || !range.intersectsNode(span)) {
        return;
      }

      const textNode = span.firstChild;
      const nodeMeta = textNodes[index];
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !nodeMeta) {
        return;
      }

      const fullText = textNode.textContent ?? "";
      let start = 0;
      let end = fullText.length;

      if (textNode === range.startContainer) {
        start = range.startOffset;
      }
      if (textNode === range.endContainer) {
        end = range.endOffset;
      }

      const slice = fullText.slice(start, end);
      if (!slice) {
        return;
      }

      selectedSegments.push({
        index,
        text: slice,
        node: nodeMeta,
      });
    });

    if (selectedSegments.length === 0) {
      return "";
    }

    selectedSegments.sort((left, right) => left.index - right.index);

    let rebuilt = "";
    let previous: { text: string; node: TextNode } | null = null;

    for (const segment of selectedSegments) {
      if (previous) {
        const sameLine = Math.abs(previous.node.y - segment.node.y) < Math.max(previous.node.height, segment.node.height) * 0.45;
        const horizontalGap = segment.node.x - (previous.node.x + previous.node.width);
        const shouldInsertLineBreak = !sameLine;
        const shouldInsertSpace = sameLine
          && horizontalGap > Math.max(previous.node.height, segment.node.height) * 0.25
          && !rebuilt.endsWith(" ")
          && !segment.text.startsWith(" ");

        if (shouldInsertLineBreak && !rebuilt.endsWith("\n")) {
          rebuilt += "\n";
        } else if (shouldInsertSpace) {
          rebuilt += " ";
        }
      }

      rebuilt += segment.text;
      previous = segment;
    }

    return normalizeSelectedText(rebuilt);
  };

  const isSelectionInsideLayer = () => {
    const selection = window.getSelection();
    const layerElement = layerRef.current;

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !layerElement) {
      return false;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;

    return Boolean(
      anchorNode
        && focusNode
        && layerElement.contains(anchorNode)
        && layerElement.contains(focusNode)
    );
  };

  const getSelectionRect = () => {
    const selection = window.getSelection();
    const layerElement = layerRef.current;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    if (!isSelectionInsideLayer()) {
      return null;
    }

    if (!layerElement) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return null;
    }

    const layerRect = layerElement.getBoundingClientRect();
    const left = Math.max(0, rect.left - layerRect.left);
    const top = Math.max(0, rect.top - layerRect.top);
    const right = Math.min(layerRect.width, rect.right - layerRect.left);
    const bottom = Math.min(layerRect.height, rect.bottom - layerRect.top);

    return {
      selectedText: normalizeSelectedText(extractSelectedTextFromLayer() || selection.toString()),
      x: rect.left + rect.width / 2,
      y: rect.bottom + 10,
      selection: {
        x: left / scale,
        y: top / scale,
        width: Math.max(0, right - left) / scale,
        height: Math.max(0, bottom - top) / scale,
      },
    };
  };

  selectionSnapshotGetterRef.current = getSelectionRect;

  useEffect(() => {
    if (textLayerCache.has(cacheKey)) {
      const cached = textLayerCache.get(cacheKey) ?? [];
      setTextNodes(cached);
      return;
    }

    setTextNodes([]);

    if (!shouldLoad || !isVisible) return;
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

    loadTextLayer();

    return () => {
      isMounted = false;
    };
  }, [cacheKey, isVisible, pageIndex, pdfPath, shouldLoad]);

  useLayoutEffect(() => {
    if (textNodes.length === 0) {
      naturalWidthsRef.current = [];
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      spanRefs.current.forEach((span, index) => {
        if (!span) {
          return;
        }

        span.style.transform = "none";
        const naturalWidth = span.scrollWidth || span.getBoundingClientRect().width;
        naturalWidthsRef.current[index] = naturalWidth > 0 && Number.isFinite(naturalWidth) ? naturalWidth : 0;
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [textNodes]);

  useLayoutEffect(() => {
    if (textNodes.length === 0) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      spanRefs.current.forEach((span, index) => {
        const node = textNodes[index];
        const naturalWidth = naturalWidthsRef.current[index];
        if (!span || !node || !naturalWidth) {
          return;
        }

        const targetWidth = Math.max(node.width * scale, 1);
        const scaleX = Math.max(0.01, targetWidth / naturalWidth);
        span.style.transform = `scaleX(${scaleX})`;
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [scale, textNodes]);

  useEffect(() => {
    registerSelectionController?.(pageIndex, {
      getSelectionSnapshot: () => selectionSnapshotGetterRef.current(),
    });
    return () => {
      registerSelectionController?.(pageIndex, null);
    };
  }, [pageIndex, registerSelectionController]);

  if (textNodes.length === 0) return null;

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 z-0 origin-top-left"
      style={{
        width,
        height,
      }}
      onCopy={(event) => {
        if (!isSelectionInsideLayer()) {
          return;
        }

        const selectedText = extractSelectedTextFromLayer();
        if (!selectedText) {
          return;
        }

        event.preventDefault();
        event.clipboardData.setData("text/plain", selectedText);
      }}
      onMouseUp={() => {
        const selectionRect = getSelectionRect();
        if (selectionRect?.selectedText) {
          onSelectionRequest?.(pageIndex, selectionRect);
        }
      }}
    >
      {textNodes.map((node, i) => {
        // We scale the raw PDF coordinates by the current display scale
        const scaledX = node.x * scale;
        const scaledY = node.y * scale;
        const scaledHeight = node.height * scale;
        
        // Font size approx based on rect height, typically slightly smaller to fit baseline well
        const fontSize = scaledHeight;

        return (
          <span
            key={`t-${pageIndex}-${i}`}
            ref={(element) => {
              spanRefs.current[i] = element;
            }}
            // Reactivate pointer events on the actual text nodes so they can be selected
            className="absolute text-transparent select-text cursor-text origin-bottom-left selection:bg-blue-400/40 selection:text-transparent"
            style={{
              left: scaledX,
              top: scaledY,
              height: scaledHeight,
              fontSize: `${fontSize}px`,
              lineHeight: `${scaledHeight}px`,
              fontFamily: 'sans-serif',
              whiteSpace: 'pre',
              pointerEvents: 'auto',
              display: 'inline-block',
              transformOrigin: 'top left',
            }}
          >
            {node.text}
          </span>
        );
      })}
    </div>
  );
}
