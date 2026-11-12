import { useMemo, useState } from "react";
import { CalendarOff, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import {
  TimeGrid,
  Button,
  addDaysISO,
  calendarVisible,
  datesOf,
  isIsoDate,
  rangeLabel,
  startOfWeek,
  todayInTz,
  tzOffsetLabel,
  wallClock,
  type Lane,
} from "@clinica/calendar";
import type { Booking } from "@clinica/api-client";
import { SyncStatus } from "../../layout/status";
import { describeAbsence, overlapsRange } from "../../lib/absence";
import { useCanWrite } from "../../lib/can-write";
import { TZ } from "../../lib/fmt";
import { rangeToUtc } from "../../lib/range";
import { useNow } from "../../lib/use-now";
import { useProfile } from "../../profile";
import { navigate, useQueryState } from "../../router";
import { Checkbox, PageMessage, Spinner } from "../../ui/controls";
import { useAbsences } from "../absences/use-absences";
import { BookingSheet } from "./booking-sheet";
import { EventDialog, type EventTarget } from "./event-dialog";
import { useAgenda } from "./use-agenda";
import { usePersonalEvents } from "./use-personal-events";

/**
 * Hoy y Semana: MI agenda en la rejilla de `@clinica/calendar`, con UN solo carril (el mío). La API se
 * consulta por semana (lunes a domingo) y Hoy/Semana comparten esa consulta, su copia guardada y su ETag:
 * pasar de una vista a otra no vuelve a pedir nada. El día y las canceladas viajan en la dirección
 * (`#/hoy?dia=2026-11-12`), así se puede recargar o compartir.
 *
 * También mis eventos personales de esa semana (privados): se ven en la rejilla con su título, un toque los abre para
 * editarlos o borrarlos, y un toque en un hueco vacío (o el botón «Evento») crea uno nuevo. NO son citas: en ese horario no
 * recibo citas, pero el consultorio sigue libre para los demás doctores.
 */
export function AgendaPage({ view }: { view: "hoy" | "semana" }) {
  const [query, setQuery] = useQueryState();
  const { doctor, error: profileError, reload } = useProfile();
  const absences = useAbsences();
  const { canWrite, reason: readOnlyReason } = useCanWrite();
  const now = useNow(30_000);
  const today = todayInTz(now, TZ);

  const diaParam = query.get("dia");
  const anchor = isIsoDate(diaParam) ? diaParam : today;
  const showCancelled = query.get("canceladas") === "1";

  const weekFrom = startOfWeek(anchor);
  const week = useMemo(() => ({ from: weekFrom, to: addDaysISO(weekFrom, 6) }), [weekFrom]);
  const utc = useMemo(() => rangeToUtc(week), [week]);
  const { bookings, ready, error, stale, syncedAt, refreshNow } = useAgenda(utc);
  const personal = usePersonalEvents(utc);
  // El evento abierto (o el que se va a crear). Un evento abierto se mantiene al día con el refresco.
  const [eventTarget, setEventTarget] = useState<EventTarget | null>(null);
  const openEvent = eventTarget?.mode === "edit" ? (personal.events.find((e) => e.id === eventTarget.event.id) ?? eventTarget.event) : null;

  const visible = useMemo(() => calendarVisible(bookings, { showCancelled }), [bookings, showCancelled]);
  const days = useMemo(() => (view === "hoy" ? [anchor] : datesOf(week)), [view, anchor, week]);

  const [selected, setSelected] = useState<Booking | null>(null);
  // La cita abierta se mantiene al día con el refresco; si ya no está en el rango, queda la última copia.
  const live = selected ? (bookings.find((b) => b.id === selected.id) ?? selected) : null;

  const lanes = useMemo<Lane[] | undefined>(
    () => (view === "hoy" && doctor ? [{ id: doctor.id, label: doctor.name, sublabel: doctor.specialty, weeklyHours: doctor.weeklyHours }] : undefined),
    [view, doctor]
  );
  const laneOf = useMemo(() => (doctor ? () => doctor.id : undefined), [doctor]);

  const go = (changes: Record<string, string | null>) => setQuery(changes);
  const step = view === "hoy" ? 1 : 7;
  const title = view === "hoy" ? rangeLabel("dia", anchor) : rangeLabel("semana", anchor);

  // Citas que se ven (sin canceladas) del rango mostrado, para el contador.
  const shownRange = rangeToUtc({ from: days[0]!, to: days[days.length - 1]! });
  const inView = visible.filter((b) => b.kind === "session" && b.scheduledAtUtc >= shownRange.from && b.scheduledAtUtc < shownRange.to);

  // Mis ausencias que tocan lo que estoy viendo: que no se me olvide que ese día no atiendo.
  const absentNow = (absences.data ?? []).filter((a) => overlapsRange(a, shownRange.from, shownRange.to));

  if (!doctor) {
    return profileError ? (
      <PageMessage title="No se pudo cargar tu agenda" action={<Button onClick={() => void reload()}>Reintentar</Button>}>
        {profileError}
      </PageMessage>
    ) : (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label="Cargando tu agenda" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* En el celular el título va arriba, completo; en escritorio todo en una fila (flechas, título, estado). */}
      <div className="flex flex-col gap-2 border-b px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
        <h1 className="text-[15px] font-bold tracking-tight sm:order-2 sm:min-w-0 sm:truncate sm:text-base">{title}</h1>
        <div className="flex items-center gap-1.5 sm:order-1">
          <Button variant="outline" size="icon" aria-label={view === "hoy" ? "Día anterior" : "Semana anterior"} onClick={() => go({ dia: addDaysISO(anchor, -step) })}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <Button variant="outline" size="icon" aria-label={view === "hoy" ? "Día siguiente" : "Semana siguiente"} onClick={() => go({ dia: addDaysISO(anchor, step) })}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button variant="outline" size="sm" disabled={view === "hoy" ? anchor === today : startOfWeek(anchor) === startOfWeek(today)} onClick={() => go({ dia: null })}>
            Hoy
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Nuevo evento personal"
            disabled={!canWrite}
            title={readOnlyReason ?? "Agrega un evento personal a tu agenda"}
            onClick={() => setEventTarget({ mode: "new", day: anchor, time: "09:00" })}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Evento
          </Button>
          <span className="ml-auto text-xs font-semibold text-text-2 sm:ml-2" data-testid="booking-count">
            {inView.length} {inView.length === 1 ? "cita" : "citas"}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 sm:order-3 sm:ml-auto sm:justify-end">
          <Checkbox label="Mostrar canceladas" className="whitespace-nowrap text-xs text-text-3" checked={showCancelled} onChange={(e) => go({ canceladas: e.target.checked ? "1" : null })} />
          <SyncStatus syncedAt={syncedAt} stale={stale} />
        </div>
      </div>

      {absentNow.length > 0 && (
        <div role="status" className="flex items-start gap-2 border-b border-warning-soft bg-warning-tint px-4 py-1.5 text-xs font-medium text-warning-text sm:px-6">
          <CalendarOff className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Ausencia registrada: {absentNow.slice(0, 3).map((a) => `${describeAbsence(a)}${a.reason ? ` — ${a.reason}` : ""}`).join(" · ")}
            {absentNow.length > 3 ? ` y ${absentNow.length - 3} más` : ""}
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col p-3 sm:px-6 sm:py-4">
        {error && !ready ? (
          <PageMessage title="No se pudo cargar tu agenda" action={<Button onClick={() => void refreshNow()}>Reintentar</Button>}>
            {error}
            <span className="mt-1 block text-xs text-text-3">Esta semana no está guardada en este dispositivo.</span>
          </PageMessage>
        ) : (
          <TimeGrid
            days={days}
            bookings={visible}
            timezone={TZ}
            weeklyHours={doctor.weeklyHours}
            today={today}
            nowMinutes={wallClock(now, TZ).minutes}
            tzLabel={tzOffsetLabel(TZ, now)}
            selectedId={live?.id ?? null}
            ready={ready}
            lanes={lanes}
            laneOf={laneOf}
            // mis ausencias, como franjas rayadas en la rejilla (de la fecha y hora en que empiezan a la en que terminan)
            absences={absences.data ?? undefined}
            // mis eventos personales (privados), con su título; NO son citas de la clínica
            personalEvents={personal.events}
            selectedEventId={openEvent?.id ?? null}
            onSelect={setSelected}
            onSelectEvent={(ev) => {
              const full = personal.events.find((x) => x.id === ev.id);
              if (full) setEventTarget({ mode: "edit", event: full });
            }}
            // El doctor no agenda pacientes desde aquí: tocar un hueco propone un EVENTO PERSONAL (sin conexión no hace nada).
            onEmptySlot={(day, time) => canWrite && setEventTarget({ mode: "new", day, time })}
            onOpenDay={(day) => navigate("/hoy", { dia: day })}
          />
        )}
      </div>

      {live && <BookingSheet key={live.id} booking={live} onClose={() => setSelected(null)} />}
      {eventTarget && (
        <EventDialog
          key={eventTarget.mode === "edit" ? `e${eventTarget.event.id}` : `n${eventTarget.day}${eventTarget.time}`}
          target={openEvent ? { mode: "edit", event: openEvent } : eventTarget}
          bookings={bookings}
          onClose={() => setEventTarget(null)}
          onChanged={() => personal.reload()}
        />
      )}
    </div>
  );
}
