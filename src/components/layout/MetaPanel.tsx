import { Tag, Calendar, User, AlignLeft } from "lucide-react";

export function MetaPanel() {
  return (
    <aside className="w-72 bg-white border-l border-zinc-200 flex flex-col h-full shrink-0">
      <div className="h-14 border-b border-zinc-200 flex items-center px-4 shrink-0 bg-zinc-50/50">
        <h2 className="font-semibold text-zinc-800 tracking-tight">Info</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        <div>
          <h3 className="text-lg font-bold text-zinc-900 leading-tight mb-2">
            Attention Is All You Need
          </h3>
          <div className="flex flex-wrap gap-1 mt-3">
            <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 text-[10px] font-semibold rounded-full uppercase tracking-wider">Deep Learning</span>
            <span className="px-2 py-0.5 bg-zinc-100 text-zinc-600 text-[10px] font-semibold rounded-full uppercase tracking-wider">NLP</span>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-start space-x-3">
            <User size={16} className="text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Authors</p>
              <p className="text-sm text-zinc-800 mt-0.5 leading-snug">Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Lukasz Kaiser, Illia Polosukhin</p>
            </div>
          </div>

          <div className="flex items-start space-x-3">
            <Calendar size={16} className="text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Date</p>
              <p className="text-sm text-zinc-800 mt-0.5">2017</p>
            </div>
          </div>

          <div className="flex items-start space-x-3">
             <AlignLeft size={16} className="text-zinc-400 mt-0.5 shrink-0" />
             <div>
               <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Abstract</p>
               <p className="text-sm text-zinc-600 mt-1 leading-relaxed line-clamp-6">
                 The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms...
               </p>
               <button className="text-indigo-600 text-xs font-medium mt-1 hover:underline">Read more</button>
             </div>
          </div>
        </div>
      </div>
    </aside>
  );
}