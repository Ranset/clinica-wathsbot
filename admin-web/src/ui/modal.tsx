import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@clinica/calendar";

/**
 * Las ventanas abiertas, de la primera a la de arriba. Con una ventana sobre otra (el calendario de horarios libres sobre el detalle de la
 * cita), Esc y Tab solo le tocan a la de ARRIBA: si no, un Esc cerraria las dos.
 */
const OPEN: symbol[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Ventana modal accesible: `role="dialog"`, Esc la cierra, el foco entra y se queda
 * dentro (Tab da la vuelta) y regresa a donde estaba al cerrar.
 *
 * - `center`: tarjeta al centro (formularios).
 * - `side`: panel a la derecha en escritorio y hoja desde abajo en el celular (detalle de cita).
 *
 * Se pueden abrir una sobre otra: solo la de arriba reacciona al teclado.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  variant = "center",
  size = "md",
  initialFocus = "field",
  description,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  variant?: "center" | "side";
  /** Ancho de la tarjeta centrada: `lg` para formularios con tablas (horarios). */
  size?: "md" | "lg";
  /** `field`: el primer campo del formulario; `panel`: la propia ventana (detalles, para no abrir el teclado en el celular). */
  initialFocus?: "field" | "panel";
  description?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const me = Symbol("modal");
    OPEN.push(me);
    const before = document.activeElement as HTMLElement | null;
    const el = panel.current!;
    // Primero un campo de formulario; si no hay, el primer botón (que no sea la "x" de cerrar).
    const first =
      initialFocus === "panel"
        ? el
        : (el.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea") ?? el.querySelector<HTMLElement>(FOCUSABLE));
    first?.focus();

    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (OPEN[OPEN.length - 1] !== me) return; // hay otra ventana encima: ella decide
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      OPEN.splice(OPEN.indexOf(me), 1);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className={cn("fixed inset-0 z-50 flex", variant === "side" ? "items-end justify-end sm:items-stretch" : "items-end justify-center sm:items-center sm:p-4")}>
      <div className="absolute inset-0 bg-black/40" aria-hidden onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "outline-none",
          "relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-background shadow-xl",
          variant === "side"
            ? "rounded-t-xl sm:max-h-none sm:w-[26rem] sm:rounded-none sm:border-l"
            : cn("rounded-t-xl sm:rounded-xl sm:border", size === "lg" ? "sm:max-w-2xl" : "sm:max-w-lg")
        )}
      >
        <header className="flex items-start gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[16px] font-bold tracking-tight">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-xs text-text-3">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t bg-subtle px-4 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}
