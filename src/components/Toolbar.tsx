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
    <header className="h-16 bg-white/80 backdrop-blur-md border-b border-zinc-200 flex items-center justify-between px-6 z-20 shrink-0 sticky top-0 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-2 mr-4">
           <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-200">
             <span className="text-white font-bold text-sm">L</span>
           </div>
           <span className="font-semibold text-zinc-800 tracking-tight hidden sm:block">Lume</span>
        </div>

        <button 
          onClick={onOpenPdf}
          className="flex items-center space-x-2 bg-zinc-900 hover:bg-zinc-800 text-white px-4 py-2 rounded-xl transition-all active:scale-95 shadow-sm"
        >
          <FileUp size={16} />
          <span className="text-sm font-medium">Open PDF</span>
        </button>
      </div>

      {hasPdf && (
        <div className="flex items-center bg-zinc-100/80 p-1 rounded-2xl border border-zinc-200/50">
          <div className="flex items-center space-x-1 px-1">
            <button 
              onClick={onZoomOut} 
              className="p-2 text-zinc-500 hover:text-zinc-900 hover:bg-white rounded-xl transition-all active:scale-90" 
              title="Zoom Out"
            >
              <ZoomOut size={18} />
            </button>
            <div className="w-16 text-center">
               <span className="text-xs font-semibold text-zinc-600 select-none">
                {Math.round(scale * 100)}%
              </span>
            </div>
            <button 
              onClick={onZoomIn} 
              className="p-2 text-zinc-500 hover:text-zinc-900 hover:bg-white rounded-xl transition-all active:scale-90" 
              title="Zoom In"
            >
              <ZoomIn size={18} />
            </button>
          </div>

          <div className="w-px h-6 bg-zinc-300 mx-2 opacity-50" />

          <div className="flex items-center space-x-1 px-1">
            <ToolButton 
              active={activeTool === 'none'} 
              onClick={() => onToolChange("none")}
              icon={<MousePointer2 size={18} />}
              title="Select Tool"
            />
            <ToolButton 
              active={activeTool === 'text-highlight'} 
              onClick={() => onToolChange("text-highlight")}
              icon={<Type size={18} />}
              title="Text Highlight"
              activeClass="text-indigo-600 bg-white"
            />
             <ToolButton 
              active={activeTool === 'highlight'} 
              onClick={() => onToolChange("highlight")}
              icon={<Highlighter size={18} />}
              title="Freehand Highlight"
              activeClass="text-amber-600 bg-white"
            />
            <ToolButton 
              active={activeTool === 'draw'} 
              onClick={() => onToolChange("draw")}
              icon={<Pencil size={18} />}
              title="Draw"
              activeClass="text-blue-600 bg-white"
            />
          </div>
        </div>
      )}

      <div className="flex items-center space-x-3">
        {/* Placeholder for future features like export/share */}
        <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-400">
           <span className="text-[10px] font-bold">SL</span>
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
