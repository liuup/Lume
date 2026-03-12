import { useState, useRef, useEffect } from "react";
import { ZoomIn, ZoomOut, Highlighter, Pencil, MousePointer2, Type, PanelRight, ChevronDown, Eraser } from "lucide-react";
import { ToolType } from "../types";
import { useI18n } from "../hooks/useI18n";

interface ToolbarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  scale: number;
  hasPdf: boolean;
  activeTool: ToolType;
  onToolChange: (tool: ToolType) => void;
  isRightPanelOpen: boolean;
  onToggleRightPanel: () => void;
  onFitWidth: () => void;
  onFitHeight: () => void;
  currentPage: number;
  totalPages: number;
  onPageJump: (page: number) => void;
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
  onFitWidth,
  onFitHeight,
  currentPage,
  totalPages,
  onPageJump,
}: ToolbarProps) {
  const { t } = useI18n();
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const zoomMenuRef = useRef<HTMLDivElement>(null);
  
  const [pageInput, setPageInput] = useState(currentPage.toString());

  useEffect(() => {
    setPageInput(currentPage.toString());
  }, [currentPage]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (zoomMenuRef.current && !zoomMenuRef.current.contains(e.target as Node)) {
        setShowZoomMenu(false);
      }
    };
    if (showZoomMenu) window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [showZoomMenu]);
  
  if (!hasPdf) return null;

  const handlePageSubmit = () => {
    let p = parseInt(pageInput, 10);
    if (isNaN(p) || p < 1) p = 1;
    if (p > totalPages) p = totalPages;
    setPageInput(p.toString());
    onPageJump(p);
  };

  return (
    <header className="h-14 bg-white/80 backdrop-blur-md border-b border-zinc-200 flex items-center justify-between px-4 z-20 shrink-0 sticky top-0 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      {/* Left flexible spacer for dragging */}
      <div className="flex-1 h-full cursor-default" data-tauri-drag-region />

      {/* Center — zoom + tools + pages */}
      <div className="flex items-center bg-zinc-100/80 p-1 rounded-2xl border border-zinc-200/50 shrink-0">
        
        {/* Page navigation */}
        <div className="flex items-center space-x-1.5 px-2">
          <input 
            type="text" 
            className="w-10 h-7 text-center text-[11px] font-semibold text-zinc-700 bg-white border border-zinc-200/80 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 shadow-sm transition-shadow"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                 handlePageSubmit();
                 (e.target as HTMLInputElement).blur();
              }
            }}
            onBlur={handlePageSubmit}
          />
          <span className="text-[11px] text-zinc-500 font-semibold select-none pr-1">/ {totalPages}</span>
        </div>

        <div className="w-px h-5 bg-zinc-300 mx-1 opacity-50" />

        {/* Zoom controls */}
        <div className="flex items-center space-x-1 px-1">
          <TooltipButton
            onClick={onZoomOut}
            tooltip={t("toolbar.zoomOut")}
            className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-white rounded-xl transition-all active:scale-90"
          >
            <ZoomOut size={16} />
          </TooltipButton>
          <div className="relative" ref={zoomMenuRef}>
            <button 
              onClick={() => setShowZoomMenu(!showZoomMenu)}
              className="w-16 h-8 flex items-center justify-center space-x-1 hover:bg-white rounded-md transition-colors"
              title={t("toolbar.zoomOptions")}
            >
              <span className="text-[11px] font-semibold text-zinc-600 select-none">
                {Math.round(scale * 100)}%
              </span>
              <ChevronDown size={11} className="text-zinc-400" />
            </button>
            
            {showZoomMenu && (
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-32 bg-white border border-zinc-200 rounded-xl shadow-lg py-1.5 z-50">
                <button className="w-full text-left px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors" onClick={() => { onFitWidth(); setShowZoomMenu(false); }}>
                  {t("toolbar.fitWidth")}
                </button>
                <button className="w-full text-left px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors" onClick={() => { onFitHeight(); setShowZoomMenu(false); }}>
                  {t("toolbar.fitHeight")}
                </button>
              </div>
            )}
          </div>
          <TooltipButton
            onClick={onZoomIn}
            tooltip={t("toolbar.zoomIn")}
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
            tooltip={t("toolbar.tool.pointer")}
          />
          <ToolButton
            active={activeTool === "text-highlight"}
            onClick={() => onToolChange("text-highlight")}
            icon={<Type size={16} />}
            tooltip={t("toolbar.tool.textNote")}
            activeClass="text-indigo-600 bg-white"
          />
          <ToolButton
            active={activeTool === "highlight"}
            onClick={() => onToolChange("highlight")}
            icon={<Highlighter size={16} />}
            tooltip={t("toolbar.tool.highlight")}
            activeClass="text-amber-600 bg-white"
          />
          <ToolButton
            active={activeTool === "draw"}
            onClick={() => onToolChange("draw")}
            icon={<Pencil size={16} />}
            tooltip={t("toolbar.tool.draw")}
            activeClass="text-blue-600 bg-white"
          />
          <ToolButton
            active={activeTool === "eraser"}
            onClick={() => onToolChange("eraser")}
            icon={<Eraser size={16} />}
            tooltip={t("toolbar.tool.eraser")}
            activeClass="text-pink-600 bg-white"
          />
        </div>
      </div>

      {/* Right flexible spacer for dragging */}
      <div className="flex-1 h-full flex justify-end items-center" data-tauri-drag-region>
        <TooltipButton
          onClick={onToggleRightPanel}
          tooltip={isRightPanelOpen ? t("toolbar.infoPanel.hide") : t("toolbar.infoPanel.show")}
          className={`p-2 rounded-xl transition-all active:scale-90 relative z-10 ${
            isRightPanelOpen
              ? "text-indigo-600 bg-indigo-50 hover:bg-indigo-100"
              : "text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100"
          }`}
        >
          <PanelRight size={16} />
        </TooltipButton>
      </div>
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
