import { useState } from "react";
import { Button, channelLabel, cn, hhmmLabel } from "@clinica/calendar";
import type { BotMode, BotSchedule, Channel, DayKey } from "@clinica/api-client";
import { DAY_NAME, DAY_SHORT } from "../lib/hours";
import { timeOptions } from "../lib/range";
import { BusyButton, Field, FormError, Select } from "../ui/controls";
import { Modal } from "../ui/modal";

/** Los días en el orden de la semana, con su inicial para el botón. */
const DAYS: { key: DayKey; initial: string }[] = [
  { key: "mon", initial: "L" },
  { key: "tue", initial: "M" },
  { key: "wed", initial: "X" },
  { key: "thu", initial: "J" },
  { key: "fri", initial: "V" },
  { key: "sat", initial: "S" },
  { key: "sun", initial: "D" },
];
const ORDER = DAYS.map((d) => d.key);
const TIMES = timeOptions("00:00", "23:30");
/** Lo que se propone al estrenar el horario: de noche y de madrugada, todos los días (cuando la clínica ya cerró). */
const DEFAULT: BotSchedule = { days: [...ORDER], start: "18:00", end: "09:00" };

/** «Lun–Vie», «Todos los días», «Lun, Mié, Vie»: los días en que EMPIEZA el horario. */
export function daysLabel(days: readonly DayKey[]): string {
  const idx = [...days].map((d) => ORDER.indexOf(d)).sort((a, b) => a - b);
  if (idx.length === 7) return "Todos los días";
  const parts: string[] = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j]! + 1) j++;
    parts.push(j - i >= 2 ? `${DAY_SHORT[ORDER[idx[i]!]!]}–${DAY_SHORT[ORDER[idx[j]!]!]}` : idx.slice(i, j + 1).map((k) => DAY_SHORT[ORDER[k]!]).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}

/** «Lun–Vie · 6:00 PM a 9:00 AM»; si termina al día siguiente se dice. */
export function scheduleLabel(s: BotSchedule): string {
  return `${daysLabel(s.days)} · ${hhmmLabel(s.start)} a ${hhmmLabel(s.end)}${s.end < s.start ? " (al día siguiente)" : ""}`;
}

export type ScheduleChange = { mode: BotMode; schedule?: BotSchedule };

/**
 * La ventana de «Horario» de UN canal: elegir si el bot se maneja a mano (con su interruptor) o por horario (se enciende y apaga solo:
 * ciertos días, de una hora a otra, hora de la clínica; si «Hasta» es antes que «Desde» termina al día siguiente).
 */
export function ScheduleDialog({
  channel,
  mode: initialMode,
  schedule: saved,
  busy,
  error,
  onSave,
  onClose,
}: {
  channel: Channel;
  mode: BotMode;
  schedule: BotSchedule | null;
  busy: boolean;
  error: string | null;
  onSave: (change: ScheduleChange) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<BotMode>(initialMode);
  const [days, setDays] = useState<DayKey[]>(saved?.days ? [...saved.days] : DEFAULT.days);
  const [start, setStart] = useState(saved?.start ?? DEFAULT.start);
  const [end, setEnd] = useState(saved?.end ?? DEFAULT.end);
  const [problem, setProblem] = useState<string | null>(null);
  const name = channelLabel(channel);
  const sorted = [...days].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const current: BotSchedule = { days: sorted, start, end };

  const toggle = (d: DayKey) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  const save = () => {
    if (mode === "manual") return onSave({ mode: "manual" });
    if (sorted.length === 0) return setProblem("Elige al menos un día.");
    if (start === end) return setProblem("«Desde» y «Hasta» no pueden ser la misma hora.");
    setProblem(null);
    onSave({ mode: "schedule", schedule: current });
  };

  return (
    <Modal
      title="Horario del bot"
      description={name}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <BusyButton busy={busy} onClick={save}>
            Guardar
          </BusyButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">¿Cómo se activa el bot en {name}?</legend>
          {(
            [
              ["manual", "Manual", "Lo enciendes y apagas tú con el interruptor."],
              ["schedule", "Por horario", "Se enciende y apaga solo dentro del horario que elijas."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm", mode === value ? "border-brand bg-brand-tint" : "bg-background")}>
              <input type="radio" name={`bot-mode-${channel}`} value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
              <span>
                <span className="block font-semibold">{label}</span>
                <span className="block text-xs text-text-3">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {mode === "schedule" && (
          <div className="flex flex-col gap-3">
            <div role="group" aria-label="Días" className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">Días en que empieza</span>
              <div className="flex gap-1.5">
                {DAYS.map(({ key, initial }) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={days.includes(key)}
                    aria-label={DAY_NAME[key]}
                    title={DAY_NAME[key]}
                    onClick={() => toggle(key)}
                    className={cn(
                      "h-9 w-9 rounded-full border text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
                      days.includes(key) ? "border-brand bg-brand text-brand-fg" : "bg-background text-text-3 hover:text-foreground"
                    )}
                  >
                    {initial}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Desde">
                <Select value={start} onChange={(e) => setStart(e.target.value)}>
                  {TIMES.map((t) => (
                    <option key={t} value={t}>
                      {hhmmLabel(t)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Hasta">
                <Select value={end} onChange={(e) => setEnd(e.target.value)}>
                  {TIMES.map((t) => (
                    <option key={t} value={t}>
                      {hhmmLabel(t)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p role="status" className="rounded-md bg-secondary px-3 py-2 text-sm text-text-2">
              {sorted.length === 0 || start === end ? (
                "Elige los días y dos horas distintas."
              ) : (
                <>
                  El bot contestará en {name}: <strong>{scheduleLabel(current)}</strong>.
                  {end < start && " El horario termina a la mañana siguiente y cuenta como parte del día en que empezó."}
                </>
              )}
            </p>
          </div>
        )}

        <FormError>{problem ?? error}</FormError>
      </div>
    </Modal>
  );
}
