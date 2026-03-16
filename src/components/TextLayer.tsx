import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AiTranslationResult } from "../types";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../hooks/useI18n";

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

interface TranslationPopupState {
  selectedText: string;
  x: number;
  y: number;
  result: AiTranslationResult | null;
  isLoading: boolean;
  error: string | null;
}

const textLayerCache = new Map<string, TextNode[]>();

function getTextLayerCacheKey(pdfPath: string, pageIndex: number) {
  return `${pdfPath}::${pageIndex}`;
}

export function TextLayer({ pdfPath, pageIndex, scale, width, height, isVisible, shouldLoad }: TextLayerProps) {
  const { settings } = useSettings();
  const { t } = useI18n();
  const [textNodes, setTextNodes] = useState<TextNode[]>([]);
  const [translationPopup, setTranslationPopup] = useState<TranslationPopupState | null>(null);
  const cacheKey = getTextLayerCacheKey(pdfPath, pageIndex);
  const requestIdRef = useRef(0);
  const layerRef = useRef<HTMLDivElement>(null);

  const getSelectionRect = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const layerElement = layerRef.current;
    if (!layerElement || !(anchorNode && layerElement.contains(anchorNode)) || !(focusNode && layerElement.contains(focusNode))) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return null;
    }

    return {
      selectedText: selection.toString().trim(),
      x: rect.left + rect.width / 2,
      y: rect.bottom + 10,
    };
  };

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

  useEffect(() => {
    const hidePopup = () => {
      setTranslationPopup(null);
    };

    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setTranslationPopup((current) => (current?.isLoading ? current : null));
      }
    };

    const syncPopupPosition = () => {
      setTranslationPopup((current) => {
        if (!current) return null;

        const nextRect = getSelectionRect();
        if (!nextRect || !nextRect.selectedText) {
          return current.isLoading ? current : null;
        }

        return {
          ...current,
          selectedText: nextRect.selectedText,
          x: nextRect.x,
          y: nextRect.y,
        };
      });
    };

    document.addEventListener("mousedown", hidePopup);
    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("scroll", syncPopupPosition, true);
    window.addEventListener("resize", syncPopupPosition);

    return () => {
      document.removeEventListener("mousedown", hidePopup);
      document.removeEventListener("selectionchange", handleSelectionChange);
      window.removeEventListener("scroll", syncPopupPosition, true);
      window.removeEventListener("resize", syncPopupPosition);
    };
  }, []);

  const handleMouseUp = async () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const layerElement = layerRef.current;
    if (!layerElement || !(anchorNode && layerElement.contains(anchorNode)) || !(focusNode && layerElement.contains(focusNode))) {
      return;
    }
    const selectionRect = getSelectionRect();
    if (!selectionRect || !selectionRect.selectedText) {
      return;
    }

    const aiIsConfigured = Boolean(settings.aiApiKey.trim() && settings.aiCompletionUrl.trim() && settings.aiModel.trim());

    if (!aiIsConfigured) {
      setTranslationPopup({
        selectedText,
        x: selectionRect.x,
        y: selectionRect.y,
        result: null,
        isLoading: false,
        error: t("textLayer.translation.notConfigured"),
      });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setTranslationPopup({
      selectedText,
      x: selectionRect.x,
      y: selectionRect.y,
      result: null,
      isLoading: true,
      error: null,
    });

    try {
      const result = await invoke<AiTranslationResult>("translate_selection", {
        text: selectedText,
        targetLanguage: settings.aiTranslateTargetLanguage,
      });

      if (requestIdRef.current !== requestId) return;

      setTranslationPopup({
        selectedText,
        x: selectionRect.x,
        y: selectionRect.y,
        result,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      console.error("Failed to translate selection", error);
      setTranslationPopup({
        selectedText,
        x: selectionRect.x,
        y: selectionRect.y,
        result: null,
        isLoading: false,
        error: t("textLayer.translation.error"),
      });
    }
  };

  // We render if we have data, regardless of visibility, so native Cmd+F works
  if (textNodes.length === 0) return null;

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 z-0 origin-top-left"
      style={{
        width,
        height,
      }}
      onMouseUp={() => { void handleMouseUp(); }}
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
      {translationPopup && (
        <div
          className="fixed z-[70] w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-[0_18px_45px_-18px_rgba(0,0,0,0.28)] backdrop-blur-sm"
          style={{
            left: translationPopup.x,
            top: translationPopup.y,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600">
            {t("textLayer.translation.title", { language: settings.aiTranslateTargetLanguage || "zh-CN" })}
          </div>
          <div className="mt-1 text-xs leading-relaxed text-zinc-500 line-clamp-3">
            {translationPopup.selectedText}
          </div>
          <div className="mt-2 text-sm leading-relaxed text-zinc-700 whitespace-pre-wrap">
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
