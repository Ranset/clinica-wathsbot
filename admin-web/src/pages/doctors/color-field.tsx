import { useState } from "react";
import { Check } from "lucide-react";
import { DOCTOR_COLORS, DOCTOR_COLOR_NAMES, ON_DOCTOR_COLOR, cn, isReadableOnWhite } from "@clinica/calendar";
import { Notice } from "../../ui/controls";

const SWATCH = "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft focus-visible:ring-offset-2";

/**
 * El color del doctor en el calendario: «Automático» (la paleta según su número), uno de la paleta o el que se quiera
 * con «Otro color». `value` es `#rrggbb` o `null` (= automático). Un color demasiado claro se rechaza aquí mismo (el
 * servidor repite la regla): las citas llevan texto blanco encima.
 *
 * - `autoColor`: el automático de ESTE doctor (aún no existe para uno nuevo: `null`).
 * - `usedBy`: nombre de OTRO doctor que ya tiene ese color (solo un aviso: dos doctores con el mismo color se confunden).
 */
export function ColorField({
  value,
  onChange,
  autoColor,
  usedBy,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
  autoColor: string | null;
  usedBy: string | null;
}) {
  const [tooLight, setTooLight] = useState(false);
  const inPalette = value !== null && (DOCTOR_COLORS as readonly string[]).includes(value);
  const custom = value !== null && !inPalette;
  const shown = value ?? autoColor;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-semibold text-text-2">Color en el calendario</legend>
      <div role="radiogroup" aria-label="Color en el calendario" className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          aria-label="Automático"
          title="Automático: un color de la paleta según el número del doctor"
          onClick={() => { setTooLight(false); onChange(null); }}
          className={cn(SWATCH, value === null ? "border-foreground" : "border-border-strong border-dashed")}
          style={{ background: autoColor ?? "conic-gradient(#1d4ed8, #c2410c, #7e22ce, #0e7490, #be185d, #4d7c0f, #1d4ed8)" }}
        >
          <span aria-hidden className="text-[11px] font-bold" style={{ color: ON_DOCTOR_COLOR }}>A</span>
        </button>

        {DOCTOR_COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value === c}
            aria-label={DOCTOR_COLOR_NAMES[i]}
            title={DOCTOR_COLOR_NAMES[i]}
            onClick={() => { setTooLight(false); onChange(c); }}
            className={cn(SWATCH, value === c ? "border-foreground" : "border-transparent hover:scale-110")}
            style={{ backgroundColor: c }}
          >
            {value === c && <Check className="h-4 w-4" style={{ color: ON_DOCTOR_COLOR }} strokeWidth={3} aria-hidden />}
          </button>
        ))}

        <label
          title="Elegir cualquier otro color"
          className={cn(SWATCH, "cursor-pointer overflow-hidden p-0", custom ? "border-foreground" : "border-border-strong border-dashed")}
          style={custom ? { backgroundColor: value } : undefined}
        >
          <span className="sr-only">Otro color</span>
          {!custom && <span aria-hidden className="text-base font-bold leading-none text-text-3">+</span>}
          <input
            type="color"
            aria-label="Otro color"
            value={custom ? value : "#1d4ed8"}
            onChange={(e) => {
              const picked = e.target.value.toLowerCase();
              if (isReadableOnWhite(picked)) { setTooLight(false); onChange(picked); } else setTooLight(true);
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
      </div>

      {tooLight && (
        <Notice tone="warn">Ese color es muy claro: el texto blanco de las citas no se leería. Elige uno más oscuro.</Notice>
      )}
      {usedBy && !tooLight && <Notice tone="warn">Ese color ya lo usa {usedBy}: en el calendario se confundirían. Puedes elegir otro.</Notice>}

      <div className="flex items-center gap-2 text-xs text-text-3">
        Así se ve una cita:
        <span
          className="rounded-md px-2 py-1 text-[11.5px] font-semibold"
          style={{ backgroundColor: shown ?? "var(--text-4)", color: ON_DOCTOR_COLOR }}
          data-testid="color-preview"
        >
          9:00 AM · Paciente
        </span>
        {value === null && <span>(automático)</span>}
      </div>
    </fieldset>
  );
}
