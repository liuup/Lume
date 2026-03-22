import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useCallback } from "react";
import { SearchRect, ToolType } from "../types";

interface AnnotationLayerProps {
  pdfPath: string;
  pageIndex: number;
  refreshKey?: number;
  width: number;
  height: number;
  scale: number;
  isColorInverted: boolean;
  activeTool: ToolType;
  onAnnotationsSaved?: (pdfPath: string) => void;
  registerHistoryController?: (pageIndex: number, controller: AnnotationHistoryController | null) => void;
  onHistoryStateChange?: (pageIndex: number, state: AnnotationHistoryState) => void;
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

export interface AnnotationHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

export interface AnnotationHistoryController {
  undo: () => void;
  redo: () => void;
  addTextHighlightRects: (rects: SearchRect[]) => void;
  getHistoryState: () => AnnotationHistoryState;
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
const MAX_HISTORY_ENTRIES = 50;

function cloneSavedPageAnnotations(snapshot: SavedPageAnnotations): SavedPageAnnotations {
  return {
    paths: snapshot.paths.map((path) => ({
      tool: path.tool,
      points: path.points.map((point) => ({ ...point })),
    })),
    textAnnotations: snapshot.textAnnotations.map((annotation) => ({ ...annotation })),
  };
}

function createHighlightPathFromRect(rect: SearchRect): Path {
  return {
    tool: "highlight",
    points: [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height },
      { x: rect.x, y: rect.y },
    ],
  };
}

function getPathBounds(path: Path) {
  if (path.points.length === 0) {
    return null;
  }

  const xs = path.points.map((point) => point.x);
  const ys = path.points.map((point) => point.y);

  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function isClosedHighlightRect(path: Path) {
  if (path.tool !== "highlight" || path.points.length < 5) {
    return false;
  }

  const first = path.points[0];
  const last = path.points[path.points.length - 1];
  return Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01;
}

export function AnnotationLayer({
  pdfPath,
  pageIndex,
  refreshKey = 0,
  width,
  height,
  scale,
  isColorInverted,
  activeTool,
  onAnnotationsSaved,
  registerHistoryController,
  onHistoryStateChange,
}: AnnotationLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasLoadedAnnotationsRef = useRef(false);
  const latestSaveRequestRef = useRef(0);
  const hasPushedHistoryInStrokeRef = useRef(false);

  const [paths, setPaths] = useState<Path[]>([]);
  const [currentPath, setCurrentPath] = useState<Path | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  const [textAnnotations, setTextAnnotations] = useState<TextAnnotation[]>([]);
  const [activeTextInput, setActiveTextInput] = useState<ActiveTextInput | null>(null);
  const [undoStack, setUndoStack] = useState<SavedPageAnnotations[]>([]);
  const [redoStack, setRedoStack] = useState<SavedPageAnnotations[]>([]);

  const getCurrentSnapshot = useCallback(() => cloneSavedPageAnnotations({
    paths,
    textAnnotations,
  }), [paths, textAnnotations]);

  const applySnapshot = useCallback((snapshot: SavedPageAnnotations) => {
    const cloned = cloneSavedPageAnnotations(snapshot);
    setPaths(cloned.paths);
    setTextAnnotations(cloned.textAnnotations);
    setCurrentPath(null);
    setActiveTextInput(null);
  }, []);

  const pushHistorySnapshot = useCallback((snapshot: SavedPageAnnotations) => {
    setUndoStack((previous) => [...previous.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneSavedPageAnnotations(snapshot)]);
    setRedoStack([]);
  }, []);

  const addTextHighlightRects = useCallback((rects: SearchRect[]) => {
    const normalizedRects = rects.filter((rect) => rect.width > 0 && rect.height > 0);
    if (normalizedRects.length === 0) {
      return;
    }

    const currentSnapshot = getCurrentSnapshot();
    pushHistorySnapshot(currentSnapshot);
    setPaths((previous) => [
      ...previous,
      ...normalizedRects.map(createHighlightPathFromRect),
    ]);
  }, [getCurrentSnapshot, pushHistorySnapshot]);

  const undo = useCallback(() => {
    if (undoStack.length === 0) {
      return;
    }

    const previous = undoStack[undoStack.length - 1];
    const current = getCurrentSnapshot();
    setUndoStack((entries) => entries.slice(0, -1));
    setRedoStack((entries) => [...entries.slice(-(MAX_HISTORY_ENTRIES - 1)), current]);
    applySnapshot(previous);
  }, [applySnapshot, getCurrentSnapshot, undoStack]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) {
      return;
    }

    const next = redoStack[redoStack.length - 1];
    const current = getCurrentSnapshot();
    setRedoStack((entries) => entries.slice(0, -1));
    setUndoStack((entries) => [...entries.slice(-(MAX_HISTORY_ENTRIES - 1)), current]);
    applySnapshot(next);
  }, [applySnapshot, getCurrentSnapshot, redoStack]);

  useEffect(() => {
    let isMounted = true;
    hasLoadedAnnotationsRef.current = false;
    hasPushedHistoryInStrokeRef.current = false;
    setPaths([]);
    setCurrentPath(null);
    setIsDrawing(false);
    setTextAnnotations([]);
    setActiveTextInput(null);
    setUndoStack([]);
    setRedoStack([]);

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
  }, [pdfPath, pageIndex, refreshKey]);

  useEffect(() => {
    const state = {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    };
    onHistoryStateChange?.(pageIndex, state);
  }, [onHistoryStateChange, pageIndex, redoStack.length, undoStack.length]);

  useEffect(() => {
    registerHistoryController?.(pageIndex, {
      undo,
      redo,
      addTextHighlightRects,
      getHistoryState: () => ({
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
      }),
    });

    return () => {
      registerHistoryController?.(pageIndex, null);
    };
  }, [addTextHighlightRects, pageIndex, redo, registerHistoryController, undo, redoStack.length, undoStack.length]);

  useEffect(() => {
    if (!hasLoadedAnnotationsRef.current) return;

    const requestId = latestSaveRequestRef.current + 1;
    latestSaveRequestRef.current = requestId;

    const timer = window.setTimeout(() => {
      const payload: SavedPageAnnotations = {
        paths,
        textAnnotations,
      };

      invoke("save_pdf_annotations", { path: pdfPath, pageIndex, annotations: payload })
        .then(() => {
          if (latestSaveRequestRef.current === requestId) {
            onAnnotationsSaved?.(pdfPath);
          }
        })
        .catch((error) => {
          if (latestSaveRequestRef.current === requestId) {
            console.error(`Failed to save annotations for page ${pageIndex + 1}`, error);
          }
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [paths, textAnnotations, pdfPath, pageIndex, onAnnotationsSaved]);

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
    ctx.fillStyle = isColorInverted ? "rgba(245, 245, 245, 0.94)" : "rgba(20, 20, 20, 0.92)";
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
      if (path.tool === "highlight") {
        if (isClosedHighlightRect(path)) {
          const bounds = getPathBounds(path);
          if (!bounds) {
            continue;
          }

          ctx.fillStyle = isColorInverted ? "rgba(250, 204, 21, 0.30)" : "rgba(255, 235, 59, 0.40)";
          ctx.globalCompositeOperation = isColorInverted ? "screen" : "multiply";
          ctx.fillRect(
            bounds.x * scale,
            bounds.y * scale,
            Math.max(1, bounds.width * scale),
            Math.max(1, bounds.height * scale),
          );
        } else {
          ctx.beginPath();
          ctx.moveTo(path.points[0].x * scale, path.points[0].y * scale);
          for (let i = 1; i < path.points.length; i++) {
            ctx.lineTo(path.points[i].x * scale, path.points[i].y * scale);
          }
          ctx.strokeStyle = isColorInverted ? "rgba(250, 204, 21, 0.34)" : "rgba(255, 235, 59, 0.45)";
          ctx.lineWidth = 14 * scale;
          ctx.lineCap = "square";
          ctx.lineJoin = "bevel";
          ctx.globalCompositeOperation = isColorInverted ? "screen" : "multiply";
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(path.points[0].x * scale, path.points[0].y * scale);
        for (let i = 1; i < path.points.length; i++) {
          ctx.lineTo(path.points[i].x * scale, path.points[i].y * scale);
        }
        ctx.strokeStyle = isColorInverted ? "rgba(125, 211, 252, 0.92)" : "rgba(43, 108, 208, 0.85)";
        ctx.lineWidth = 2 * scale;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalCompositeOperation = "source-over";
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }, [paths, currentPath, width, height, isColorInverted, scale, textAnnotations]);

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
      pushHistorySnapshot(getCurrentSnapshot());
      setTextAnnotations(prev => [
        ...prev,
        { x: activeTextInput.x, y: activeTextInput.y, text, fontSize: BASE_FONT_SIZE },
      ]);
    }
    setActiveTextInput(null);
  }, [activeTextInput, getCurrentSnapshot, pushHistorySnapshot]);

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

  const eraseAt = (point: Point) => {
    const radius = 10 / scale; // roughly 10px screen radius
    const currentSnapshot = getCurrentSnapshot();
    const nextPaths = currentSnapshot.paths.filter(path => {
      if (isClosedHighlightRect(path)) {
        const bounds = getPathBounds(path);
        if (!bounds) {
          return true;
        }

        const expandedX = bounds.x - radius;
        const expandedY = bounds.y - radius;
        const expandedWidth = bounds.width + (radius * 2);
        const expandedHeight = bounds.height + (radius * 2);
        const containsPoint = point.x >= expandedX
          && point.x <= expandedX + expandedWidth
          && point.y >= expandedY
          && point.y <= expandedY + expandedHeight;

        return !containsPoint;
      }

      return !path.points.some(p => Math.hypot(p.x - point.x, p.y - point.y) < radius);
    });
    const nextTextAnnotations = currentSnapshot.textAnnotations.filter(ann => {
      const approxWidth = ann.text.length * (BASE_FONT_SIZE * 0.55);
      const height = BASE_FONT_SIZE * 1.5;
      
      const inX = point.x >= ann.x - radius && point.x <= ann.x + approxWidth + radius;
      const inY = point.y >= ann.y - radius && point.y <= ann.y + height + radius;
      
      return !(inX && inY);
    });

    const didErase = nextPaths.length !== currentSnapshot.paths.length
      || nextTextAnnotations.length !== currentSnapshot.textAnnotations.length;

    if (!didErase) {
      return;
    }

    if (!hasPushedHistoryInStrokeRef.current) {
      pushHistorySnapshot(currentSnapshot);
      hasPushedHistoryInStrokeRef.current = true;
    }

    setPaths(nextPaths);
    setTextAnnotations(nextTextAnnotations);
  };

  const handlePointerDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === "none") return;
    const point = getUnscaledPoint(e);
    if (!point) return;
    hasPushedHistoryInStrokeRef.current = false;

    if (activeTool === "eraser") {
      setIsDrawing(true);
      eraseAt(point);
      return;
    }

    if (activeTool === "highlight") {
      return;
    }

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
    if (!isDrawing || activeTool === "none") return;
    const point = getUnscaledPoint(e);
    if (!point) return;

    if (activeTool === "eraser") {
      eraseAt(point);
      return;
    }

    if (!currentPath) return;
    setCurrentPath({ ...currentPath, points: [...currentPath.points, point] });
  };

  const handlePointerUp = () => {
    if (isDrawing && currentPath && currentPath.points.length > 0) {
      pushHistorySnapshot(getCurrentSnapshot());
      setPaths(prev => [...prev, currentPath]);
    }
    setCurrentPath(null);
    setIsDrawing(false);
    hasPushedHistoryInStrokeRef.current = false;
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
          pointerEvents: isInteractive && !activeTextInput && activeTool !== "highlight" ? "auto" : "none",
          cursor:
            activeTool === "text-highlight" ? "text" :
            activeTool === "highlight" ? "text" :
            activeTool === "eraser" ? "url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23e11d48%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m7%2021-4.3-4.3c-1-1-1-2.5%200-3.4l9.6-9.6c1-1%202.5-1%203.4%200l5.6%205.6c1%201%201%202.5%200%203.4L13%2021%22%2F%3E%3Cpath%20d%3D%22M22%2021H7%22%2F%3E%3Cpath%20d%3D%22m5%2011%209%209%22%2F%3E%3C%2Fsvg%3E') 0 24, pointer" :
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
