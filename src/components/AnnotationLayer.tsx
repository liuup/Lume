import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToolType } from "../App";

interface AnnotationLayerProps {
  pageIndex: number;
  width: number;
  height: number;
  scale: number;
  activeTool: ToolType;
}

interface Point {
  x: number; // Unscaled original X
  y: number; // Unscaled original Y
}

interface Path {
  tool: ToolType;
  color: string;
  points: Point[];
}

interface HighlightRect {
  x: number;       // Unscaled PDF point X
  y: number;       // Unscaled PDF point Y
  width: number;   // Unscaled width
  height: number;  // Unscaled height
}

export function AnnotationLayer({ pageIndex, width, height, scale, activeTool }: AnnotationLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [paths, setPaths] = useState<Path[]>([]);
  const [currentPath, setCurrentPath] = useState<Path | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  // Text-highlight specific state
  const [textHighlights, setTextHighlights] = useState<HighlightRect[][]>([]);
  const [selectionStart, setSelectionStart] = useState<Point | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<Point | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  // Redraw all paths and highlights when they change or when the canvas resizes (scale changes)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // High resolution canvas strategy for retina displays
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Clear background entirely (it's transparent)
    ctx.clearRect(0, 0, width, height);

    // Draw text highlights first (below freehand strokes)
    for (const highlight of textHighlights) {
      for (const rect of highlight) {
        ctx.fillStyle = "rgba(255, 243, 128, 0.45)"; // Light yellow
        ctx.globalCompositeOperation = "multiply";
        ctx.fillRect(
          rect.x * scale,
          rect.y * scale,
          rect.width * scale,
          rect.height * scale
        );
        ctx.globalCompositeOperation = "source-over";
      }
    }

    // Draw selection preview rectangle if actively selecting
    if (isSelecting && selectionStart && selectionEnd) {
      const sx = Math.min(selectionStart.x, selectionEnd.x) * scale;
      const sy = Math.min(selectionStart.y, selectionEnd.y) * scale;
      const sw = Math.abs(selectionEnd.x - selectionStart.x) * scale;
      const sh = Math.abs(selectionEnd.y - selectionStart.y) * scale;

      ctx.strokeStyle = "rgba(255, 183, 77, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);

      // Light selection area fill
      ctx.fillStyle = "rgba(255, 243, 128, 0.12)";
      ctx.fillRect(sx, sy, sw, sh);
    }

    // Draw freehand paths
    const allPaths = [...paths];
    if (currentPath) allPaths.push(currentPath);

    for (const path of allPaths) {
      if (path.points.length < 2) continue;
      
      ctx.beginPath();
      const start = path.points[0];
      ctx.moveTo(start.x * scale, start.y * scale);

      for (let i = 1; i < path.points.length; i++) {
        const p = path.points[i];
        ctx.lineTo(p.x * scale, p.y * scale);
      }

      if (path.tool === "highlight") {
        ctx.strokeStyle = "rgba(255, 235, 59, 0.45)"; // Transparent yellow
        ctx.lineWidth = 14 * scale;
        ctx.lineCap = "square";
        ctx.lineJoin = "bevel";
        ctx.globalCompositeOperation = "multiply";
      } else if (path.tool === "draw") {
        ctx.strokeStyle = "rgba(43, 108, 208, 0.85)"; // Blue ink
        ctx.lineWidth = 2 * scale;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalCompositeOperation = "source-over";
      }

      ctx.stroke();
      ctx.globalCompositeOperation = "source-over"; // Reset
    }
  }, [paths, currentPath, width, height, scale, textHighlights, isSelecting, selectionStart, selectionEnd]);

  const getUnscaledPoint = (e: React.MouseEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    return { x, y };
  };

  const handlePointerDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === "none") return;
    const point = getUnscaledPoint(e);
    if (!point) return;

    if (activeTool === "text-highlight") {
      // Start text selection
      setIsSelecting(true);
      setSelectionStart(point);
      setSelectionEnd(point);
      return;
    }

    // Freehand drawing/highlighting
    setIsDrawing(true);
    setCurrentPath({
      tool: activeTool,
      color: activeTool === "highlight" ? "yellow" : "blue",
      points: [point],
    });
  };

  const handlePointerMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === "text-highlight" && isSelecting) {
      const point = getUnscaledPoint(e);
      if (!point) return;
      setSelectionEnd(point);
      return;
    }

    if (!isDrawing || !currentPath || activeTool === "none") return;
    const point = getUnscaledPoint(e);
    if (!point) return;

    setCurrentPath({
      ...currentPath,
      points: [...currentPath.points, point],
    });
  };

  const handlePointerUp = async () => {
    if (activeTool === "text-highlight" && isSelecting && selectionStart && selectionEnd) {
      setIsSelecting(false);

      // Build the selection rect in unscaled PDF coordinates
      const left = Math.min(selectionStart.x, selectionEnd.x);
      const top = Math.min(selectionStart.y, selectionEnd.y);
      const right = Math.max(selectionStart.x, selectionEnd.x);
      const bottom = Math.max(selectionStart.y, selectionEnd.y);

      // Don't process tiny selections (accidental clicks)
      if (right - left < 3 || bottom - top < 3) {
        setSelectionStart(null);
        setSelectionEnd(null);
        return;
      }

      try {
        // Call Rust backend to get precise text character rectangles
        const rects: HighlightRect[] = await invoke("get_text_rects", {
          pageIndex,
          selection: { left, top, right, bottom },
        });

        if (rects.length > 0) {
          setTextHighlights(prev => [...prev, rects]);
        }
      } catch (err) {
        console.error("Failed to get text rects:", err);
      }

      setSelectionStart(null);
      setSelectionEnd(null);
      return;
    }

    if (isDrawing && currentPath) {
      setPaths([...paths, currentPath]);
      setCurrentPath(null);
      setIsDrawing(false);
    }
  };

  const handlePointerLeave = () => {
    if (activeTool === "text-highlight" && isSelecting) {
      // Complete the selection on pointer leave
      handlePointerUp();
      return;
    }
    if (isDrawing && currentPath) {
      setPaths([...paths, currentPath]);
      setCurrentPath(null);
      setIsDrawing(false);
    }
  };

  // Turn off pointer events when "none" tool is selected so the user can easily scroll via panning if needed.
  // When highlight/draw/text-highlight is active, we steal pointer events to draw onto canvas.
  const isInteractive = activeTool !== "none";

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-10 touch-none"
      style={{
        width, 
        height, 
        pointerEvents: isInteractive ? "auto" : "none",
        cursor: activeTool === "text-highlight" ? "text" : 
                activeTool === "highlight" ? "text" : 
                (activeTool === "draw" ? "crosshair" : "default")
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    />
  );
}
