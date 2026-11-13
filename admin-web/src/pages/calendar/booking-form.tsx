import { useMemo, useState, type FormEvent } from "react";
import { Button, hhmmLabel, isIsoDate, workingBands } from "@clinica/calendar";
import { isApiError, type Booking, type Doctor, type Room } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { isConflict, messageFor } from "../../lib/errors";
import { durationLabel, fmtDay } from "../../lib/fmt";
import { summarizeHours } from "../../lib/hours";
import { timeOptions, utcOf } from "../../lib/range";
import { BusyButton, Checkbox, Field, FormError, Notice, Select, TextArea, TextInput } from "../../ui/controls";
import { DateField } from "../../ui/date-field";
import { Modal } from "../../ui/modal";
import { FreeSlotPicker } from "./free-slot-picker";

export type SlotDraft = {
  mode: "cita" | "bloqueo";
  day: string;
  time: string;
  doctorId?: string;
  roomId?: string;
};

const SESSION_DURATIONS = [30, 60, 90, 120];
const BLOCK_DURATIONS = [30, 60, 90, 120, 180, 240, 360, 480];
const TIMES = timeOptions("07:00", "20:00");

/** Alta de una cita o de un bloqueo de consultorio ("Nueva cita" y el clic en un hueco vacío). */
export function BookingFormDialog({
  draft,
  doctors,
  rooms,
  now,
  onClose,
  onCreated,
  onConflict,
}: {
  draft: SlotDraft;
  doctors: Doctor[];
  rooms: Room[];
  now: Date;
  onClose: () => void;
  onCreated: (b: Booking) => void;
  /** El servidor dijo 409: la agenda cambió; que la pantalla se actualice. */
  onConflict: () => void;
}) {
  const api = useApi();
  const block = draft.mode === "bloqueo";
  const activeDoctors = doctors.filter((d) => d.active);

  const [patientName, setPatientName] = useState("");
  const [phone, setPhone] = useState("");
  const [doctorId, setDoctorId] = useState(draft.doctorId ?? "");
  const [roomId, setRoomId] = useState(draft.roomId ?? (block ? (rooms[0]?.id ?? "") : ""));
  const [day, setDay] = useState(draft.day);
  const [time, setTime] = useState(TIMES.includes(draft.time) ? draft.time : "09:00");
  const [duration, setDuration] = useState(30);
  const [notes, setNotes] = useState("");
  const [shortNotice, setShortNotice] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; phone?: string; doctor?: string; day?: string }>({});

  const doctor = activeDoctors.find((d) => d.id === doctorId);
  const startUtc = isIsoDate(day) ? utcOf(day, time) : null;

  // El doctor elegido no atiende en ese horario (todo el tramo de la cita tiene que caer dentro de su horario, hueco por hueco de
  // 30 min, como lo comprueba el servidor). Si pasa se avisa Y NO se deja agendar: el servidor lo rechazaría siempre
  // (ni «cita de mostrador» lo permite: esa solo omite la antelación de 60 min).
  const doctorOutOfHours = useMemo(() => {
    if (block || !doctor || !isIsoDate(day) || !startUtc) return false;
    const [h, m] = time.split(":").map(Number) as [number, number];
    const t = h * 60 + m;
    const bands = workingBands(doctor.weeklyHours, day);
    for (let slot = t; slot < t + duration; slot += 30) {
      if (!bands.some((b) => slot >= b.startMin && slot + 30 <= b.endMin)) return true;
    }
    return false;
  }, [block, doctor, day, startUtc, time, duration]);

  // Avisos (el servidor decide); solo el del doctor fuera de su horario además bloquea el botón de agendar.
  const warnings = useMemo(() => {
    const out: string[] = [];
    if (!startUtc) return out;
    const start = Date.parse(startUtc);
    if (!block) {
      if (start < now.getTime()) out.push("Ese horario ya pasó.");
      else if (start < now.getTime() + 60 * 60_000 && !shortNotice) out.push("Faltan menos de 60 minutos: marca «cita de mostrador» si el paciente ya está en la clínica.");
    }
    if (doctorOutOfHours && doctor) out.push(`${doctor.name} no atiende ${fmtDay(day)} a esa hora (${summarizeHours(doctor.weeklyHours)}).`);
    return out;
  }, [startUtc, block, now, shortNotice, doctor, doctorOutOfHours, day]);

  // El icono del campo de fecha abre el calendario con los horarios libres de ESTE doctor (o consultorio, en un bloqueo) y esta duración.
  const openCalendar = () => {
    if (!block && !doctorId) {
      setFieldErrors((f) => ({ ...f, doctor: "Elige primero un doctor para ver sus horarios libres." }));
      return;
    }
    setPicking(true);
  };
  const roomName = rooms.find((r) => r.id === roomId)?.name;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || doctorOutOfHours) return;                  // (Enter en un campo también envía el formulario: se frena aquí)
    const errors: typeof fieldErrors = {};
    const name = patientName.trim().replace(/\s+/g, " ");
    const digits = phone.replace(/\D/g, "");
    if (!block) {
      if (name.split(" ").filter(Boolean).length < 2) errors.name = "Escribe el nombre y el apellido del paciente.";
      if (digits && (digits.length < 8 || digits.length > 15)) errors.phone = "El teléfono debe tener entre 8 y 15 dígitos, con lada.";
      if (!doctorId) errors.doctor = "Elige un doctor.";
    }
    if (!isIsoDate(day) || !startUtc) errors.day = "Elige una fecha válida.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || !startUtc) return;

    setBusy(true);
    setError(null);
    try {
      const created = await api.appointments.create(
        block
          ? { kind: "block", roomId, scheduledAtUtc: startUtc, durationMinutes: duration, ...(notes.trim() ? { notes: notes.trim() } : {}) }
          : {
              kind: "session",
              patientName: name,
              ...(digits ? { phone: digits } : {}),
              doctorId,
              ...(roomId ? { roomId } : {}),
              scheduledAtUtc: startUtc,
              durationMinutes: duration,
              ...(notes.trim() ? { notes: notes.trim() } : {}),
              ...(shortNotice ? { allowShortNotice: true } : {}),
            }
      );
      onCreated(created);
    } catch (err) {
      if (isConflict(err)) onConflict();
      setError(isApiError(err) && err.status === 409 ? `${messageFor(err)} Elige otro horario.` : messageFor(err));
      setBusy(false);
    }
  };

  const formId = "booking-form";
  return (
    <Modal
      title={block ? "Bloquear horario" : "Nueva cita"}
      description={block ? "Un consultorio fuera de servicio (mantenimiento, junta…)." : "Cita agendada por el personal."}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <BusyButton
            type="submit"
            form={formId}
            busy={busy}
            disabled={doctorOutOfHours}
            title={doctorOutOfHours ? "El doctor no atiende en ese horario: elige otra fecha u hora, u otro doctor." : undefined}
          >
            {block ? "Bloquear" : "Agendar cita"}
          </BusyButton>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-3.5">
        {!block && (
          <>
            <Field label="Paciente" error={fieldErrors.name} hint="Nombre y apellido.">
              <TextInput value={patientName} onChange={(e) => setPatientName(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Teléfono (opcional)" error={fieldErrors.phone} hint="Solo dígitos, con lada de país (52…). Así el paciente ve su cita por WhatsApp.">
              <TextInput value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" />
            </Field>
            <Field label="Doctor" error={fieldErrors.doctor}>
              <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                <option value="">Elige un doctor…</option>
                {activeDoctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.specialty}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}

        <Field label="Consultorio" hint={block ? undefined : "Si no eliges, se asigna el primero libre."}>
          <Select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {!block && <option value="">Automático</option>}
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <DateField label="Fecha" error={fieldErrors.day} className="col-span-2 sm:col-span-1" value={day} onChange={setDay} onOpenCalendar={openCalendar} />
          <Field label="Hora" className="col-span-1">
            <Select value={time} onChange={(e) => setTime(e.target.value)}>
              {TIMES.map((t) => (
                <option key={t} value={t}>
                  {hhmmLabel(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Duración" className="col-span-1 sm:col-span-2">
            <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {(block ? BLOCK_DURATIONS : SESSION_DURATIONS).map((m) => (
                <option key={m} value={m}>
                  {durationLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label={block ? "Motivo" : "Notas (opcional)"} hint={block ? undefined : "Texto administrativo. No anotes síntomas ni datos médicos."}>
          <TextArea value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {!block && (
          <Checkbox
            label="Cita de mostrador"
            hint="El paciente ya está aquí: omite la antelación mínima de 60 minutos."
            checked={shortNotice}
            onChange={(e) => setShortNotice(e.target.checked)}
          />
        )}

        {warnings.map((w) => (
          <Notice key={w} tone="warn">
            {w}
          </Notice>
        ))}
        <FormError>{error}</FormError>
      </form>

      {picking && (
        <FreeSlotPicker
          description={`${(block ? [roomName] : [doctor?.name, roomName ?? "Cualquier consultorio libre"]).filter(Boolean).join(" · ")} · dura ${durationLabel(duration)}`}
          queryKey={`${block ? "b" : "s"}|${doctorId}|${roomId}|${duration}|${shortNotice}`}
          load={({ from, to }, signal) =>
            api.appointments.availability(
              { from, to, kind: block ? "block" : "session", doctorId: block ? undefined : doctorId, roomId: roomId || undefined, durationMinutes: duration, allowShortNotice: shortNotice },
              { signal }
            )
          }
          value={{ day, time }}
          onPick={(d, t) => {
            setDay(d);
            setTime(t);
            setFieldErrors((f) => ({ ...f, day: undefined }));
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </Modal>
  );
}
