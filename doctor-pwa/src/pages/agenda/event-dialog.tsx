import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { Button, hhmmLabel, isIsoDate } from "@clinica/calendar";
import { isApiError, type Booking, type PersonalEvent } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { useCanWrite } from "../../lib/can-write";
import { DURATIONS, START_TIMES, durationLabel, formOf, instantsOf, overlaps, type EventForm } from "../../lib/events";
import { messageFor } from "../../lib/errors";
import { fmtSpan } from "../../lib/fmt";
import { useToast } from "../../toast";
import { BusyButton, Checkbox, Field, FormError, Notice, Select, TextArea, TextInput, dangerButton } from "../../ui/controls";
import { Modal } from "../../ui/modal";

const FORM_ID = "personal-event-form";

/** Crear (`event` ausente, con el día y la hora que se tocó) o editar/borrar un evento personal. */
export type EventTarget = { mode: "new"; day: string; time: string } | { mode: "edit"; event: PersonalEvent };

/**
 * Un evento personal: título, día, hora de inicio y duración (o todo el día) y notas. Es PRIVADO del doctor: el personal solo
 * ve «No disponible». NO es una cita de la clínica (lo dice el aviso del formulario): en ese horario el doctor no recibe citas,
 * pero el consultorio queda libre para los demás doctores. Mientras no haya conexión no se puede guardar ni borrar.
 *
 * Si el horario cae sobre una cita ya agendada, el servidor responde 409 `evento_con_cita`: se dice cuál (solo el horario)
 * para que el doctor lo resuelva con recepción.
 */
export function EventDialog({
  target,
  bookings,
  onClose,
  onChanged,
}: {
  target: EventTarget;
  /** Las citas ya cargadas de esa semana (solo para decir con cuál choca un evento). */
  bookings: Booking[];
  onClose: () => void;
  /** Se guardó o borró algo: que la agenda traiga lo vigente. */
  onChanged: () => Promise<unknown> | void;
}) {
  const api = useApi();
  const toast = useToast();
  const { canWrite, reason, reportFailure } = useCanWrite();
  const editing = target.mode === "edit" ? target.event : null;

  const [title, setTitle] = useState(editing?.title ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [form, setForm] = useState<EventForm>(() =>
    editing ? formOf(editing) : { day: target.mode === "new" ? target.day : "", allDay: false, time: target.mode === "new" ? target.time : "09:00", duration: 60 }
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (patch: Partial<EventForm>) => setForm((f) => ({ ...f, ...patch }));
  // Si el evento (o el toque en la rejilla) trae una hora o duración fuera de las listas, la suya se agrega para no perderla.
  const times = START_TIMES.includes(form.time) ? START_TIMES : [...START_TIMES, form.time].sort();
  const durations = DURATIONS.includes(form.duration) ? DURATIONS : [...DURATIONS, form.duration].sort((a, b) => a - b);

  /** «Ya tienes una cita en ese horario (11:00 AM – 11:30 AM)…», con lo que ya está cargado. */
  const clashMessage = (startUtc: string, endUtc: string): string => {
    const clashes = bookings
      .filter((b) => b.kind === "session" && b.status === "agendada" && overlaps(startUtc, endUtc, b.scheduledAtUtc, new Date(Date.parse(b.scheduledAtUtc) + b.durationMinutes * 60_000).toISOString()))
      .sort((a, b) => a.scheduledAtUtc.localeCompare(b.scheduledAtUtc));
    const when = clashes.length ? ` (${clashes.slice(0, 3).map((b) => fmtSpan(b.scheduledAtUtc, b.durationMinutes)).join(", ")}${clashes.length > 3 ? "…" : ""})` : "";
    return `Ya tienes una cita agendada en ese horario${when}. Pide a recepción que la mueva y vuelve a intentarlo.`;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !canWrite) return;
    const text = title.trim();
    if (!text) return setError("Escribe un título para el evento.");
    if (!isIsoDate(form.day)) return setError("Elige el día.");
    const at = instantsOf(form);
    if (!at) return setError("Día u hora no válidos.");

    setBusy(true);
    setError(null);
    try {
      if (editing) {
        // un parche: solo lo que cambió (el servidor vuelve a comparar con las citas únicamente si cambia el horario)
        const patch: { title?: string; notes?: string | null; startUtc?: string; endUtc?: string } = {};
        if (text !== editing.title) patch.title = text;
        if ((notes.trim() || null) !== editing.notes) patch.notes = notes.trim() || null;
        if (at.startUtc !== editing.startUtc || at.endUtc !== editing.endUtc) Object.assign(patch, at);
        if (Object.keys(patch).length > 0) await api.doctorSelf.personalEvents.update(editing.id, patch);
        toast.show("Evento guardado.");
      } else {
        await api.doctorSelf.personalEvents.create({ title: text, ...(notes.trim() ? { notes: notes.trim() } : {}), ...at });
        toast.show("Evento guardado: no recibirás citas en ese horario.");
      }
      await onChanged();
      onClose();
    } catch (err) {
      reportFailure(err);
      setError(isApiError(err) && err.code === "evento_con_cita" ? clashMessage(at.startUtc, at.endUtc) : messageFor(err));
      if (isApiError(err) && err.status === 404) void onChanged(); // ya no existe: que la agenda lo quite
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || busy || !canWrite) return;
    setBusy(true);
    setError(null);
    try {
      await api.doctorSelf.personalEvents.remove(editing.id);
      toast.show("Evento eliminado: vuelves a ofrecerte en ese horario.");
      await onChanged();
      onClose();
    } catch (err) {
      reportFailure(err);
      setError(messageFor(err));
      if (isApiError(err) && err.status === 404) void onChanged();
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? "Evento personal" : "Nuevo evento personal"}
      onClose={onClose}
      footer={
        confirmDelete ? (
          <>
            <span className="mr-auto text-sm font-medium">¿Eliminar este evento?</span>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              No
            </Button>
            <BusyButton className={dangerButton} busy={busy} disabled={!canWrite} onClick={() => void remove()}>
              Sí, eliminar
            </BusyButton>
          </>
        ) : (
          <>
            {editing && (
              <Button variant="outline" className="mr-auto text-danger-text" disabled={busy || !canWrite} title={reason ?? undefined} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" aria-hidden />
                Eliminar
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <BusyButton type="submit" form={FORM_ID} busy={busy} disabled={!canWrite}>
              Guardar
            </BusyButton>
          </>
        )
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate aria-label={editing ? "Editar evento personal" : "Nuevo evento personal"} className="flex flex-col gap-3">
        {!editing && (
          <Notice tone="info" className="text-[13px]">
            Es un evento personal, no una cita de la clínica: en ese horario no recibirás citas, pero el consultorio queda libre para los demás doctores. Para agendar a un paciente, pide al personal de la clínica que lo registre.
          </Notice>
        )}
        <Field label="Título">
          <TextInput value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Dentista, junta, comida…" />
        </Field>
        <Field label="Día">
          <TextInput type="date" value={form.day} onChange={(e) => set({ day: e.target.value })} />
        </Field>
        <Checkbox label="Todo el día" checked={form.allDay} onChange={(e) => set({ allDay: e.target.checked })} />
        {!form.allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hora de inicio">
              <Select value={form.time} onChange={(e) => set({ time: e.target.value })}>
                {times.map((t) => (
                  <option key={t} value={t}>
                    {hhmmLabel(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Duración">
              <Select value={form.duration} onChange={(e) => set({ duration: Number(e.target.value) })}>
                {durations.map((d) => (
                  <option key={d} value={d}>
                    {durationLabel(d)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Field label="Notas (opcional)">
          <TextArea value={notes} maxLength={1000} rows={3} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <FormError>{error}</FormError>
        {reason && <Notice tone="warn">{reason}</Notice>}
      </form>
    </Modal>
  );
}
