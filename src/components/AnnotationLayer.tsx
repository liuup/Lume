import { useEffect, useRef, useState } from "react";
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

export function AnnotationLayer({ pageIndex: _pageIndex, width, height, scale, activeTool }: AnnotationLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [paths, setPaths] = useState<Path[]>([]);
  const [currentPath, setCurrentPath] = useState<Path | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  // Redraw all paths when they change or when the canvas resizes (scale changes)
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

    const allPaths = [...paths];
    if (currentPath) allPaths.push(currentPath);

    // Draw paths perfectly scaled
    for (const path of allPaths) {
      if (path.points.length < 2) continue;
      
      ctx.beginPath();
      // Move to first coordinate scaled
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
  }, [paths, currentPath, width, height, scale]);

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

    setIsDrawing(true);
    setCurrentPath({
      tool: activeTool,
      color: activeTool === "highlight" ? "yellow" : "blue",
      points: [point],
    });
  };

  const handlePointerMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !currentPath || activeTool === "none") return;
    const point = getUnscaledPoint(e);
    if (!point) return;

    setCurrentPath({
      ...currentPath,
      points: [...currentPath.points, point],
    });
  };

  const handlePointerUp = () => {
    if (isDrawing && currentPath) {
      setPaths([...paths, currentPath]);
      setCurrentPath(null);
      setIsDrawing(false);
    }
  };

  const handlePointerLeave = () => {
    handlePointerUp();
  };

  // Turn off pointer events when "none" tool is selected so the user can easily scroll via panning if needed.
  // When highlight/draw is active, we steal pointer events to draw onto canvas.
  const isInteractive = activeTool !== "none";

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-10 touch-none"
      style={{
        width, 
        height, 
        pointerEvents: isInteractive ? "auto" : "none",
        cursor: activeTool === "highlight" ? "text" : (activeTool === "draw" ? "crosshair" : "default")
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    />
  );
}
