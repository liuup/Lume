import { useState, useRef, useEffect } from "react";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";

interface SearchBarProps {
  onSearch: (term: string, backwards: boolean) => void;
  onClose: () => void;
}

export function SearchBar({ onSearch, onClose }: SearchBarProps) {
  const [term, setTerm] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSearch = (backwards: boolean) => {
    if (!term) return;
    onSearch(term, backwards);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSearch(e.shiftKey); // Shift+Enter to search backwards
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="absolute top-16 right-6 z-50 flex items-center bg-white border border-zinc-200 shadow-xl rounded-lg px-2 py-1.5 space-x-2 animate-in fade-in slide-in-from-top-4 duration-200">
      <Search size={16} className="text-zinc-400" />
      <input
        ref={inputRef}
        type="text"
        placeholder="Find in document..."
        className="w-48 text-sm outline-none text-zinc-700 placeholder:text-zinc-400"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center space-x-0.5 border-l border-zinc-200 pl-2">
        <button
          onClick={() => handleSearch(true)}
          className="p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 rounded"
          title="Previous (Shift+Enter)"
        >
          <ChevronUp size={16} />
        </button>
        <button
          onClick={() => handleSearch(false)}
          className="p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 rounded"
          title="Next (Enter)"
        >
          <ChevronDown size={16} />
        </button>
      </div>
      <button
        onClick={onClose}
        className="p-1 ml-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 rounded"
        title="Close (Esc)"
      >
        <X size={16} />
      </button>
    </div>
  );
}
