import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useCallback } from "react";
import { ToolType } from "../types";

interface AnnotationLayerProps {
  pdfPath: string;
  pageIndex: number;
  width: number;
  height: number;
  scale: number;
  activeTool: ToolType;
}

interface Point {
  x: number; // Unscaled
  y: number; // Unscaled
}

interface Path {
  tool: ToolType;
  points: Point[];
}

interface SavedPageAnnotations {
  paths: Path[];
  textAnnotations: TextAnnotation[];
}

/** A committed text annotation (stores unscaled position + content). */
interface TextAnnotation {
  x: number;        // unscaled
  y: number;        // unscaled (top of text baseline area)
  text: string;
  /** Font size in unscaled PDF points. 13 pt reads comfortably at typical zoom levels. */
  fontSize: number;
}

/** The live in-progress text input (before the user blurs / presses Escape). */
interface ActiveTextInput {
  x: number;  // unscaled
  y: number;  // unscaled
}

// Base font size in unscaled PDF points. At scale 1.5 → ~20px on screen, readable as a margin note.
const BASE_FONT_SIZE = 13;
const FONT_FAMILY = "system-ui, -apple-system, sans-serif";

export function AnnotationLayer({ pdfPath, pageIndex, width, height, scale, activeTool }: AnnotationLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasLoadedAnnotationsRef = useRef(false);
  const latestSaveRequestRef = useRef(0);

  const [paths, setPaths] = useState<Path[]>([]);
  const [currentPath, setCurrentPath] = useState<Path | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  const [textAnnotations, setTextAnnotations] = useState<TextAnnotation[]>([]);
  const [activeTextInput, setActiveTextInput] = useState<ActiveTextInput | null>(null);

  useEffect(() => {
    let isMounted = true;
    hasLoadedAnnotationsRef.current = false;
    setPaths([]);
    setCurrentPath(null);
    setIsDrawing(false);
    setTextAnnotations([]);
    setActiveTextInput(null);

    invoke<SavedPageAnnotations>("load_pdf_annotations", { path: pdfPath, pageIndex })
      .then((saved) => {
        if (!isMounted) return;
        setPaths(saved.paths ?? []);
        setTextAnnotations(saved.textAnnotations ?? []);
      })
      .catch((error) => {
        console.error(`Failed to load annotations for page ${pageIndex + 1}`, error);
      })
      .finally(() => {
        if (isMounted) {
          hasLoadedAnnotationsRef.current = true;
        }
      });

    return () => {
      isMounted = false;
    };
  }, [pdfPath, pageIndex]);

  useEffect(() => {
    if (!hasLoadedAnnotationsRef.current) return;

    const requestId = latestSaveRequestRef.current + 1;
    latestSaveRequestRef.current = requestId;

    const timer = window.setTimeout(() => {
      const payload: SavedPageAnnotations = {
        paths,
        textAnnotations,
      };

      invoke("save_pdf_annotations", { path: pdfPath, pageIndex, annotations: payload }).catch((error) => {
        if (latestSaveRequestRef.current === requestId) {
          console.error(`Failed to save annotations for page ${pageIndex + 1}`, error);
        }
      });
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [paths, textAnnotations, pdfPath, pageIndex]);

  // ── Canvas redraw ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Draw committed text annotations
    const scaledFontSize = BASE_FONT_SIZE * scale;
    const lineHeight = scaledFontSize * 1.35;
    ctx.font = `${scaledFontSize}px ${FONT_FAMILY}`;
    ctx.fillStyle = "rgba(20, 20, 20, 0.92)";
    ctx.globalCompositeOperation = "source-over";

    for (const ann of textAnnotations) {
      const lines = ann.text.split("\n");
      const x = ann.x * scale;
      const y = ann.y * scale + scaledFontSize; // baseline offset
      lines.forEach((line, i) => {
        ctx.fillText(line, x, y + i * lineHeight);
      });
    }

    // Draw freehand paths (highlight / draw)
    const allPaths = [...paths, ...(currentPath ? [currentPath] : [])];
    for (const path of allPaths) {
      if (path.points.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(path.points[0].x * scale, path.points[0].y * scale);
      for (let i = 1; i < path.points.length; i++) {
        ctx.lineTo(path.points[i].x * scale, path.points[i].y * scale);
      }
      if (path.tool === "highlight") {
        ctx.strokeStyle = "rgba(255, 235, 59, 0.45)";
        ctx.lineWidth = 14 * scale;
        ctx.lineCap = "square";
        ctx.lineJoin = "bevel";
        ctx.globalCompositeOperation = "multiply";
      } else {
        ctx.strokeStyle = "rgba(43, 108, 208, 0.85)";
        ctx.lineWidth = 2 * scale;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    }
  }, [paths, currentPath, width, height, scale, textAnnotations]);

  // Auto-focus textarea when it appears
  useEffect(() => {
    if (activeTextInput) {
      // Small delay so the element is mounted and positioned before focus
      setTimeout(() => textareaRef.current?.focus(), 30);
    }
  }, [activeTextInput]);

  // ── Commit the active text input ─────────────────────────────────────────────
  const commitTextInput = useCallback(() => {
    if (!activeTextInput || !textareaRef.current) return;
    const text = textareaRef.current.value.trim();
    if (text) {
      setTextAnnotations(prev => [
        ...prev,
        { x: activeTextInput.x, y: activeTextInput.y, text, fontSize: BASE_FONT_SIZE },
      ]);
    }
    setActiveTextInput(null);
  }, [activeTextInput]);

  // ── Pointer events ────────────────────────────────────────────────────────────
  const getUnscaledPoint = (e: React.MouseEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  };

  const handlePointerDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === "none") return;
    const point = getUnscaledPoint(e);
    if (!point) return;

    if (activeTool === "text-highlight") {
      // If there's already an active input, commit it first
      commitTextInput();
      // Then open a new one at the click position
      setActiveTextInput({ x: point.x, y: point.y });
      return;
    }

    // Freehand
    setIsDrawing(true);
    setCurrentPath({ tool: activeTool, points: [point] });
  };

  const handlePointerMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !currentPath || activeTool === "none") return;
    const point = getUnscaledPoint(e);
    if (!point) return;
    setCurrentPath({ ...currentPath, points: [...currentPath.points, point] });
  };

  const handlePointerUp = () => {
    if (isDrawing && currentPath) {
      setPaths(prev => [...prev, currentPath]);
      setCurrentPath(null);
      setIsDrawing(false);
    }
  };

  const handlePointerLeave = handlePointerUp;

  // ── Textarea key handling ─────────────────────────────────────────────────────
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      setActiveTextInput(null); // discard
    }
    // Enter alone does NOT commit (allows multiline); Shift+Enter would be natural for newlines.
    // Commit only on blur or Escape.
  };

  const isInteractive = activeTool !== "none";

  // Scaled textarea position and font size
  const scaledFontSize = BASE_FONT_SIZE * scale;

  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      {/* Canvas for freehand + committed text */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 touch-none"
        style={{
          width,
          height,
          pointerEvents: isInteractive && !activeTextInput ? "auto" : "none",
          cursor:
            activeTool === "text-highlight" ? "text" :
            activeTool === "highlight" ? "text" :
            activeTool === "draw" ? "crosshair" : "default",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      />

      {/* Live text input overlay — only rendered when the user has clicked to type */}
      {activeTextInput && (
        <textarea
          ref={textareaRef}
          onKeyDown={handleTextareaKeyDown}
          onBlur={commitTextInput}
          // Stop canvas events leaking through so scrolling stays possible on blur
          onClick={e => e.stopPropagation()}
          rows={1}
          style={{
            position: "absolute",
            left: activeTextInput.x * scale,
            top: activeTextInput.y * scale,
            fontSize: scaledFontSize,
            lineHeight: 1.35,
            fontFamily: FONT_FAMILY,
            color: "rgba(20, 20, 20, 0.92)",
            background: "rgba(255, 251, 200, 0.45)",      // very subtle yellow tint
            border: "1.5px solid rgba(99, 102, 241, 0.55)", // indigo dashed-feel outline
            borderRadius: 3,
            outline: "none",
            resize: "none",
            minWidth: 120,
            maxWidth: width - activeTextInput.x * scale - 8,
            padding: "2px 4px",
            overflow: "hidden",
            zIndex: 20,
            boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
          }}
          // Auto-grow height as user types
          onInput={e => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = el.scrollHeight + "px";
          }}
        />
      )}
    </div>
  );
}
