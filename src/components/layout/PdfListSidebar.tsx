import { FileText, Search, Library, Plus, FileUp } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { PageDimension } from "../../App";

interface PdfListSidebarProps {
  onPdfOpened: (path: string, totalPages: number, dimensions: PageDimension[]) => void;
  onLoadingStart: () => void;
  onLoadingEnd: () => void;
}

export function PdfListSidebar({ onPdfOpened, onLoadingStart, onLoadingEnd }: PdfListSidebarProps) {
  const handleOpenPdf = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (selected && typeof selected === "string") {
        onLoadingStart();
        
        // Load in Rust Memory
        const pages: number = await invoke("load_pdf", { path: selected });
        
        // Get generic unscaled dimensions for layout
        const dims: PageDimension[] = await invoke("get_pdf_dimensions");
        
        onPdfOpened(selected, pages, dims);
        onLoadingEnd();
      }
    } catch (err) {
      console.error("Failed to open PDF", err);
      onLoadingEnd();
    }
  };

  return (
    <aside className="w-64 bg-zinc-50 border-r border-zinc-200 flex flex-col h-full shrink-0">
      <div className="h-14 border-b border-zinc-200 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center space-x-2">
           <div className="w-6 h-6 bg-indigo-600 rounded-md flex items-center justify-center shadow-sm">
             <span className="text-white font-bold text-xs">L</span>
           </div>
           <h2 className="font-semibold text-zinc-800 tracking-tight">Lume</h2>
        </div>
        <button 
          onClick={handleOpenPdf}
          className="p-1.5 text-zinc-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
          title="Open PDF"
        >
          <FileUp size={18} />
        </button>
      </div>
      
      <div className="p-3 border-b border-zinc-200 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" size={14} />
          <input 
            type="text" 
            placeholder="Search papers..." 
            className="w-full pl-8 pr-3 py-1.5 bg-white border border-zinc-200 rounded-md text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all placeholder:text-zinc-400"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        <div className="flex items-center space-x-3 px-3 py-2 bg-indigo-50 text-indigo-700 rounded-md cursor-default">
          <FileText size={16} className="shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium truncate">Attention Is All You Need</span>
            <span className="text-[10px] opacity-70 truncate">Vaswani et al. (2017)</span>
          </div>
        </div>
        
        <div className="flex items-center space-x-3 px-3 py-2 text-zinc-600 hover:bg-zinc-100 rounded-md cursor-pointer transition-colors">
          <FileText size={16} className="shrink-0 text-zinc-400" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium truncate">ResNet: Deep Residual Learning...</span>
            <span className="text-[10px] text-zinc-400 truncate">He et al. (2015)</span>
          </div>
        </div>

        <div className="flex items-center space-x-3 px-3 py-2 text-zinc-600 hover:bg-zinc-100 rounded-md cursor-pointer transition-colors">
          <FileText size={16} className="shrink-0 text-zinc-400" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium truncate">BERT: Pre-training of Deep...</span>
            <span className="text-[10px] text-zinc-400 truncate">Devlin et al. (2018)</span>
          </div>
        </div>
      </div>
    </aside>
  );
}