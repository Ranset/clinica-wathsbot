import { useMemo, useState } from "react";
import { Plus, WifiOff } from "lucide-react";
import {
  AgendaList,
  Button,
  CalendarToolbar,
  DoctorLegend,
  MonthGrid,
  TimeGrid,
  calendarVisible,
  colorOf,
  datesOf,
  isCalendarView,
  isIsoDate,
  monthWeeks,
  rangeLabel,
  shiftRange,
  todayInTz,
  tzOffsetLabel,
  visibleRange,
  wallClock,
  type CalendarAbsence,
  type CalendarView,
  type Lane,
} from "@clinica/calendar";
import type { Booking } from "@clinica/api-client";
import { features } from "../../features";
import { useDirectory } from "../../lib/directory";
import { TZ, ago } from "../../lib/fmt";
import { rangeToUtc } from "../../lib/range";
import { useNow } from "../../lib/use-now";
import { useQueryState } from "../../router";
import { useToast } from "../../toast";
import { Checkbox, PageMessage, Select, Spinner } from "../../ui/controls";
import { BookingDetail } from "./booking-detail";
import { BookingFormDialog, type SlotDraft } from "./booking-form";
import { useAbsences, useBusyTimes } from "./use-absences";
import { useBookings } from "./use-bookings";

const BLOCKS_LANE = "__bloqueos";

/** «Actualizado hace 4 s». Tiene su propio reloj para no repintar toda la página. */
function SyncStatus({ syncedAt }: { syncedAt: Date | null }) {
  const now = useNow(5_000);
  return (
    <span className="whitespace-nowrap text-xs text-text-3" aria-live="off">
      {syncedAt ? `Actualizado ${ago(syncedAt, now)}` : "Cargando…"}
    </span>
  );
}

export function CalendarPage() {
  const toast = useToast();
  const [query, setQuery] = useQueryState();
  const { dir, error: dirError, reload } = useDirectory();
  const now = useNow(30_000);
  const today = todayInTz(now, TZ);

  // Todo el estado de la vista vive en la dirección (#/calendario?vista=…), así se comparte y sobrevive a recargar.
  const vistaParam = query.get("vista");
  const view: CalendarView = isCalendarView(vistaParam) ? vistaParam : "dia";
  const diaParam = query.get("dia");
  const anchor = isIsoDate(diaParam) ? diaParam : today;
  const hastaParam = query.get("hasta");
  const listTo = isIsoDate(hastaParam) ? hastaParam : null;
  const laneBy: "doctor" | "consultorio" = query.get("carriles") === "consultorio" ? "consultorio" : "doctor";
  const doctorFilter = query.get("doctor") ?? "";
  const showCancelled = query.get("canceladas") === "1";

  const range = visibleRange(view, anchor, listTo);
  const days = datesOf(range);
  const utc = useMemo(() => rangeToUtc(range), [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const { bookings, ready, error, syncedAt, refresh, refreshNow } = useBookings({ ...utc, doctorId: doctorFilter || undefined });
  const visible = useMemo(() => calendarVisible(bookings, { showCancelled }), [bookings, showCancelled]);

  // Las ausencias de los doctores (franjas ámbar rayadas con su motivo) y los eventos PERSONALES que los tienen ocupados (franjas
  // grises «No disponible», sin motivo: el detalle es privado del doctor). Solo donde se sabe de QUIEN es cada columna: en «Día»
  // por doctor (cada carril, la suya) y en «Día»/«Semana» con un doctor filtrado (las de ese doctor). En «Semana» sin filtro, o
  // por consultorio, mezclarian a todos los doctores en las mismas columnas: ahi no se pintan.
  const absencesInGrid = (view === "dia" && laneBy === "doctor") || (view === "semana" && !!doctorFilter);
  const absencesList = useAbsences(utc, absencesInGrid);
  const busyList = useBusyTimes(utc, absencesInGrid);
  const gridAbsences = useMemo<CalendarAbsence[] | undefined>(() => {
    if (!absencesInGrid) return undefined;
    const ofDoctor = (d: string) => !doctorFilter || d === doctorFilter;
    return [
      ...absencesList.filter((a) => ofDoctor(a.doctorId)).map((a): CalendarAbsence => ({ startUtc: a.startUtc, endUtc: a.endUtc, reason: a.reason, laneId: a.doctorId })),
      ...busyList.filter((b) => ofDoctor(b.doctorId)).map((b): CalendarAbsence => ({ startUtc: b.startUtc, endUtc: b.endUtc, kind: "busy", laneId: b.doctorId })),
    ];
  }, [absencesInGrid, absencesList, busyList, doctorFilter]);

  const [selected, setSelected] = useState<Booking | null>(null);
  const [draft, setDraft] = useState<SlotDraft | null>(null);
  // La cita abierta se mantiene al día con el refresco; si ya no está en el rango, queda la última copia.
  const live = selected ? (bookings.find((b) => b.id === selected.id) ?? selected) : null;

  const lanes = useMemo<Lane[] | undefined>(() => {
    if (view !== "dia" || !dir) return undefined;
    if (laneBy === "consultorio") return dir.rooms.map((r) => ({ id: r.id, label: r.name, weeklyHours: dir.clinicHours }));
    const out: Lane[] = dir.doctors
      .filter((d) => (!doctorFilter || d.id === doctorFilter) && (d.active || visible.some((b) => b.doctor?.id === d.id)))
      .map((d) => ({ id: d.id, label: d.name, sublabel: d.specialty, weeklyHours: d.weeklyHours, color: colorOf(d) ?? undefined }));
    // Los bloqueos de consultorio no tienen doctor: tienen su propia columna para que no se pierdan.
    if (!doctorFilter && visible.some((b) => !b.doctor)) {
      out.push({ id: BLOCKS_LANE, label: "Bloqueos", sublabel: "Consultorios", weeklyHours: dir.clinicHours });
    }
    return out;
  }, [view, dir, laneBy, doctorFilter, visible]);
  const laneOf = laneBy === "consultorio" ? (b: Booking) => b.room?.id : (b: Booking) => b.doctor?.id ?? BLOCKS_LANE;

  const go = (changes: Record<string, string | null>) => setQuery(changes);
  const openDay = (day: string) => go({ vista: "dia", dia: day, hasta: null });

  if (dirError && !dir) {
    return (
      <PageMessage title="No se pudo cargar el calendario" action={<Button onClick={() => void reload()}>Reintentar</Button>}>
        {dirError}
      </PageMessage>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <CalendarToolbar
        view={view}
        anchor={anchor}
        listTo={listTo ?? range.to}
        label={rangeLabel(view, anchor, listTo)}
        loading={!ready && !error}
        onToday={() => go({ dia: null, hasta: null })}
        onShift={(step) => {
          const r = shiftRange(view, anchor, step, listTo);
          go({ dia: r.anchor, hasta: r.listTo });
        }}
        onJump={(day) => go({ dia: day })}
        onView={(v) => go({ vista: v, hasta: null })}
        onListRange={(from, to) => go({ dia: from, hasta: to })}
        onBlock={() => setDraft({ mode: "bloqueo", day: view === "dia" || view === "semana" ? (anchor > today ? anchor : today) : today, time: "09:00" })}
      />

      {/* En el celular los filtros son UNA fila que se desliza, para dejarle el alto a la rejilla. */}
      <div className="flex items-center gap-x-4 gap-y-2 overflow-x-auto border-b bg-subtle px-4 py-2 sm:flex-wrap sm:overflow-visible sm:px-6 [&>*]:shrink-0">
        <Button size="sm" onClick={() => setDraft({ mode: "cita", day: anchor >= today ? anchor : today, time: "09:00", doctorId: doctorFilter || undefined })}>
          <Plus className="h-4 w-4" aria-hidden />
          Nueva cita
        </Button>

        {view === "dia" && (
          <div role="group" aria-label="Columnas por" className="flex items-center gap-1 text-xs text-text-3">
            Columnas por
            {(["doctor", "consultorio"] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={laneBy === l}
                onClick={() => go({ carriles: l === "doctor" ? null : l })}
                className={`rounded-full px-2.5 py-1 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft ${laneBy === l ? "bg-brand-tint text-brand-text" : "text-text-2 hover:bg-accent"}`}
              >
                {l === "doctor" ? "Doctor" : "Consultorio"}
              </button>
            ))}
          </div>
        )}

        <label className="flex items-center gap-1.5 text-xs text-text-3">
          Doctor
          <Select aria-label="Filtrar por doctor" value={doctorFilter} onChange={(e) => go({ doctor: e.target.value || null })} className="h-8 w-auto max-w-[11rem] text-xs">
            <option value="">Todos</option>
            {dir?.doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </label>

        <Checkbox label="Mostrar canceladas" className="whitespace-nowrap text-xs" checked={showCancelled} onChange={(e) => go({ canceladas: e.target.checked ? "1" : null })} />

        <span className="sm:ml-auto">
          <SyncStatus syncedAt={syncedAt} />
        </span>
      </div>

      {/* La leyenda de colores (cada doctor tiene el suyo en todas las vistas); sirve también de filtro. En «Día» por doctor
          los encabezados de las columnas ya llevan el color y el nombre. APAGADA por ahora: ver `features.doctorLegend`. */}
      {features.doctorLegend && dir && !(view === "dia" && laneBy === "doctor") && (
        <div className="overflow-x-auto border-b px-4 py-1.5 sm:px-6">
          <DoctorLegend
            doctors={dir.doctors.filter((d) => d.active || d.id === doctorFilter || visible.some((b) => b.doctor?.id === d.id))}
            selectedId={doctorFilter || null}
            onSelect={(id) => go({ doctor: id })}
            className="sm:flex-wrap max-sm:flex-nowrap [&>li]:shrink-0"
          />
        </div>
      )}

      {error && ready && (
        <div role="status" className="flex items-center gap-2 border-b border-danger-soft bg-danger-tint px-4 py-1.5 text-xs font-semibold text-danger-text sm:px-6">
          <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Sin conexión: se muestra lo último que llegó. Reintentando…
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col p-3 sm:px-6 sm:py-4">
        {!dir ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner label="Cargando doctores y consultorios" />
          </div>
        ) : error && !ready ? (
          <PageMessage title="No se pudieron cargar las citas" action={<Button onClick={() => void refreshNow()}>Reintentar</Button>}>
            {error}
          </PageMessage>
        ) : (
          <>
            {(view === "dia" || view === "semana") && (
              <TimeGrid
                days={days}
                bookings={visible}
                timezone={TZ}
                weeklyHours={dir.clinicHours}
                today={today}
                nowMinutes={wallClock(now, TZ).minutes}
                tzLabel={tzOffsetLabel(TZ, now)}
                selectedId={live?.id ?? null}
                ready={ready}
                lanes={lanes}
                laneOf={laneOf}
                absences={gridAbsences}
                onSelect={setSelected}
                onEmptySlot={(day, time, laneId) =>
                  setDraft({
                    mode: "cita",
                    day,
                    time,
                    doctorId: laneBy === "doctor" && laneId && laneId !== BLOCKS_LANE ? laneId : doctorFilter || undefined,
                    roomId: laneBy === "consultorio" ? laneId : undefined,
                  })
                }
                onOpenDay={openDay}
              />
            )}
            {view === "mes" && (
              <MonthGrid weeks={monthWeeks(anchor)} month={anchor.slice(0, 7)} bookings={visible} timezone={TZ} today={today} selectedId={live?.id ?? null} onSelect={setSelected} onOpenDay={openDay} />
            )}
            {view === "lista" && <AgendaList range={range} bookings={visible} timezone={TZ} today={today} selectedId={live?.id ?? null} onSelect={setSelected} />}
          </>
        )}
      </div>

      {live && dir && (
        <BookingDetail
          key={live.id}
          booking={live}
          rooms={dir.rooms}
          onClose={() => setSelected(null)}
          onUpdated={(updated, message) => {
            setSelected(updated);
            toast.show(message);
            void refreshNow();
          }}
          onConflict={refresh}
        />
      )}

      {draft && dir && (
        <BookingFormDialog
          draft={draft}
          doctors={dir.doctors}
          rooms={dir.rooms}
          now={now}
          onClose={() => setDraft(null)}
          onCreated={(b) => {
            setDraft(null);
            toast.show(b.kind === "block" ? "Horario bloqueado." : "Cita agendada.");
            void refreshNow();
          }}
          onConflict={refresh}
        />
      )}
    </div>
  );
}
