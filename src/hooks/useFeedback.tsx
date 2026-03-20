import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

export type FeedbackVariant = "success" | "error" | "info";

interface FeedbackItem {
  id: string;
  variant: FeedbackVariant;
  title: string;
  description?: string;
  duration: number;
}

interface FeedbackPayload {
  title: string;
  description?: string;
  duration?: number;
}

interface FeedbackContextType {
  notify: (variant: FeedbackVariant, payload: FeedbackPayload) => string;
  success: (payload: FeedbackPayload) => string;
  error: (payload: FeedbackPayload) => string;
  info: (payload: FeedbackPayload) => string;
  dismiss: (id: string) => void;
}

const DEFAULT_DURATION: Record<FeedbackVariant, number> = {
  success: 2600,
  error: 4200,
  info: 3200,
};

const FeedbackContext = createContext<FeedbackContextType | undefined>(undefined);

function getToastStyles(variant: FeedbackVariant) {
  switch (variant) {
    case "success":
      return {
        panel: "border-emerald-200 bg-white dark:border-emerald-950/70 dark:bg-zinc-900/95",
        iconWrap: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/80 dark:text-emerald-300",
        title: "text-emerald-900 dark:text-emerald-200",
        description: "text-emerald-700/80 dark:text-emerald-300/80",
        button: "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800",
      };
    case "error":
      return {
        panel: "border-red-200 bg-white dark:border-red-950/70 dark:bg-zinc-900/95",
        iconWrap: "bg-red-50 text-red-600 dark:bg-red-950/80 dark:text-red-300",
        title: "text-red-900 dark:text-red-200",
        description: "text-red-700/80 dark:text-red-300/80",
        button: "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800",
      };
    default:
      return {
        panel: "border-indigo-200 bg-white dark:border-indigo-950/70 dark:bg-zinc-900/95",
        iconWrap: "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/80 dark:text-indigo-300",
        title: "text-indigo-900 dark:text-indigo-200",
        description: "text-zinc-600 dark:text-zinc-400",
        button: "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800",
      };
  }
}

function FeedbackViewport({ items, onDismiss }: { items: FeedbackItem[]; onDismiss: (id: string) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[120] flex w-[min(280px,calc(100vw-2rem))] flex-col gap-2">
      {items.map((item) => {
        const styles = getToastStyles(item.variant);
        const Icon = item.variant === "success" ? CheckCircle2 : item.variant === "error" ? AlertCircle : Info;

        return (
          <div
            key={item.id}
            className={`pointer-events-auto rounded-xl border px-2.5 py-2 shadow-[0_14px_36px_-20px_rgba(0,0,0,0.28)] backdrop-blur-sm transition-all ${styles.panel}`}
            role="status"
            aria-live={item.variant === "error" ? "assertive" : "polite"}
            title={item.description}
          >
            <div className="flex items-center gap-2">
              <div className={`shrink-0 rounded-lg p-1.5 ${styles.iconWrap}`}>
                <Icon size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-sm font-semibold ${styles.title}`}>{item.title}</div>
              </div>
              <button
                onClick={() => onDismiss(item.id)}
                className={`shrink-0 rounded-md p-1 transition-colors ${styles.button}`}
                aria-label="Dismiss notification"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<FeedbackItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback((variant: FeedbackVariant, payload: FeedbackPayload) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item: FeedbackItem = {
      id,
      variant,
      title: payload.title,
      description: payload.description,
      duration: payload.duration ?? DEFAULT_DURATION[variant],
    };

    setItems((prev) => [...prev, item].slice(-2));
    return id;
  }, []);

  useEffect(() => {
    if (items.length === 0) return;

    const timers = items
      .filter((item) => item.duration > 0)
      .map((item) => window.setTimeout(() => dismiss(item.id), item.duration));

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [dismiss, items]);

  const value = useMemo<FeedbackContextType>(() => ({
    notify,
    success: (payload) => notify("success", payload),
    error: (payload) => notify("error", payload),
    info: (payload) => notify("info", payload),
    dismiss,
  }), [dismiss, notify]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <FeedbackViewport items={items} onDismiss={dismiss} />
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const context = useContext(FeedbackContext);
  if (!context) {
    throw new Error("useFeedback must be used within a FeedbackProvider");
  }

  return context;
}
