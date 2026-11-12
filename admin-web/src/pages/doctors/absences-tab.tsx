import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarOff, Trash2 } from "lucide-react";
import { addDaysISO, hhmmLabel, isIsoDate, todayInTz, wallClock } from "@clinica/calendar";
import { isAbortError, type Absence, type Booking, type Doctor } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { messageFor } from "../../lib/errors";
import { TZ, fmtDateTime, fmtDay } from "../../lib/fmt";
import { timeOptions, utcOf } from "../../lib/range";
import { useToast } from "../../toast";
import { BusyButton, Checkbox, Field, FormError, Select, Spinner, TextInput } from "../../ui/controls";
import { AffectedList } from "./affected-list";

const TIMES = timeOptions("06:00", "21:00");

/** Ausencias de un doctor: surten efecto de inmediato (el bot deja de ofrecerlo) y avisan qué citas quedan afectadas. */
export function AbsencesTab({ doctor, now }: { doctor: Doctor; now: Date }) {
  const api = useApi();
  const toast = useToast();
  const today = todayInTz(now, TZ);

  const [items, setItems] = useState<Absence[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [affected, setAffected] = useState<Booking[]>([]);

  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [allDay, setAllDay] = useState(true);
  const [fromTime, setFromTime] = useState("09:00");
  const [toTime, setToTime] = useState("18:00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setItems(await api.doctors.absences.list(doctor.id, undefined, { signal }));
        setLoadError(null);
      } catch (e) {
        if (!isAbortError(e)) setLoadError(messageFor(e));
      }
    },
    [api, doctor.id]
  );
  useEffect(() => {
    const ctrl = new AbortController();
    setItems(null);
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!isIsoDate(from) || !isIsoDate(to)) return setError("Elige las fechas.");
    if (to < from) return setError("La fecha final no puede ser antes de la inicial.");
    const startUtc = allDay ? utcOf(from, "00:00") : utcOf(from, fromTime);
    const endUtc = allDay ? utcOf(addDaysISO(to, 1), "00:00") : utcOf(to, toTime);
    if (!startUtc || !endUtc) return setError("Fecha u hora no válida.");
    if (Date.parse(endUtc) <= Date.parse(startUtc)) return setError("La ausencia debe terminar después de empezar.");

    setBusy(true);
    setError(null);
    try {
      const res = await api.doctors.absences.create(doctor.id, { startUtc, endUtc, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setAffected(res.affectedAppointments);
      setReason("");
      toast.show(`Ausencia registrada: ${doctor.name} deja de ofrecerse en esas fechas.`);
      await load();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Absence) => {
    try {
      await api.doctors.absences.remove(doctor.id, a.id);
      toast.show("Ausencia quitada: el doctor vuelve a ofrecerse.");
      await load();
    } catch (err) {
      toast.show(messageFor(err), "error");
    }
  };

  const shown = (items ?? []).filter((a) => showPast || Date.parse(a.endUtc) >= now.getTime());
  const describe = (a: Absence) => {
    const s = wallClock(a.startUtc, TZ);
    const en = wallClock(a.endUtc, TZ);
    const wholeDays = s.minutes === 0 && en.minutes === 0;
    if (wholeDays) {
      const lastDay = addDaysISO(en.day, -1);
      return lastDay === s.day ? `${fmtDay(s.day)} (todo el día)` : `${fmtDay(s.day)} al ${fmtDay(lastDay)} (todo el día)`;
    }
    return `${fmtDateTime(a.startUtc)} → ${fmtDateTime(a.endUtc)}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <AffectedList items={affected} onDismiss={() => setAffected([])} />

      <section aria-label="Ausencias registradas" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold">Ausencias</h3>
          <Checkbox label="Ver pasadas" className="text-xs" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
        </div>
        {items === null && !loadError && <Spinner label="Cargando ausencias" />}
        {loadError && <FormError>{loadError}</FormError>}
        {items && shown.length === 0 && <p className="rounded-md border border-dashed px-3 py-3 text-sm text-text-3">No hay ausencias registradas{showPast ? "" : " próximas"}.</p>}
        <ul className="flex flex-col gap-1.5">
          {shown.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2">
              <CalendarOff className="h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{describe(a)}</span>
                {a.reason && <span className="block text-xs text-text-3">{a.reason}</span>}
              </span>
              <button
                type="button"
                onClick={() => void remove(a)}
                aria-label={`Quitar la ausencia del ${fmtDay(wallClock(a.startUtc, TZ).day)}`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-3 hover:bg-accent hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={submit} aria-label="Registrar ausencia" noValidate className="flex flex-col gap-3 rounded-lg border bg-subtle p-3">
        <h3 className="text-sm font-bold">Registrar una ausencia</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Desde">
            <TextInput type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} />
          </Field>
          <Field label="Hasta (inclusive)">
            <TextInput type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <Checkbox label="Todo el día" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hora de inicio">
              <Select value={fromTime} onChange={(e) => setFromTime(e.target.value)}>
                {TIMES.map((t) => <option key={t} value={t}>{hhmmLabel(t)}</option>)}
              </Select>
            </Field>
            <Field label="Hora final">
              <Select value={toTime} onChange={(e) => setToTime(e.target.value)}>
                {TIMES.map((t) => <option key={t} value={t}>{hhmmLabel(t)}</option>)}
              </Select>
            </Field>
          </div>
        )}
        <Field label="Motivo (opcional)">
          <TextInput value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Congreso, vacaciones…" />
        </Field>
        <p className="text-xs text-text-3">Surte efecto de inmediato: el bot deja de ofrecer a {doctor.name} en esas fechas. Las citas ya agendadas no se cancelan; te avisamos cuáles son.</p>
        <FormError>{error}</FormError>
        <div>
          <BusyButton type="submit" busy={busy}>
            Registrar ausencia
          </BusyButton>
        </div>
      </form>
    </div>
  );
}
