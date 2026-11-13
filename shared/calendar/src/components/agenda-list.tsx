
import { useMemo } from "react";
import { Bot, CalendarDays } from "lucide-react";
import { bookingSegments, longDayLabel, spanLabel, type DateRange } from "../lib/calendar";
import { timeRangeLabel } from "../lib/time-format";
import { cn } from "../lib/utils";
import { EmptyState } from "./ui";
import { STATUS_LABEL, bookingDotStyle, bookingSubtitle, bookingTitle, bookingTone, channelLabel, type Booking } from "./booking-look";

/**
 * 215 — La Lista: las citas del rango, agrupadas por día, como la «Agenda» de
 * Google o la lista de reuniones de Zoom. Es la vista para revisar qué viene
 * (o qué pasó) sin buscar en la rejilla.
 */
export function AgendaList({
  range,
  bookings,
  timezone,
  today,
  selectedId,
  onSelect,
}: {
  range: DateRange;
  bookings: Booking[];
  timezone: string;
  today: string;
  selectedId: string | null;
  onSelect: (b: Booking) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, { booking: Booking; startMin: number; endMin: number }[]>();
    for (const b of bookings) {
      const segs = bookingSegments(b.scheduledAtUtc, b.durationMinutes, timezone);
      const first = segs[0];
      const last = segs[segs.length - 1];
      if (!first || !last || first.day < range.from || first.day > range.to) continue;
      const list = map.get(first.day) ?? [];
      list.push({ booking: b, startMin: first.startMin, endMin: last.endMin });
      map.set(first.day, list);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, items]) => ({ day, items: items.sort((a, b) => a.startMin - b.startMin) }));
  }, [bookings, timezone, range.from, range.to]);

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        className="min-h-0 flex-1 rounded-lg border bg-card p-8"
        title={`Nada agendado del ${spanLabel(range)}`}
        description="Aquí aparecen las citas que agenda el bot o el personal."
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
      {groups.map(({ day, items }) => (
        <section key={day}>
          <h3 className="sticky top-0 z-10 flex items-center gap-2 border-b bg-subtle px-4 py-2 text-[13px] font-semibold first-letter:uppercase">
            {longDayLabel(day)}
            {day === today && (
              <span className="rounded-full bg-brand px-2 py-px text-[10.5px] font-semibold text-brand-fg">
                Hoy
              </span>
            )}
          </h3>
          <ul className="divide-y">
            {items.map(({ booking: b, startMin, endMin }) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => onSelect(b)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-soft",
                    b.id === selectedId && "bg-row-hover"
                  )}
                >
                  <span className="w-[9.5rem] shrink-0 whitespace-nowrap font-mono text-[12px] text-text-2">
                    {timeRangeLabel(startMin, endMin)}
                  </span>
                  <span aria-hidden className={cn("h-2.5 w-2.5 shrink-0 rounded-full", bookingTone(b).dot)} style={bookingDotStyle(b)} />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "flex items-center gap-1.5 truncate text-sm font-semibold",
                        b.status === "cancelada" && "text-text-3 line-through"
                      )}
                    >
                      <span className="truncate">{bookingTitle(b)}</span>
                      {b.source === "ai" && b.kind === "session" && (
                        <Bot aria-label="Agendó el bot" className="h-3.5 w-3.5 shrink-0 text-brand-text" />
                      )}
                    </span>
                    <span className="block truncate text-xs text-text-3">
                      {b.kind === "block"
                        ? `Bloqueo · ${b.durationMinutes} min`
                        : [bookingSubtitle(b), `${b.durationMinutes} min`, b.source === "ai" ? "Agendó el bot" : "Manual", b.channel && b.channel !== "whatsapp" ? channelLabel(b.channel) : null]
            .filter(Boolean)
            .join(" · ")}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-xs font-medium text-text-2 sm:block">
                    {b.kind === "block" ? (b.status === "cancelada" ? "Bloqueo quitado" : "Bloqueo") : STATUS_LABEL[b.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
