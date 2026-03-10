import { X, Moon, Sun, Monitor, Type, FileArchive, Settings } from "lucide-react";
import { useSettings } from "../../hooks/useSettings";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { settings, updateSetting, isLoading } = useSettings();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/20 backdrop-blur-sm" onClick={onClose}>
      <div 
        className="w-[500px] max-h-[80vh] overflow-y-auto bg-white rounded-2xl shadow-xl flex flex-col pointer-events-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 sticky top-0 bg-white/95 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2 text-zinc-800">
            <Settings size={20} className="text-zinc-500" />
            <h2 className="text-base font-semibold">Settings</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
            <X size={20} />
          </button>
        </div>

        {isLoading ? (
           <div className="p-8 text-center text-sm text-zinc-500 animate-pulse">Loading settings...</div>
        ) : (
          <div className="p-6 space-y-8">
            
            {/* Appearance Section */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">Appearance</h3>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-800">Theme</div>
                    <div className="text-xs text-zinc-500">Choose the app's visual style</div>
                  </div>
                  <div className="flex p-1 bg-zinc-100 rounded-lg">
                    {['light', 'dark', 'system'].map(t => (
                      <button
                        key={t}
                        onClick={() => updateSetting('theme', t as any)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${settings.theme === t ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
                      >
                        {t === 'light' && <Sun size={14} />}
                        {t === 'dark' && <Moon size={14} />}
                        {t === 'system' && <Monitor size={14} />}
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-800">Default PDF Zoom</div>
                    <div className="text-xs text-zinc-500">Initial zoom level when opening a document</div>
                  </div>
                  <select 
                    value={settings.defaultPdfZoom}
                    onChange={(e) => updateSetting('defaultPdfZoom', e.target.value)}
                    className="text-sm border-zinc-200 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 py-1.5 px-3 bg-white border"
                  >
                    <option value="page-fit">Fit Page</option>
                    <option value="page-width">Fit Width</option>
                    <option value="100%">100%</option>
                    <option value="150%">150%</option>
                  </select>
                </div>
              </div>
            </section>

            {/* Library Section */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">Library & File Management</h3>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileArchive size={18} className="text-zinc-400" />
                    <div>
                      <div className="text-sm font-medium text-zinc-800">Auto-Rename PDFs</div>
                      <div className="text-xs text-zinc-500">Automatically rename imported files based on metadata</div>
                    </div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" checked={settings.autoRenamePdf} onChange={(e) => updateSetting('autoRenamePdf', e.target.checked)} />
                    <div className="w-9 h-5 bg-zinc-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                  </label>
                </div>

                {settings.autoRenamePdf && (
                  <div className="flex items-center justify-between pl-8">
                    <div>
                      <div className="text-sm font-medium text-zinc-800">Rename Pattern</div>
                    </div>
                    <input 
                      type="text" 
                      value={settings.renamePattern}
                      onChange={(e) => updateSetting('renamePattern', e.target.value)}
                      className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 w-48 focus:ring-1 focus:ring-indigo-500 outline-none"
                      placeholder="e.g. [Year] - [Author] - [Title]"
                    />
                  </div>
                )}
              </div>
            </section>

            {/* Export Section */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">Export & Integrations</h3>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Type size={18} className="text-zinc-400" />
                    <div>
                      <div className="text-sm font-medium text-zinc-800">Default Citation Format</div>
                      <div className="text-xs text-zinc-500">Format used for quick copy operations</div>
                    </div>
                  </div>
                  <select 
                    value={settings.defaultCitationFormat}
                    onChange={(e) => updateSetting('defaultCitationFormat', e.target.value)}
                    className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="apa">APA</option>
                    <option value="mla">MLA</option>
                    <option value="chicago">Chicago</option>
                    <option value="gbt">GB/T 7714</option>
                    <option value="bibtex">BibTeX</option>
                  </select>
                </div>
              </div>
            </section>

          </div>
        )}
      </div>
    </div>
  );
}
