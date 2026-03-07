import { useState } from "react";
import { ZoomIn, ZoomOut, Highlighter, Pencil, MousePointer2, Type, PanelRight } from "lucide-react";
import { ToolType } from "../App";

interface ToolbarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  scale: number;
  hasPdf: boolean;
  activeTool: ToolType;
  onToolChange: (tool: ToolType) => void;
  isRightPanelOpen: boolean;
  onToggleRightPanel: () => void;
}

export function Toolbar({
  onZoomIn,
  onZoomOut,
  scale,
  hasPdf,
  activeTool,
  onToolChange,
  isRightPanelOpen,
  onToggleRightPanel,
}: ToolbarProps) {
  if (!hasPdf) return null;

  return (
    <header className="h-14 bg-white/80 backdrop-blur-md border-b border-zinc-200 flex items-center justify-between px-4 z-20 shrink-0 sticky top-0 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      {/* Left spacer (mirrors right toggle button width) */}
      <div className="w-9" />

      {/* Center — zoom + tools */}
      <div className="flex items-center bg-zinc-100/80 p-1 rounded-2xl border border-zinc-200/50">
        {/* Zoom controls */}
        <div className="flex items-center space-x-1 px-1">
          <TooltipButton
            onClick={onZoomOut}
            tooltip="Zoom Out"
            className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-white rounded-xl transition-all active:scale-90"
          >
            <ZoomOut size={16} />
          </TooltipButton>
          <div className="w-14 text-center">
            <span className="text-xs font-semibold text-zinc-600 select-none">
              {Math.round(scale * 100)}%
            </span>
          </div>
          <TooltipButton
            onClick={onZoomIn}
            tooltip="Zoom In"
            className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-white rounded-xl transition-all active:scale-90"
          >
            <ZoomIn size={16} />
          </TooltipButton>
        </div>

        <div className="w-px h-5 bg-zinc-300 mx-2 opacity-50" />

        {/* Annotation tools */}
        <div className="flex items-center space-x-1 px-1">
          <ToolButton
            active={activeTool === "none"}
            onClick={() => onToolChange("none")}
            icon={<MousePointer2 size={16} />}
            tooltip="Pointer — scroll & pan freely"
          />
          <ToolButton
            active={activeTool === "text-highlight"}
            onClick={() => onToolChange("text-highlight")}
            icon={<Type size={16} />}
            tooltip="Text Highlight — drag to select and highlight text"
            activeClass="text-indigo-600 bg-white"
          />
          <ToolButton
            active={activeTool === "highlight"}
            onClick={() => onToolChange("highlight")}
            icon={<Highlighter size={16} />}
            tooltip="Freehand Highlight — draw a highlight stroke over text"
            activeClass="text-amber-600 bg-white"
          />
          <ToolButton
            active={activeTool === "draw"}
            onClick={() => onToolChange("draw")}
            icon={<Pencil size={16} />}
            tooltip="Pen — annotate with freehand drawing"
            activeClass="text-blue-600 bg-white"
          />
        </div>
      </div>

      {/* Right — panel toggle */}
      <TooltipButton
        onClick={onToggleRightPanel}
        tooltip={isRightPanelOpen ? "Hide Info Panel" : "Show Info Panel"}
        className={`p-2 rounded-xl transition-all active:scale-90 ${
          isRightPanelOpen
            ? "text-indigo-600 bg-indigo-50 hover:bg-indigo-100"
            : "text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100"
        }`}
      >
        <PanelRight size={16} />
      </TooltipButton>
    </header>
  );
}

/* ── Annotation tool button with tooltip ── */
function ToolButton({
  active,
  onClick,
  icon,
  tooltip,
  activeClass = "text-zinc-900 bg-white",
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  tooltip: string;
  activeClass?: string;
}) {
  return (
    <TooltipButton
      onClick={onClick}
      tooltip={tooltip}
      className={`p-2 rounded-xl transition-all duration-150 active:scale-90 ${
        active
          ? `${activeClass} shadow-sm ring-1 ring-black/5`
          : "text-zinc-500 hover:text-zinc-800 hover:bg-white/50"
      }`}
    >
      {icon}
    </TooltipButton>
  );
}

/* ── Generic button with a floating tooltip below ── */
function TooltipButton({
  children,
  onClick,
  tooltip,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tooltip: string;
  className: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      <button onClick={onClick} className={className}>
        {children}
      </button>
      {/* Tooltip */}
      <div
        className={`pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2.5 py-1.5 bg-zinc-900 text-white text-[11px] font-medium rounded-lg shadow-xl whitespace-nowrap z-50 transition-all duration-150 ${
          visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1"
        }`}
      >
        {tooltip}
        {/* Arrow */}
        <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-zinc-900 rotate-45 rounded-[1px]" />
      </div>
    </div>
  );
}
