import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@clinica/calendar";
import { inputClass } from "./controls";

/** Una opción de la lista: `lead` (p. ej. el código) y `label` (el nombre). Se busca por cualquiera de los dos. */
export type ComboOption = { value: string; lead?: string; label: string };

/** Minúsculas y sin acentos ni signos de combinación: «Pérez» y «perez» son lo mismo al buscar. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Lo que se lee en el campo al elegir una opción: «1001 · Dr. Cervantes Peláez». */
export const display = (o: ComboOption): string => (o.lead ? `${o.lead} · ${o.label}` : o.label);

/**
 * Las opciones que coinciden con lo escrito: cada palabra escrita debe aparecer en el código o en el nombre (sin importar mayúsculas
 * ni acentos). Las que EMPIEZAN con lo escrito (el código, o una palabra del nombre) van primero; el orden original se conserva.
 */
export function filterOptions(options: ComboOption[], query: string): ComboOption[] {
  const tokens = fold(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return options;
  const scored: { o: ComboOption; rank: number; i: number }[] = [];
  options.forEach((o, i) => {
    const lead = fold(o.lead ?? "");
    const words = fold(o.label).split(" ");
    const hay = `${lead} ${fold(o.label)}`;
    if (!tokens.every((t) => hay.includes(t))) return;
    const starts = tokens.every((t) => lead.startsWith(t) || words.some((w) => w.startsWith(t)));
    scored.push({ o, rank: starts ? 0 : 1, i });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((s) => s.o);
}

type Props = {
  label: string;
  options: ComboOption[];
  /** El `value` de la opción elegida, o `null` si no hay ninguna. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Solo cuando la persona ELIGE una opción (clic, Enter), no al teclear un código completo: para pasar al siguiente campo. */
  onPick?: (option: ComboOption) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Se muestra cuando lo escrito no coincide con nada. */
  emptyText?: (typed: string) => string;
  hint?: string;
  error?: string | null;
};

/**
 * Un select con autocompletado (patrón «combobox» de ARIA): se escribe y la lista se reduce; ↑ ↓ mueven, Enter o Tab eligen la
 * resaltada, Esc cierra. Si lo escrito es EXACTAMENTE el código de una opción, se elige sola. Elegir pone «código · nombre» en el
 * campo; volver a escribir quita la elección (`onChange(null)`).
 */
export function Combobox({ label, options, value, onChange, onPick, placeholder, disabled, emptyText, hint, error }: Props) {
  const uid = useId();
  const inputId = `${uid}-input`;
  const listId = `${uid}-list`;
  const noteId = `${uid}-note`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);
  const [text, setText] = useState(() => (selected ? display(selected) : ""));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // Si la elección cambia desde fuera (p. ej. un botón de demostración), el campo la muestra.
  useEffect(() => {
    if (selected) setText(display(selected));
  }, [selected]);

  // Con una opción elegida y el texto intacto, la lista muestra TODAS (como un select); si se está escribiendo, solo las que coinciden.
  const typing = !selected || text !== display(selected);
  const shown = useMemo(() => (typing ? filterOptions(options, text) : options), [options, text, typing]);
  const activeIndex = Math.min(active, shown.length - 1);
  const optionId = (i: number) => `${uid}-opt-${i}`;

  // La opción resaltada con el teclado siempre queda a la vista.
  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex]);

  const choose = (o: ComboOption, byUser: boolean) => {
    setText(display(o));
    setOpen(false);
    onChange(o.value);
    if (byUser) onPick?.(o);
  };

  const onType = (v: string) => {
    setText(v);
    setOpen(true);
    setActive(0);
    const exact = options.filter((o) => o.lead && fold(o.lead) === fold(v));
    if (exact.length === 1) choose(exact[0]!, false); // escribió un código completo: es esa opción
    else if (value !== null) onChange(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(selected ? Math.max(shown.indexOf(selected), 0) : 0);
      } else if (shown.length > 0) {
        setActive(e.key === "ArrowDown" ? Math.min(activeIndex + 1, shown.length - 1) : Math.max(activeIndex - 1, 0));
      }
    } else if (e.key === "Enter") {
      if (open && shown[activeIndex]) {
        e.preventDefault(); // elegir, no enviar el formulario
        choose(shown[activeIndex]!, true);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      // Tab acepta lo resaltado si todavía no había elección (el foco sigue su camino).
      if (open && value === null && shown[activeIndex]) choose(shown[activeIndex]!, false);
      else setOpen(false);
    }
  };

  const onBlur = () => {
    setOpen(false);
    // Salió del campo con una sola coincidencia posible: es esa.
    if (value === null && text.trim() && shown.length === 1) choose(shown[0]!, false);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-[13px] font-semibold text-text-2">
        {label}
      </label>
      <div
        ref={wrapRef}
        className="relative"
        onBlur={(e) => {
          if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) onBlur(); // el foco pasó a la lista: no es salir
        }}
      >
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open && shown.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-describedby={hint || error ? noteId : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          disabled={disabled}
          placeholder={placeholder}
          value={text}
          onChange={(e) => onType(e.target.value)}
          onFocus={(e) => {
            setOpen(true);
            setActive(selected ? Math.max(options.indexOf(selected), 0) : 0);
            e.currentTarget.select(); // lo escrito se reemplaza al teclear
          }}
          onClick={(e) => {
            setOpen(true);
            if (!typing) e.currentTarget.select(); // el clic que dio el foco suelta la selección: se vuelve a marcar
          }}
          onKeyDown={onKeyDown}
          className={cn(inputClass, "pr-8")}
        />
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />

        {open && shown.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            // El clic en una opción no debe quitarle el foco al campo antes de elegir.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-auto rounded-md border bg-background py-1 shadow-lg"
          >
            {shown.map((o, i) => (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o, true)}
                className={cn(
                  "flex cursor-pointer items-baseline gap-2 px-2.5 py-2 text-sm",
                  i === activeIndex ? "bg-brand-tint text-foreground" : "text-text-2",
                  o.value === value && "font-semibold"
                )}
              >
                {o.lead && <span className="font-mono text-[13px] font-bold tabular-nums text-brand-text">{o.lead}</span>}
                <span className="min-w-0 truncate">{o.label}</span>
              </li>
            ))}
          </ul>
        )}
        {open && shown.length === 0 && (
          <p role="status" className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border bg-background px-3 py-2 text-sm text-text-3 shadow-lg">
            {emptyText ? emptyText(text.trim()) : "Sin coincidencias."}
          </p>
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
