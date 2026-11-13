import { useId, type ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@clinica/calendar";
import { inputClass } from "./controls";

/**
 * Un campo de fecha (`<input type="date">`: se puede teclear) cuyo icono de calendario, en vez de abrir el calendario del navegador, abre
 * el del sistema con los HORARIOS LIBRES (`onOpenCalendar`). Sin `onOpenCalendar` es el campo de siempre.
 *
 * El icono nativo se esconde (Chrome, Edge y Safari) y se pinta el nuestro encima; en Firefox el nativo queda debajo, tapado por el nuestro. El
 * botón va FUERA de la etiqueta (no le cambia el nombre al campo) y es accesible por teclado.
 */
export function DateField({
  label,
  value,
  onChange,
  onOpenCalendar,
  calendarLabel = "Ver horarios libres en el calendario",
  hint,
  error,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onOpenCalendar?: () => void;
  calendarLabel?: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-[13px] font-semibold text-text-2">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint || error ? noteId : undefined}
          aria-invalid={error ? true : undefined}
          className={cn(inputClass, onOpenCalendar && "pr-10 [&::-webkit-calendar-picker-indicator]:hidden")}
        />
        {onOpenCalendar && (
          <button
            type="button"
            onClick={onOpenCalendar}
            aria-label={calendarLabel}
            title={calendarLabel}
            className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded bg-background text-text-2 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
          >
            <CalendarDays className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      {(hint || error) && (
        <p id={noteId} role={error ? "alert" : undefined} className={cn("text-xs", error ? "font-medium text-danger-text" : "text-text-3")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
