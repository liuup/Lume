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
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-gray-100">
      <Toolbar 
        onOpenPdf={handleOpenPdf} 
        onZoomIn={zoomIn} 
        onZoomOut={zoomOut}
        scale={scale}
        hasPdf={!!pdfPath}
        activeTool={activeTool}
        onToolChange={setActiveTool}
      />
      
      <main className="flex-1 overflow-auto relative flex justify-center bg-gray-200">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500">
            Loading Document...
          </div>
        )}
        
        {!pdfPath && !isLoading && (
          <div className="h-full flex items-center justify-center text-gray-400">
            Click 'Open PDF' to start reading flawlessly.
          </div>
        )}

        {pdfPath && !isLoading && (
          <PdfViewer totalPages={totalPages} dimensions={dimensions} scale={scale} activeTool={activeTool} />
        )}
      </main>
    </div>
  );
}

export default App;
