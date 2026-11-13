import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, addDaysISO, addMonths, cn, hhmm, hhmmLabel, longDayLabel, monthWeeks, rangeLabel, startOfMonth, todayInTz, wallClock, weekdayShortNames } from "@clinica/calendar";
import { isAbortError, type Booking } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { messageFor } from "../../lib/errors";
import { TZ } from "../../lib/fmt";
import { Notice, Spinner } from "../../ui/controls";
import { Modal } from "../../ui/modal";

/** Cuántos días a futuro se agenda (el mismo horizonte del servidor): el calendario no deja pasar de ahí. */
const HORIZON_DAYS = 60;

type Props = {
  /** La cita (o bloqueo) que se mueve: de ella salen sus horarios libres. */
  booking: Booking;
  /** El consultorio elegido en el formulario ("" = el que sea / el actual del bloqueo). */
  roomId: string;
  roomLabel: string;
  /** «Cita de mostrador»: sin la antelación mínima. */
  allowShortNotice: boolean;
  /** Lo que dice hoy el formulario. */
  value: { day: string; time: string };
  onPick: (day: string, time: string) => void;
  onClose: () => void;
};

/**
 * El calendario emergente de «Mover a otro horario»: un mes con los días que tienen horarios libres resaltados y, al elegir un día,
 * sus horarios libres. Los horarios los calcula el servidor con las MISMAS reglas con que valida el movimiento (horario de la clínica y del
 * doctor, ausencias, antelación, doctor y consultorio libres), así que lo que se ve libre se puede elegir. Tocar un horario lo pasa al
 * formulario y se cierra.
 */
export function MoveSlotPicker({ booking, roomId, roomLabel, allowShortNotice, value, onPick, onClose }: Props) {
  const api = useApi();
  const today = useMemo(() => todayInTz(new Date(), TZ), []);
  const lastDay = addDaysISO(today, HORIZON_DAYS);
  const current = useMemo(() => wallClock(booking.scheduledAtUtc, TZ), [booking.scheduledAtUtc]);
  const currentTime = hhmm(current.minutes);
  const isBlock = booking.kind === "block";

  const initial = value.day >= today && value.day <= lastDay ? value.day : current.day >= today && current.day <= lastDay ? current.day : today;
  const [month, setMonth] = useState(startOfMonth(initial));
  const [free, setFree] = useState<Record<string, string[]> | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const weeks = useMemo(() => monthWeeks(month), [month]);
  const grid = useRef<HTMLDivElement>(null);
  const refocus = useRef(false); // se cambio de mes con el teclado: al llegar los horarios, el foco vuelve a los días

  // Los horarios libres de TODO lo que se ve (el mes y los días de las semanas de los bordes): una sola petición.
  useEffect(() => {
    const ctrl = new AbortController();
    setFree(null);
    setError(null);
    const from = weeks[0]![0]!;
    const to = addDaysISO(weeks[weeks.length - 1]![6]!, 1);
    api.appointments.moveSlots(booking.id, { from, to, roomId: roomId || undefined, allowShortNotice }, { signal: ctrl.signal }).then(
      (r) => setFree(Object.fromEntries(r.days.map((d) => [d.date, d.slots]))),
      (e) => {
        if (!isAbortError(e)) setError(messageFor(e));
      }
    );
    return () => ctrl.abort();
  }, [api, booking.id, weeks, roomId, allowShortNotice, attempt]);

  const inMonth = (d: string) => d.slice(0, 7) === month.slice(0, 7);
  const freeDays = useMemo(() => (free ? Object.keys(free).filter((d) => inMonth(d)).sort() : []), [free, month]); // eslint-disable-line react-hooks/exhaustive-deps

  // Al llegar los horarios (o cambiar de mes) queda elegido el día del formulario si tiene lugar; si no, el primero con horarios libres.
  useEffect(() => {
    if (!free) return;
    setDay((prev) => (prev && free[prev] && inMonth(prev) ? prev : free[value.day] && inMonth(value.day) ? value.day : (freeDays[0] ?? null)));
  }, [free]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!free || !refocus.current) return;
    refocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>('[data-day][tabindex="0"]:not([disabled])')?.focus();
  }, [free, day]);

  const canGoBack = startOfMonth(today) < month;
  const canGoForward = month < startOfMonth(lastDay);
  const move = (n: number) => {
    const next = addMonths(month, n);
    if (next < startOfMonth(today) || next > startOfMonth(lastDay)) return;
    setDay(null);
    setMonth(next);
  };

  const times = day && free ? (free[day] ?? []) : [];
  const tabStop = day && free?.[day] ? day : (freeDays[0] ?? null);

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      refocus.current = true;
      move(e.key === "PageUp" ? -1 : 1);
      return;
    }
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key];
    const from = (e.target as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset.day;
    if (!step || !from) return;
    e.preventDefault();
    const grid = e.currentTarget;
    // al siguiente día CON horarios en esa dirección, sin salirse de lo que se ve
    for (let d = addDaysISO(from, step); d >= weeks[0]![0]! && d <= weeks[weeks.length - 1]![6]!; d = addDaysISO(d, step)) {
      const el = grid.querySelector<HTMLButtonElement>(`[data-day="${d}"]:not([disabled])`);
      if (el) {
        el.focus();
        return;
      }
    }
  };

  return (
    <Modal title="Elegir fecha y hora" description={`${isBlock ? roomLabel : [booking.doctor?.name, roomLabel].filter(Boolean).join(" · ")} · dura ${booking.durationMinutes} min`} onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" aria-label="Mes anterior" disabled={!canGoBack} onClick={() => move(-1)}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <p aria-live="polite" className="text-sm font-bold">
            {rangeLabel("mes", month)}
          </p>
          <Button variant="outline" size="sm" aria-label="Mes siguiente" disabled={!canGoForward} onClick={() => move(1)}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <div ref={grid} role="group" aria-label="Días del mes" aria-busy={!free && !error} onKeyDown={onGridKey}>
          <div className="mb-1 grid grid-cols-7 text-center text-[11px] font-semibold uppercase text-text-3" aria-hidden>
            {weekdayShortNames().map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {weeks.flat().map((d) => {
              const n = Number(d.slice(8));
              const hours = free?.[d];
              const enabled = inMonth(d) && !!hours?.length;
              const selected = d === day;
              return (
                <button
                  key={d}
                  type="button"
                  data-day={d}
                  disabled={!enabled}
                  tabIndex={d === tabStop ? 0 : -1}
                  aria-pressed={enabled ? selected : undefined}
                  aria-label={inMonth(d) ? `${longDayLabel(d)}, ${enabled ? `${hours!.length} horarios libres` : free ? "sin horarios libres" : "buscando horarios"}` : undefined}
                  aria-hidden={inMonth(d) ? undefined : true}
                  onClick={() => setDay(d)}
                  className={cn(
                    "flex h-10 items-center justify-center rounded-md text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
                    !inMonth(d) && "invisible",
                    inMonth(d) && !enabled && "text-text-4",
                    enabled && !selected && "bg-brand-tint font-semibold text-brand-text hover:bg-accent",
                    enabled && selected && "bg-brand font-bold text-brand-fg",
                    d === today && "ring-1 ring-inset ring-brand"
                  )}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <p className="mt-2 flex items-center gap-2 text-xs text-text-3">
            <span aria-hidden className="inline-block h-3 w-3 rounded border border-brand-soft bg-brand-tint" />
            Días con horarios libres
          </p>
        </div>

        {error && (
          <Notice tone="warn" className="flex flex-col items-start gap-2">
            <span>No se pudieron cargar los horarios libres. {error}</span>
            <button type="button" onClick={() => setAttempt((a) => a + 1)} className="font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft">
              Reintentar
            </button>
          </Notice>
        )}

        {!free && !error && (
          <p className="flex items-center gap-2 text-sm text-text-2">
            <Spinner label="Buscando horarios libres" />
            Buscando horarios libres…
          </p>
        )}

        {free && freeDays.length === 0 && <p className="rounded-md border border-dashed px-3 py-2 text-sm text-text-3">No hay horarios libres en {rangeLabel("mes", month).toLowerCase()}. Prueba con otro mes.</p>}

        {free && day && times.length > 0 && (
          <section aria-label="Horarios libres" className="flex flex-col gap-2">
            <h3 className="text-sm font-bold first-letter:uppercase">Horarios libres · {longDayLabel(day)}</h3>
            <ul className="grid grid-cols-3 gap-2">
              {times.map((t) => {
                const isCurrent = day === current.day && t === currentTime;
                const picked = day === value.day && t === value.time;
                return (
                  <li key={t}>
                    <button
                      type="button"
                      onClick={() => onPick(day, t)}
                      aria-pressed={picked}
                      className={cn(
                        "flex h-10 w-full flex-col items-center justify-center rounded-md border text-sm font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
                        picked ? "border-brand bg-brand text-brand-fg" : "bg-background hover:bg-accent"
                      )}
                    >
                      {hhmmLabel(t)}
                      {isCurrent && <span className="-mt-0.5 text-[10px] font-medium opacity-80">Horario actual</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
