import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { cn } from "@clinica/calendar";

type Toast = { id: number; text: string; tone: "ok" | "error" };
type ToastApi = { show: (text: string, tone?: Toast["tone"]) => void };

const ToastContext = createContext<ToastApi | null>(null);

/** Avisos breves ("Cita actualizada") en una región `aria-live` para lectores de pantalla. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = nextId.current++;
    setItems((list) => [...list.slice(-3), { id, text, tone }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), tone === "error" ? 7000 : 4000);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex max-w-md items-center gap-2 rounded-lg border px-3.5 py-2.5 text-sm font-medium shadow-lg",
              t.tone === "ok" ? "border-success-soft bg-success-tint text-success-text" : "border-danger-soft bg-danger-tint text-danger-text"
            )}
          >
            {t.tone === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(ToastContext);
  if (!v) throw new Error("useToast fuera de <ToastProvider>");
  return v;
}
