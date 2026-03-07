import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Toolbar } from "./components/Toolbar";
import { PdfViewer } from "./components/PdfViewer";

export type PageDimension = { width: number; height: number };
export type ToolType = 'none' | 'draw' | 'highlight' | 'text-highlight';

function App() {
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [dimensions, setDimensions] = useState<PageDimension[]>([]);
  const [scale, setScale] = useState<number>(1.5);
  const [activeTool, setActiveTool] = useState<ToolType>('none');
  const [isLoading, setIsLoading] = useState(false);

  const handleOpenPdf = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (selected && typeof selected === "string") {
        setIsLoading(true);
        setPdfPath(selected);
        
        // Load in Rust Memory
        const pages: number = await invoke("load_pdf", { path: selected });
        setTotalPages(pages);
        
        // Get generic unscaled dimensions for layout
        const dims: PageDimension[] = await invoke("get_pdf_dimensions");
        setDimensions(dims);
        
        setIsLoading(false);
      }
    } catch (err) {
      console.error("Failed to open PDF", err);
      setIsLoading(false);
    }
  };

  const zoomIn = () => setScale(s => Math.min(s + 0.25, 4.0));
  const zoomOut = () => setScale(s => Math.max(s - 0.25, 0.5));

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-50">
      <Toolbar 
        onOpenPdf={handleOpenPdf} 
        onZoomIn={zoomIn} 
        onZoomOut={zoomOut}
        scale={scale}
        hasPdf={!!pdfPath}
        activeTool={activeTool}
        onToolChange={setActiveTool}
      />
      
      <main className="flex-1 overflow-auto relative flex justify-center canvas-pattern">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="bg-white/80 backdrop-blur-md px-6 py-4 rounded-2xl shadow-lg border border-zinc-200/50 text-zinc-700 font-medium flex items-center space-x-3">
              <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
              <span>Loading Document...</span>
            </div>
          </div>
        )}
        
        {!pdfPath && !isLoading && (
          <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-6">
             <div className="w-24 h-24 bg-white rounded-[2rem] flex items-center justify-center shadow-sm border border-zinc-200/60 transition-transform hover:scale-105">
                <svg className="w-10 h-10 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
             </div>
             <p className="font-medium text-zinc-500 text-lg tracking-tight">Click 'Open PDF' to start reading flawlessly.</p>
          </div>
        )}

        {pdfPath && !isLoading && (
          <div className="w-full h-full pb-16 overflow-y-auto">
            <PdfViewer totalPages={totalPages} dimensions={dimensions} scale={scale} activeTool={activeTool} />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;