import { useEffect, useMemo, useRef } from "react";
import { Bot } from "lucide-react";
import {
  bookingSegments,
  dayHeading,
  hhmm,
  layoutOverlaps,
  offHoursBands,
  workingBands,
  type DaySegment,
} from "../lib/calendar";
import type { Lane, WeeklyHours } from "../types";
import { cn } from "../lib/utils";
import { timeLabel } from "../lib/time-format";
import { bookingStyle, bookingSubtitle, bookingTitle, bookingTone, type Booking } from "./booking-look";

/**
 * La rejilla de horas de las vistas Dia y Semana (adaptada de Vocero CRM, MIT):
 * cada cita ocupa el alto de su duracion, lo que se solapa se reparte el
 * ancho, lo no habil se sombrea y una linea marca la hora actual.
 *
 * Todo en la zona de la clinica: el dia y el minuto de cada cita los decide
 * `bookingSegments`, no el reloj del navegador.
 *
 * Novedad respecto a Vocero: con `lanes` (y un solo dia) las columnas son
 * doctores o consultorios en vez de dias, cada una con su propio horario
 * sombreado. Es la vista de recepcion: quien esta libre y donde, de un vistazo.
 */

const HOUR_PX = 48;
const DAY_PX = HOUR_PX * 24;
const MIN_EVENT_PX = 18;
const DEFAULT_SCROLL_MIN = 8 * 60;

type Placed = DaySegment & { booking: Booking; col: number; cols: number };

type Col = {
  key: string;
  day: string;
  laneId?: string;
  weeklyHours: WeeklyHours;
  head: { top: string; main: string; sub?: string; today: boolean; color?: string };
};

export function TimeGrid({
  days,
  bookings,
  timezone,
  weeklyHours,
  today,
  nowMinutes,
  tzLabel,
  selectedId,
  ready,
  lanes,
  laneOf,
  onSelect,
  onEmptySlot,
  onOpenDay,
}: {
  days: string[];
  bookings: Booking[];
  timezone: string;
  /** Horario de la clinica; cada carril puede traer el suyo. */
  weeklyHours: WeeklyHours;
  today: string;
  nowMinutes: number;
  /** "GMT-5": la esquina dice en que hora esta pintada la rejilla. */
  tzLabel: string;
  selectedId: string | null;
  /** Las citas de ESTE rango ya llegaron: solo entonces se decide el scroll. */
  ready: boolean;
  /** Columnas por doctor/consultorio (solo con un dia). */
  lanes?: Lane[];
  /** A que carril pertenece una cita. Por defecto, su doctor. */
  laneOf?: (b: Booking) => string | undefined;
  onSelect: (b: Booking) => void;
  /** `laneId` llega cuando la rejilla esta en modo carriles. */
  onEmptySlot: (day: string, time: string, laneId?: string) => void;
  onOpenDay: (day: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const laneMode = !!lanes?.length && days.length === 1;
  const getLane = laneOf ?? ((b: Booking) => b.doctor?.id);

  const cols: Col[] = useMemo(() => {
    if (laneMode) {
      const day = days[0]!;
      return lanes!.map((l) => ({
        key: `${day}|${l.id}`,
        day,
        laneId: l.id,
        weeklyHours: l.weeklyHours ?? weeklyHours,
        head: { top: "", main: l.label, sub: l.sublabel, today: false, color: l.color },
      }));
    }
    return days.map((day) => {
      const h = dayHeading(day);
      return {
        key: day,
        day,
        weeklyHours,
        head: { top: h.weekday, main: String(h.day), today: day === today },
      };
    });
  }, [laneMode, lanes, days, weeklyHours, today]);

  const byCol = useMemo(() => {
    const out = new Map<string, Placed[]>();
    const raw = new Map<string, (DaySegment & { booking: Booking })[]>();
    for (const b of bookings) {
      for (const s of bookingSegments(b.scheduledAtUtc, b.durationMinutes, timezone)) {
        if (!days.includes(s.day)) continue;
        const key = laneMode ? `${s.day}|${getLane(b) ?? ""}` : s.day;
        const list = raw.get(key) ?? [];
        list.push({ ...s, booking: b });
        raw.set(key, list);
      }
    }
    for (const [key, list] of raw) out.set(key, layoutOverlaps(list));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings, days, timezone, laneMode, laneOf]);

  // Abre donde empieza el dia de trabajo (o antes, si hay una cita mas
  // temprano), una sola vez por rango: un refresco no debe mover la rejilla
  // que alguien esta leyendo.
  const rangeKey = `${days[0]}|${days.length}|${laneMode ? "L" : "D"}`;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !ready || scrolledFor.current === rangeKey) return;
    scrolledFor.current = rangeKey;
    const starts = [
      ...cols.flatMap((c) => workingBands(c.weeklyHours, c.day).map((b) => b.startMin)),
      ...[...byCol.values()].flat().map((p) => p.startMin),
    ];
    const target = starts.length > 0 ? Math.min(...starts) : DEFAULT_SCROLL_MIN;
    el.scrollTop = Math.max(0, ((target - 45) / 60) * HOUR_PX);
  }, [ready, rangeKey, cols, byCol]);

  const multi = cols.length > 1;
  const minCol = laneMode ? "8rem" : multi ? "5.5rem" : "0";
  const columns = `3.5rem repeat(${cols.length}, minmax(${minCol}, 1fr))`;

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto rounded-lg border bg-card"
      style={{ "--cal-hour": `${HOUR_PX}px` } as React.CSSProperties}
    >
      <div className="grid" style={{ gridTemplateColumns: columns, minWidth: laneMode ? `${3.5 + cols.length * 8}rem` : multi ? "40rem" : undefined }}>
        {/* Encabezados: pegados arriba mientras se desplaza la rejilla. */}
        <div className="sticky left-0 top-0 z-40 flex items-end justify-end border-b border-r bg-card px-1.5 pb-1.5 font-mono text-[10px] text-text-3">
          {tzLabel}
        </div>
        {cols.map((c) =>
          laneMode ? (
            <div
              key={c.key}
              data-lane-head={c.laneId}
              // la franja del color del doctor: de un vistazo se ve de quien es cada columna
              style={c.head.color ? { borderTopWidth: 4, borderTopStyle: "solid", borderTopColor: c.head.color } : undefined}
              className="sticky top-0 z-30 flex flex-col items-center justify-center gap-0.5 border-b border-l bg-card px-2 py-2 text-center"
            >
              <span className="max-w-full truncate text-[13px] font-semibold text-foreground">{c.head.main}</span>
              {c.head.sub && <span className="kicker max-w-full truncate">{c.head.sub}</span>}
            </div>
          ) : (
            <button
              key={c.key}
              type="button"
              onClick={() => onOpenDay(c.day)}
              disabled={!multi}
              aria-label={`Ver el ${c.head.top} ${c.head.main} en la vista de día`}
              className="sticky top-0 z-30 flex flex-col items-center gap-0.5 border-b border-l bg-card py-2 transition-colors enabled:hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-soft"
            >
              <span className={cn("kicker", c.head.today && "text-brand-text")}>{c.head.top}</span>
              <span
                className={cn(
                  "flex h-8 min-w-8 items-center justify-center rounded-full px-1 text-[17px] font-semibold tabular-nums",
                  c.head.today ? "bg-brand text-brand-fg" : "text-foreground"
                )}
              >
                {c.head.main}
              </span>
            </button>
          )
        )}

        {/* Columna de horas. */}
        <div className="sticky left-0 z-20 border-r bg-card" style={{ height: DAY_PX }}>
          {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
            <span key={h} className="absolute right-1.5 -translate-y-1/2 font-mono text-[10.5px] text-text-3" style={{ top: h * HOUR_PX }}>
              {timeLabel(h * 60, { compact: true })}
            </span>
          ))}
        </div>

        {cols.map((c) => (
          <DayColumn
            key={c.key}
            col={c}
            placed={byCol.get(c.key) ?? []}
            nowMinutes={c.day === today ? nowMinutes : null}
            narrow={multi}
            laneMode={laneMode}
            selectedId={selectedId}
            onSelect={onSelect}
            onEmptySlot={onEmptySlot}
          />
        ))}
      </div>
    </div>
  );
}

function DayColumn({
  col,
  placed,
  nowMinutes,
  narrow,
  laneMode,
  selectedId,
  onSelect,
  onEmptySlot,
}: {
  col: Col;
  placed: Placed[];
  nowMinutes: number | null;
  narrow: boolean;
  laneMode: boolean;
  selectedId: string | null;
  onSelect: (b: Booking) => void;
  onEmptySlot: (day: string, time: string, laneId?: string) => void;
}) {
  return (
    <div
      data-day={col.day}
      data-lane={col.laneId}
      className="cal-hours relative isolate cursor-pointer border-l"
      style={{ height: DAY_PX }}
      // Tocar un hueco vacio propone agendar/bloquear a esa media hora, como
      // el "crear evento" de Google. Las citas detienen el clic.
      onClick={(e) => {
        const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
        const minutes = Math.min(1410, Math.max(0, Math.floor((y / HOUR_PX) * 2) * 30));
        onEmptySlot(col.day, hhmm(minutes), col.laneId);
      }}
    >
      {offHoursBands(col.weeklyHours, col.day).map((b) => (
        <div
          key={b.startMin}
          aria-hidden
          className="cal-off pointer-events-none absolute inset-x-0"
          style={{ top: (b.startMin / 60) * HOUR_PX + 1, height: ((b.endMin - b.startMin) / 60) * HOUR_PX - 1 }}
        />
      ))}

      {placed.map((p) => (
        <EventBlock
          key={`${p.booking.id}:${p.day}`}
          placed={p}
          narrow={narrow}
          // En carriles el doctor ya es la columna: la segunda linea es el consultorio.
          subtitle={laneMode ? bookingSubtitle(p.booking, { room: true }) : bookingSubtitle(p.booking)}
          selected={p.booking.id === selectedId}
          onSelect={onSelect}
        />
      ))}

      {nowMinutes !== null && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-danger" style={{ top: (nowMinutes / 60) * HOUR_PX }}>
          <span className="absolute -left-[5px] -top-[6px] h-2.5 w-2.5 rounded-full bg-danger" />
        </div>
      )}
    </div>
  );
}

function EventBlock({
  placed,
  narrow,
  subtitle,
  selected,
  onSelect,
}: {
  placed: Placed;
  narrow: boolean;
  subtitle: string;
  selected: boolean;
  onSelect: (b: Booking) => void;
}) {
  const { booking: b, startMin, endMin, col, cols } = placed;
  const top = (startMin / 60) * HOUR_PX;
  const height = Math.max(MIN_EVENT_PX, ((endMin - startMin) / 60) * HOUR_PX - 2);
  const title = bookingTitle(b);
  const start = timeLabel(startMin);
  const end = timeLabel(endMin);
  // Con citas solapadas la columna se parte y no cabe "11:00 AM – 12:00 PM": cortado ("11:00 A…") se confunde AM con PM.
  // Ahí solo se pone la hora de inicio; el tramo completo sigue en el nombre accesible y en el detalle.
  const range = cols > 1 ? start : `${placed.continuesBefore ? "…" : start} – ${placed.continuesAfter ? "…" : end}`;
  // Una cita corta cabe en una linea: "Nombre, 10:00", como en Google.
  const compact = height < 36;
  const showTime = !compact || cols === 1;
  const showSub = !compact && !!subtitle && height >= 52;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(b);
      }}
      aria-label={`${title}${subtitle ? ", " + subtitle : ""}, ${start} a ${end}`}
      className={cn(
        "absolute z-10 overflow-hidden rounded-[6px] border text-left leading-tight shadow-sm transition-[box-shadow,filter] hover:brightness-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
        cols > 1 ? "px-1" : "px-1.5",
        compact ? "flex flex-wrap content-start items-center gap-x-1 text-[11px]" : "py-1 text-[11.5px]",
        bookingTone(b).box,
        selected && "ring-2 ring-brand ring-offset-1 ring-offset-background"
      )}
      style={{
        top: top + 1,
        height,
        left: `calc(${(col / cols) * 100}% + 2px)`,
        width: `calc(${100 / cols}% - 4px)`,
        paddingTop: compact ? Math.max(1, (height - 14) / 2) : undefined,
        ...bookingStyle(b), // el color del doctor
      }}
    >
      <span className="flex min-w-0 max-w-full items-center gap-1 font-semibold">
        {b.source === "ai" && b.kind === "session" && <Bot aria-label="Agendó el bot" className="h-3 w-3 shrink-0" strokeWidth={2} />}
        <span className="truncate">{title}</span>
      </span>
      {showTime && (
        <span
          className={cn(
            "font-mono text-[10.5px] opacity-80",
            compact ? cn("shrink-0 whitespace-nowrap", narrow && "hidden sm:inline") : "mt-0.5 block truncate"
          )}
        >
          {compact ? start : range}
        </span>
      )}
      {showSub && <span className="block truncate text-[10.5px] opacity-80">{subtitle}</span>}
    </button>
  );
}
