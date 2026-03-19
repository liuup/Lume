import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ZoomIn, ZoomOut, Highlighter, Pencil, MousePointer2, Type, PanelRight, PanelLeft, ChevronDown, Eraser } from "lucide-react";
import { ToolType } from "../types";
import { useI18n } from "../hooks/useI18n";

interface ToolbarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  scale: number;
  hasPdf: boolean;
  activeTool: ToolType;
  onToolChange: (tool: ToolType) => void;
  isAiPanelOpen: boolean;
  onToggleAiPanel: () => void;
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
  isAiPanelOpen,
  onToggleAiPanel,
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
  const zoomMenuPortalRef = useRef<HTMLDivElement>(null);
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);
  const [zoomMenuPosition, setZoomMenuPosition] = useState<{ left: number; top: number } | null>(null);
  
  const [pageInput, setPageInput] = useState(currentPage.toString());

  useEffect(() => {
    setPageInput(currentPage.toString());
  }, [currentPage]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedTrigger = zoomMenuRef.current?.contains(target);
      const clickedMenu = zoomMenuPortalRef.current?.contains(target);

      if (!clickedTrigger && !clickedMenu) {
        setShowZoomMenu(false);
      }
    };
    if (showZoomMenu) window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [showZoomMenu]);

  useEffect(() => {
    if (!showZoomMenu) {
      return;
    }

    const updateZoomMenuPosition = () => {
      const rect = zoomTriggerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      setZoomMenuPosition({
        left: rect.left + rect.width / 2,
        top: rect.bottom + 6,
      });
    };

    updateZoomMenuPosition();
    window.addEventListener("scroll", updateZoomMenuPosition, true);
    window.addEventListener("resize", updateZoomMenuPosition);

    return () => {
      window.removeEventListener("scroll", updateZoomMenuPosition, true);
      window.removeEventListener("resize", updateZoomMenuPosition);
    };
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
    <header className="relative h-14 bg-white/90 dark:bg-zinc-950/95 backdrop-blur-sm border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2 px-3 z-[70] shrink-0 sticky top-0 shadow-[0_1px_2px_rgba(0,0,0,0.02)] min-w-0">
      {/* Left controls / draggable space */}
      <div className="flex-1 min-w-0 h-full flex items-center cursor-default" data-tauri-drag-region>
        <TooltipButton
          onClick={onToggleAiPanel}
          tooltip={isAiPanelOpen ? t("toolbar.aiPanel.hide") : t("toolbar.aiPanel.show")}
          className={`p-2 rounded-xl transition-all active:scale-90 relative z-10 ${
            isAiPanelOpen
              ? "text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/60"
              : "text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          }`}
        >
          <PanelLeft size={16} />
        </TooltipButton>
      </div>

      {/* Center — zoom + tools + pages */}
      <div className="min-w-0 max-w-full overflow-x-auto no-scrollbar">
      <div className="flex items-center bg-zinc-100/80 dark:bg-zinc-900/80 p-1 rounded-2xl border border-zinc-200/50 dark:border-zinc-800 shrink-0 min-w-max">
        
        {/* Page navigation */}
        <div className="hidden min-[880px]:flex items-center space-x-1.5 px-2">
          <input 
            type="text" 
            className="w-10 h-7 text-center text-[11px] font-semibold text-zinc-700 dark:text-zinc-100 bg-white dark:bg-zinc-950 border border-zinc-200/80 dark:border-zinc-700 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 shadow-sm transition-shadow"
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
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400 font-semibold select-none pr-1">/ {totalPages}</span>
        </div>

        <div className="w-px h-5 bg-zinc-300 dark:bg-zinc-700 mx-1 opacity-50" />

        {/* Zoom controls */}
        <div className="flex items-center space-x-1 px-1">
          <TooltipButton
            onClick={onZoomOut}
            tooltip={t("toolbar.zoomOut")}
            className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-white dark:hover:bg-zinc-800 rounded-xl transition-all active:scale-90"
          >
            <ZoomOut size={16} />
          </TooltipButton>
          <div className="relative" ref={zoomMenuRef}>
            <button 
              ref={zoomTriggerRef}
              onClick={() => setShowZoomMenu(!showZoomMenu)}
              className="w-12 min-[640px]:w-16 h-8 flex items-center justify-center space-x-1 hover:bg-white dark:hover:bg-zinc-800 rounded-md transition-colors"
              title={t("toolbar.zoomOptions")}
            >
              <span className="hidden min-[640px]:inline text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 select-none">
                {Math.round(scale * 100)}%
              </span>
              <ChevronDown size={11} className="text-zinc-400 dark:text-zinc-500" />
            </button>
            
            {showZoomMenu && zoomMenuPosition && typeof document !== "undefined"
              ? createPortal(
              <div
                ref={zoomMenuPortalRef}
                className="fixed z-[250] w-32 -translate-x-1/2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 py-1.5 shadow-lg"
                style={{
                  left: zoomMenuPosition.left,
                  top: zoomMenuPosition.top,
                }}
              >
                <button className="w-full text-left px-3 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors" onClick={() => { onFitWidth(); setShowZoomMenu(false); }}>
                  {t("toolbar.fitWidth")}
                </button>
                <button className="w-full text-left px-3 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors" onClick={() => { onFitHeight(); setShowZoomMenu(false); }}>
                  {t("toolbar.fitHeight")}
                </button>
              </div>,
              document.body
            )
              : null}
          </div>
          <TooltipButton
            onClick={onZoomIn}
            tooltip={t("toolbar.zoomIn")}
            className="p-1.5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-white dark:hover:bg-zinc-800 rounded-xl transition-all active:scale-90"
          >
            <ZoomIn size={16} />
          </TooltipButton>
        </div>

        <div className="w-px h-5 bg-zinc-300 dark:bg-zinc-700 mx-2 opacity-50" />

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
            activeClass="text-indigo-600 dark:text-indigo-300 bg-white dark:bg-zinc-800"
          />
          <ToolButton
            active={activeTool === "highlight"}
            onClick={() => onToolChange("highlight")}
            icon={<Highlighter size={16} />}
            tooltip={t("toolbar.tool.highlight")}
            activeClass="text-amber-600 dark:text-amber-300 bg-white dark:bg-zinc-800"
          />
          <ToolButton
            active={activeTool === "draw"}
            onClick={() => onToolChange("draw")}
            icon={<Pencil size={16} />}
            tooltip={t("toolbar.tool.draw")}
            activeClass="text-blue-600 dark:text-blue-300 bg-white dark:bg-zinc-800"
          />
          <ToolButton
            active={activeTool === "eraser"}
            onClick={() => onToolChange("eraser")}
            icon={<Eraser size={16} />}
            tooltip={t("toolbar.tool.eraser")}
            activeClass="text-pink-600 dark:text-pink-300 bg-white dark:bg-zinc-800"
          />
        </div>
      </div>
      </div>

      {/* Right flexible spacer for dragging */}
      <div className="flex-1 min-w-0 h-full flex justify-end items-center" data-tauri-drag-region>
        <TooltipButton
          onClick={onToggleRightPanel}
          tooltip={isRightPanelOpen ? t("toolbar.infoPanel.hide") : t("toolbar.infoPanel.show")}
          className={`p-2 rounded-xl transition-all active:scale-90 relative z-10 ${
            isRightPanelOpen
              ? "text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/60"
              : "text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
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
  activeClass = "text-zinc-900 dark:text-zinc-100 bg-white dark:bg-zinc-800",
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
          : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 hover:bg-white/50 dark:hover:bg-zinc-800/80"
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
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const updatePosition = () => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      setPosition({
        left: rect.left + rect.width / 2,
        top: rect.bottom + 8,
      });
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [visible]);

  return (
    <div
      ref={wrapperRef}
      className="relative z-[80]"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <button onClick={onClick} className={className}>
        {children}
      </button>
      {visible && position && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[300] px-2.5 py-1.5 bg-zinc-900 text-white text-[11px] font-medium rounded-lg shadow-xl whitespace-nowrap"
              style={{
                left: position.left,
                top: position.top,
                transform: "translateX(-50%)",
              }}
            >
              {tooltip}
              <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-zinc-900 rotate-45 rounded-[1px]" />
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
