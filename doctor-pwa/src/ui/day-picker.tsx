import { useRef } from "react";
import { ChevronDown } from "lucide-react";

/**
 * El título de la fecha que se está viendo, que al tocarlo abre el selector de fecha del sistema para saltar a cualquier día
 * (igual que el calendario de la web de administración). Es un `<input type="date">` nativo, escondido bajo el botón: el del
 * celular es el que mejor funciona. Donde el navegador no sabe abrirlo (`showPicker`), el campo recibe el foco.
 */
export function DayPickerTitle({ label, value, onPick }: { label: string; value: string; onPick: (day: string) => void }) {
  const picker = useRef<HTMLInputElement>(null);

  return (
    // el margen negativo va en el contenedor (no en el botón: ahí le quita ancho al texto y lo corta con «…»)
    <span className="relative -ml-1.5 inline-flex max-w-full">
      <button
        type="button"
        onClick={() => {
          const el = picker.current;
          if (!el) return;
          try {
            el.showPicker();
          } catch {
            el.focus();
          }
        }}
        aria-label={`${label}. Elegir otra fecha`}
        className="flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
      </button>
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={value}
        onChange={(e) => e.target.value && onPick(e.target.value)}
        className="pointer-events-none absolute bottom-0 left-0 h-px w-px opacity-0"
      />
    </span>
  );
}
