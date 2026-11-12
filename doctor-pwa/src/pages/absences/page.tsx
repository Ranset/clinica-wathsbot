import { useState, type FormEvent } from "react";
import { CalendarOff, Trash2 } from "lucide-react";
import { Button, addDaysISO, hhmmLabel, isIsoDate, todayInTz, wallClock } from "@clinica/calendar";
import type { Absence } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { SyncStatus } from "../../layout/status";
import { affectedMessage, describeAbsence } from "../../lib/absence";
import { useCanWrite } from "../../lib/can-write";
import { messageFor } from "../../lib/errors";
import { TZ, fmtDay } from "../../lib/fmt";
import { timeOptions, utcOf } from "../../lib/range";
import { useNow } from "../../lib/use-now";
import { useToast } from "../../toast";
import { BusyButton, Checkbox, Field, FormError, Notice, Select, Spinner, TextInput, dangerButton } from "../../ui/controls";
import { Modal } from "../../ui/modal";
import { useAbsences } from "./use-absences";

const TIMES = timeOptions("06:00", "21:00");

/**
 * Mis ausencias: surten efecto de inmediato (el bot deja de ofrecerme en esas fechas) y avisan al personal.
 * Las citas que ya estaban agendadas NO se cancelan: se dice cuántas son (`affectedCount`) para que el
 * personal contacte a los pacientes. Sin conexión solo se pueden leer.
 */
export function AbsencesPage() {
  const api = useApi();
  const toast = useToast();
  const { canWrite, reason, reportFailure } = useCanWrite();
  const now = useNow(60_000);
  const today = todayInTz(now, TZ);
  const abs = useAbsences();

  const [showPast, setShowPast] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Absence | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [allDay, setAllDay] = useState(true);
  const [fromTime, setFromTime] = useState("09:00");
  const [toTime, setToTime] = useState("18:00");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !canWrite) return;
    if (!isIsoDate(from) || !isIsoDate(to)) return setError("Elige las fechas.");
    if (to < from) return setError("La fecha final no puede ser antes de la inicial.");
    const startUtc = allDay ? utcOf(from, "00:00") : utcOf(from, fromTime);
    const endUtc = allDay ? utcOf(addDaysISO(to, 1), "00:00") : utcOf(to, toTime);
    if (!startUtc || !endUtc) return setError("Fecha u hora no válida.");
    if (Date.parse(endUtc) <= Date.parse(startUtc)) return setError("La ausencia debe terminar después de empezar.");

    setBusy(true);
    setError(null);
    try {
      const res = await api.doctorSelf.absences.create({ startUtc, endUtc, ...(why.trim() ? { reason: why.trim() } : {}) });
      setResult(affectedMessage(res.affectedCount));
      setWhy("");
      toast.show("Ausencia registrada: dejas de ofrecerte en esas fechas.");
      // sale en la lista de inmediato; la copia del servidor llega enseguida
      abs.apply((list) => [...(list ?? []), res.absence].sort((a, b) => a.startUtc.localeCompare(b.startUtc)));
      await abs.reload();
    } catch (err) {
      reportFailure(err);
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing || removeBusy || !canWrite) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.doctorSelf.absences.remove(removing.id);
      setRemoving(null);
      setResult(null);
      toast.show("Ausencia quitada: vuelves a ofrecerte en esas fechas.");
      abs.apply((list) => (list ?? []).filter((a) => a.id !== removing.id));
      await abs.reload();
    } catch (err) {
      reportFailure(err);
      setRemoveError(messageFor(err));
    } finally {
      setRemoveBusy(false);
    }
  };

  const items = abs.data;
  // El orden lo decide la app (no se depende de cómo lo devuelva el servidor): la más próxima primero.
  const shown = (items ?? []).filter((a) => showPast || Date.parse(a.endUtc) >= now.getTime()).sort((a, b) => a.startUtc.localeCompare(b.startUtc));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-4 sm:py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-tight">Mis ausencias</h1>
        <SyncStatus syncedAt={abs.syncedAt} stale={!abs.confirmed || abs.error !== null} />
      </div>

      {result && (
        <Notice tone="ok" className="flex items-start justify-between gap-2" >
          <span role="status">{result}</span>
          <button type="button" onClick={() => setResult(null)} className="shrink-0 rounded-full px-2 text-xs font-semibold hover:bg-success-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft">
            Cerrar
          </button>
        </Notice>
      )}

      <section aria-label="Ausencias registradas" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">Registradas</h2>
          <Checkbox label="Ver pasadas" className="text-xs" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
        </div>
        {items === null && !abs.error && <Spinner label="Cargando ausencias" />}
        {abs.error && <FormError>{items ? `${abs.error} Se muestra la última copia guardada.` : abs.error}</FormError>}
        {items && shown.length === 0 && <p className="rounded-md border border-dashed px-3 py-3 text-sm text-text-3">No tienes ausencias registradas{showPast ? "" : " próximas"}.</p>}
        <ul className="flex flex-col gap-1.5">
          {shown.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5">
              <CalendarOff className="h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{describeAbsence(a)}</span>
                {a.reason && <span className="block text-xs text-text-3">{a.reason}</span>}
              </span>
              <button
                type="button"
                disabled={!canWrite}
                title={reason ?? undefined}
                onClick={() => {
                  setRemoveError(null);
                  setRemoving(a);
                }}
                aria-label={`Quitar la ausencia del ${fmtDay(wallClock(a.startUtc, TZ).day)}`}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-3 hover:bg-accent hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={submit} aria-label="Registrar ausencia" noValidate className="flex flex-col gap-3 rounded-lg border bg-background p-4">
        <h2 className="text-sm font-bold">Registrar una ausencia</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Desde">
            <TextInput
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                if (e.target.value > to) setTo(e.target.value);
              }}
            />
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
                {TIMES.map((t) => (
                  <option key={t} value={t}>{hhmmLabel(t)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Hora final">
              <Select value={toTime} onChange={(e) => setToTime(e.target.value)}>
                {TIMES.map((t) => (
                  <option key={t} value={t}>{hhmmLabel(t)}</option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Field label="Motivo (opcional)">
          <TextInput value={why} maxLength={200} onChange={(e) => setWhy(e.target.value)} placeholder="Congreso, vacaciones…" />
        </Field>
        <p className="text-xs text-text-3">Surte efecto de inmediato: el bot deja de ofrecerte en esas fechas y el personal recibe un aviso. Las citas que ya tengas agendadas no se cancelan: te decimos cuántas son.</p>
        <FormError>{error}</FormError>
        {reason && <Notice tone="warn">{reason}</Notice>}
        <div>
          <BusyButton type="submit" busy={busy} disabled={!canWrite}>
            Registrar ausencia
          </BusyButton>
        </div>
      </form>

      {removing && (
        <Modal
          title="¿Quitar esta ausencia?"
          onClose={() => setRemoving(null)}
          initialFocus="panel"
          footer={
            <>
              <Button variant="outline" onClick={() => setRemoving(null)}>
                Cancelar
              </Button>
              <BusyButton className={dangerButton} busy={removeBusy} disabled={!canWrite} onClick={() => void confirmRemove()}>
                Quitar ausencia
              </BusyButton>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm">
            <p>
              <span className="font-semibold">{describeAbsence(removing)}</span>
              {removing.reason ? ` — ${removing.reason}` : ""}
            </p>
            <p className="text-text-2">Al quitarla, el bot vuelve a ofrecer tu agenda en esas fechas.</p>
            <FormError>{removeError}</FormError>
            {reason && <Notice tone="warn">{reason}</Notice>}
          </div>
        </Modal>
      )}
    </div>
  );
}
