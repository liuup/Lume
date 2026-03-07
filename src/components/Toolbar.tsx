import { FileUp, ZoomIn, ZoomOut, Highlighter, Pencil, MousePointer2, Type } from "lucide-react";
import { ToolType } from "../App";

interface ToolbarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  scale: number;
  hasPdf: boolean;
  activeTool: ToolType;
  onToolChange: (tool: ToolType) => void;
}

export function Toolbar({ onZoomIn, onZoomOut, scale, hasPdf, activeTool, onToolChange }: ToolbarProps) {
  if (!hasPdf) return null; // Only show toolbar when reading a PDF

  return (
    <header className="h-14 bg-white/80 backdrop-blur-md border-b border-zinc-200 flex items-center justify-center px-6 z-20 shrink-0 sticky top-0 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      <div className="flex items-center bg-zinc-100/80 p-1 rounded-2xl border border-zinc-200/50">
        <div className="flex items-center space-x-1 px-1">
          <button 
            onClick={onZoomOut} 
            className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-white rounded-xl transition-all active:scale-90" 
            title="Zoom Out"
          >
            <ZoomOut size={16} />
          </button>
          <div className="w-14 text-center">
             <span className="text-xs font-semibold text-zinc-600 select-none">
              {Math.round(scale * 100)}%
            </span>
          </div>
          <button 
            onClick={onZoomIn} 
            className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-white rounded-xl transition-all active:scale-90" 
            title="Zoom In"
          >
            <ZoomIn size={16} />
          </button>
        </div>

        <div className="w-px h-5 bg-zinc-300 mx-2 opacity-50" />

        <div className="flex items-center space-x-1 px-1">
          <ToolButton 
            active={activeTool === 'none'} 
            onClick={() => onToolChange("none")}
            icon={<MousePointer2 size={16} />}
            title="Select Tool"
          />
          <ToolButton 
            active={activeTool === 'text-highlight'} 
            onClick={() => onToolChange("text-highlight")}
            icon={<Type size={16} />}
            title="Text Highlight"
            activeClass="text-indigo-600 bg-white"
          />
           <ToolButton 
            active={activeTool === 'highlight'} 
            onClick={() => onToolChange("highlight")}
            icon={<Highlighter size={16} />}
            title="Freehand Highlight"
            activeClass="text-amber-600 bg-white"
          />
          <ToolButton 
            active={activeTool === 'draw'} 
            onClick={() => onToolChange("draw")}
            icon={<Pencil size={16} />}
            title="Draw"
            activeClass="text-blue-600 bg-white"
          />
        </div>
      </div>
    </header>
  );
}

function ToolButton({ active, onClick, icon, title, activeClass = "text-zinc-900 bg-white" }: { active: boolean, onClick: () => void, icon: React.ReactNode, title: string, activeClass?: string }) {
  return (
    <button 
      onClick={onClick}
      className={`p-2 rounded-xl transition-all duration-200 active:scale-90 ${active ? `${activeClass} shadow-sm ring-1 ring-black/5` : 'text-zinc-500 hover:text-zinc-800 hover:bg-white/50'}`}
      title={title}
    >
      {icon}
    </button>
  );
}
