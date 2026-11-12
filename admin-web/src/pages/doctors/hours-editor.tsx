import { Plus, Trash2 } from "lucide-react";
import { WEEKDAYS, cn, hhmmLabel, type Interval, type WeekdayKey, type WeeklyHours } from "@clinica/calendar";
import { DAY_NAME, validateHours } from "../../lib/hours";
import { timeOptions } from "../../lib/range";
import { Select } from "../../ui/controls";

const TIMES = timeOptions("06:00", "21:00");

function TimeSelect({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  // Si el horario trae una hora que no es de media en media, se conserva como opción.
  const options = TIMES.includes(value) || !value ? TIMES : [...TIMES, value].sort();
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-[6.75rem] px-2 text-[13px]">
      {options.map((t) => (
        <option key={t} value={t}>
          {hhmmLabel(t)}
        </option>
      ))}
    </Select>
  );
}

/**
 * Editor del horario semanal: un renglón por día con «Atiende», y uno o más tramos.
 * Se valida mientras se edita contra `limit` (el horario de la clínica, si se da).
 */
export function HoursEditor({
  value,
  onChange,
  limit,
  disabled,
}: {
  value: WeeklyHours;
  onChange: (next: WeeklyHours) => void;
  limit?: WeeklyHours;
  disabled?: boolean;
}) {
  const errors = validateHours(value, limit);

  const setDay = (d: WeekdayKey, ivs: Interval[]) => onChange({ ...value, [d]: ivs });

  return (
    <ul className="divide-y rounded-lg border" aria-label="Horario semanal">
      {WEEKDAYS.map((d) => {
        const ivs = value[d] ?? [];
        const on = ivs.length > 0;
        return (
          <li key={d} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-4">
            <label className="flex w-36 shrink-0 cursor-pointer items-center gap-2 pt-1 text-sm font-semibold">
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                aria-label={`${DAY_NAME[d]}: atiende`}
                onChange={(e) => setDay(d, e.target.checked ? [limit?.[d]?.[0] ? { ...limit[d]![0]! } : { start: "09:00", end: "13:00" }] : [])}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              {DAY_NAME[d]}
            </label>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {!on && <span className="pt-1 text-sm text-text-3">No atiende</span>}
              {ivs.map((iv, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <TimeSelect label={`${DAY_NAME[d]}: desde`} value={iv.start} onChange={(v) => setDay(d, ivs.map((x, j) => (j === i ? { ...x, start: v } : x)))} />
                  <span className="text-text-3">a</span>
                  <TimeSelect label={`${DAY_NAME[d]}: hasta`} value={iv.end} onChange={(v) => setDay(d, ivs.map((x, j) => (j === i ? { ...x, end: v } : x)))} />
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`${DAY_NAME[d]}: quitar tramo ${i + 1}`}
                    onClick={() => setDay(d, ivs.filter((_, j) => j !== i))}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-text-3 hover:bg-accent hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ))}
              {on && !disabled && (
                <button
                  type="button"
                  onClick={() => setDay(d, [...ivs, { start: ivs[ivs.length - 1]?.end ?? "09:00", end: "18:00" }])}
                  className="flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-brand-text hover:bg-brand-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Agregar tramo
                </button>
              )}
              {errors[d] && (
                <p role="alert" className={cn("text-xs font-medium text-danger-text")}>
                  {errors[d]}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
