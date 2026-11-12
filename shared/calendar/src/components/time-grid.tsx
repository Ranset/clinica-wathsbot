import { useEffect, useMemo, useRef } from "react";
import { Bot, User } from "lucide-react";
import {
  bookingSegments,
  dayHeading,
  hhmm,
  layoutOverlaps,
  offHoursBands,
  workingBands,
  type DaySegment,
} from "../lib/calendar";
import type { CalendarAbsence, CalendarPersonalEvent, Lane, WeeklyHours } from "../types";
import { absenceDaySegment, absenceLabel, type AbsenceSegment } from "../lib/absences";
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

type PlacedBooking = DaySegment & { booking: Booking; col: number; cols: number };
/** Un evento personal ya recortado al dia de su columna. Comparte el reparto de ancho con las citas: si alguna vez se encimaran, se ven las dos. */
type PlacedEvent = DaySegment & { event: CalendarPersonalEvent; col: number; cols: number };
type Placed = PlacedBooking | PlacedEvent;

/** Una franja de ausencia (o de «No disponible») ya recortada al dia de su columna. */
type AbsenceBand = AbsenceSegment & { key: string; label: string; busy: boolean };

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
  absences,
  personalEvents,
  selectedEventId,
  onSelect,
  onSelectEvent,
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
  /** Ausencias a pintar como franjas rayadas (con carriles, solo en el carril de su `laneId`; sin `laneId`, en todas las columnas). */
  absences?: CalendarAbsence[];
  /** Eventos personales del doctor (con su texto), para la agenda de UN doctor. NO son citas de la clinica. Con carriles, en el de su `laneId` (o en todos). */
  personalEvents?: CalendarPersonalEvent[];
  /** El evento resaltado (aparte de `selectedId`: un id de cita y uno de evento pueden coincidir). */
  selectedEventId?: string | null;
  onSelect: (b: Booking) => void;
  onSelectEvent?: (e: CalendarPersonalEvent) => void;
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

  // Las franjas de ausencia de cada columna: cada ausencia se recorta contra el dia de la columna (puede durar semanas).
  const absenceByCol = useMemo(() => {
    const out = new Map<string, AbsenceBand[]>();
    if (!absences?.length) return out;
    for (const c of cols) {
      const bands: AbsenceBand[] = [];
      absences.forEach((a, i) => {
        if (laneMode && a.laneId !== undefined && a.laneId !== c.laneId) return;
        const seg = absenceDaySegment(a, c.day, timezone);
        if (seg) bands.push({ key: `${i}`, label: absenceLabel(a), busy: a.kind === "busy", ...seg });
      });
      if (bands.length) out.set(c.key, bands);
    }
    return out;
  }, [absences, cols, laneMode, timezone]);

  const byCol = useMemo(() => {
    const out = new Map<string, Placed[]>();
    type Raw = DaySegment & ({ booking: Booking } | { event: CalendarPersonalEvent });
    const raw = new Map<string, Raw[]>();
    const push = (key: string, item: Raw) => {
      const list = raw.get(key) ?? [];
      list.push(item);
      raw.set(key, list);
    };
    for (const b of bookings) {
      for (const s of bookingSegments(b.scheduledAtUtc, b.durationMinutes, timezone)) {
        if (!days.includes(s.day)) continue;
        push(laneMode ? `${s.day}|${getLane(b) ?? ""}` : s.day, { ...s, booking: b });
      }
    }
    // Cada evento personal se recorta contra el dia de cada columna; con carriles, solo en el de su `laneId` (o en todos si no trae).
    for (const ev of personalEvents ?? []) {
      for (const c of cols) {
        if (laneMode && ev.laneId !== undefined && ev.laneId !== c.laneId) continue;
        const seg = absenceDaySegment(ev, c.day, timezone);
        if (seg) push(c.key, { ...seg, day: c.day, event: ev });
      }
    }
    for (const [key, list] of raw) out.set(key, layoutOverlaps(list) as Placed[]);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings, personalEvents, cols, days, timezone, laneMode, laneOf]);

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
            absences={absenceByCol.get(c.key) ?? []}
            nowMinutes={c.day === today ? nowMinutes : null}
            narrow={multi}
            laneMode={laneMode}
            selectedId={selectedId}
            selectedEventId={selectedEventId ?? null}
            onSelect={onSelect}
            onSelectEvent={onSelectEvent}
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
  absences,
  nowMinutes,
  narrow,
  laneMode,
  selectedId,
  selectedEventId,
  onSelect,
  onSelectEvent,
  onEmptySlot,
}: {
  col: Col;
  placed: Placed[];
  absences: AbsenceBand[];
  nowMinutes: number | null;
  narrow: boolean;
  laneMode: boolean;
  selectedId: string | null;
  selectedEventId: string | null;
  onSelect: (b: Booking) => void;
  onSelectEvent?: (e: CalendarPersonalEvent) => void;
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

      {/* Ausencias del doctor: debajo de las citas (si hay una cita dentro de una ausencia se ve y se nota) y sin tapar los clics del hueco. */}
      {absences.map((a) => {
        const height = ((a.endMin - a.startMin) / 60) * HOUR_PX - 1;
        return (
          <div
            key={a.key}
            // `data-busy`: el doctor ocupado por un evento personal (privado); `data-absence`: una ausencia con su motivo
            {...(a.busy ? { "data-busy": "" } : { "data-absence": "" })}
            role="img"
            aria-label={a.label}
            title={a.label}
            className={cn("pointer-events-none absolute inset-x-0 z-[5] overflow-clip", a.busy ? "cal-busy" : "cal-absence")}
            style={{ top: (a.startMin / 60) * HOUR_PX + 1, height }}
          >
            {/* La etiqueta se queda pegada abajo del encabezado mientras se desplaza la rejilla (si cabe). `overflow-clip`, no `hidden`: este ultimo crearia un contenedor de desplazamiento propio y el `sticky` no funcionaria. */}
            {height >= 24 && <span className="sticky top-[4.5rem] block truncate px-1.5 py-0.5 text-[10.5px] font-semibold">{a.label}</span>}
          </div>
        );
      })}

      {placed.map((p) =>
        "event" in p ? (
          <PersonalEventBlock
            key={`ev-${p.event.id}:${p.day}`}
            placed={p}
            selected={p.event.id === selectedEventId}
            onSelect={onSelectEvent}
          />
        ) : (
          <EventBlock
            key={`${p.booking.id}:${p.day}`}
            placed={p}
            narrow={narrow}
            // En carriles el doctor ya es la columna: la segunda linea es el consultorio.
            subtitle={laneMode ? bookingSubtitle(p.booking, { room: true }) : bookingSubtitle(p.booking)}
            selected={p.booking.id === selectedId}
            onSelect={onSelect}
          />
        )
      )}

      {nowMinutes !== null && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-danger" style={{ top: (nowMinutes / 60) * HOUR_PX }}>
          <span className="absolute -left-[5px] -top-[6px] h-2.5 w-2.5 rounded-full bg-danger" />
        </div>
      )}
    </div>
  );
}

/**
 * Un evento personal en la agenda de SU doctor. Se ve distinto a una cita (tinte neutro, borde punteado, icono de persona) para
 * que no se confunda con un paciente: no es una cita de la clinica.
 */
function PersonalEventBlock({
  placed,
  selected,
  onSelect,
}: {
  placed: PlacedEvent;
  selected: boolean;
  onSelect?: (e: CalendarPersonalEvent) => void;
}) {
  const { event: ev, startMin, endMin, col, cols } = placed;
  const top = (startMin / 60) * HOUR_PX;
  const height = Math.max(MIN_EVENT_PX, ((endMin - startMin) / 60) * HOUR_PX - 2);
  const start = timeLabel(startMin);
  const end = timeLabel(endMin);
  const compact = height < 36;
  const range = cols > 1 ? start : `${placed.continuesBefore ? "…" : start} – ${placed.continuesAfter ? "…" : end}`;

  return (
    <button
      type="button"
      data-personal-event={ev.id}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(ev);
      }}
      aria-label={`Evento personal: ${ev.title}, ${start} a ${end}`}
      className={cn(
        "cal-personal absolute z-10 overflow-hidden rounded-[6px] text-left leading-tight shadow-sm transition-[box-shadow,filter] hover:brightness-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
        cols > 1 ? "px-1" : "px-1.5",
        compact ? "flex flex-wrap content-start items-center gap-x-1 text-[11px]" : "py-1 text-[11.5px]",
        selected && "ring-2 ring-brand ring-offset-1 ring-offset-background"
      )}
      style={{
        top: top + 1,
        height,
        left: `calc(${(col / cols) * 100}% + 2px)`,
        width: `calc(${100 / cols}% - 4px)`,
        paddingTop: compact ? Math.max(1, (height - 14) / 2) : undefined,
      }}
    >
      <span className="flex min-w-0 max-w-full items-center gap-1 font-semibold">
        <User aria-hidden className="h-3 w-3 shrink-0" strokeWidth={2} />
        <span className="truncate">{ev.title}</span>
      </span>
      <span className={cn("font-mono text-[10.5px] opacity-80", compact ? "shrink-0 whitespace-nowrap" : "mt-0.5 block truncate")}>
        {compact ? start : range}
      </span>
    </button>
  );
}

function EventBlock({
  placed,
  narrow,
  subtitle,
  selected,
  onSelect,
}: {
  placed: PlacedBooking;
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
