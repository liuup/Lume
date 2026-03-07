import { FileUp, ZoomIn, ZoomOut, Highlighter, Pencil, MousePointer2, Type } from "lucide-react";
import { ToolType } from "../App";

interface ToolbarProps {
  onOpenPdf: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  scale: number;
  hasPdf: boolean;
  activeTool: ToolType;
  onToolChange: (tool: ToolType) => void;
}

export function Toolbar({ onOpenPdf, onZoomIn, onZoomOut, scale, hasPdf, activeTool, onToolChange }: ToolbarProps) {
  return (
    <div className="h-14 bg-white border-b border-gray-300 flex items-center space-x-6 px-4 shadow-sm z-10 shrink-0">
      <button 
        onClick={onOpenPdf}
        className="flex items-center space-x-2 bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-md transition"
      >
        <FileUp size={18} />
        <span className="text-sm font-medium">Open PDF</span>
      </button>

      {hasPdf && (
        <div className="flex items-center space-x-1 bg-gray-50 p-1 border border-gray-200 rounded-lg shadow-inner">
          <button onClick={onZoomOut} className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded transition" title="Zoom Out">
            <ZoomOut size={18} />
          </button>
          <span className="text-sm font-mono text-gray-600 w-12 text-center select-none">
            {Math.round(scale * 100)}%
          </span>
          <button onClick={onZoomIn} className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded transition" title="Zoom In">
            <ZoomIn size={18} />
          </button>

          <div className="w-px h-5 bg-gray-300 mx-2" />

          <button 
            onClick={() => onToolChange("none")}
            className={`p-1.5 rounded transition ${activeTool === 'none' ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-800'}`}
            title="Read Tool (Select/Pan)"
          >
            <MousePointer2 size={18} />
          </button>
          <button 
            onClick={() => onToolChange("highlight")}
            className={`p-1.5 rounded transition ${activeTool === 'highlight' ? 'bg-yellow-100/50 shadow text-yellow-600' : 'text-yellow-600 hover:bg-yellow-50'}`}
            title="Freehand Highlight"
          >
            <Highlighter size={18} />
          </button>
          <button 
            onClick={() => onToolChange("text-highlight")}
            className={`p-1.5 rounded transition ${activeTool === 'text-highlight' ? 'bg-amber-100/50 shadow text-amber-600' : 'text-amber-600 hover:bg-amber-50'}`}
            title="Select Text to Highlight"
          >
            <Type size={18} />
          </button>
          <button 
            onClick={() => onToolChange("draw")}
            className={`p-1.5 rounded transition ${activeTool === 'draw' ? 'bg-blue-100/50 shadow text-blue-600' : 'text-blue-600 hover:bg-blue-50'}`}
            title="Freehand Draw"
          >
            <Pencil size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
