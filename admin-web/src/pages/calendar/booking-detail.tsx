import { useState, type FormEvent, type ReactNode } from "react";
import { Bot, CalendarClock, Check, Copy, UserX, X } from "lucide-react";
import { Button, bookingTitle, bookingTone, hhmm, isIsoDate, longDayLabel, statusLabel, wallClock, cn } from "@clinica/calendar";
import type { Booking, BookingPatch, BookingStatus, Room } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { isConflict, messageFor } from "../../lib/errors";
import { TZ, fmtPhone, fmtSpan } from "../../lib/fmt";
import { timeOptions, utcOf } from "../../lib/range";
import { BusyButton, Checkbox, Field, FormError, Pill, Select, TextArea, TextInput, dangerButton } from "../../ui/controls";
import { Modal } from "../../ui/modal";

const TIMES = timeOptions("07:00", "20:00");

/** A qué estados puede pasar una cita agendada/realizada/no_show (la cancelada es terminal). */
const CORRECTIONS: Record<BookingStatus, { status: BookingStatus; label: string; icon: ReactNode }[]> = {
  agendada: [
    { status: "realizada", label: "Marcar como realizada", icon: <Check className="h-4 w-4" aria-hidden /> },
    { status: "no_show", label: "No asistió", icon: <UserX className="h-4 w-4" aria-hidden /> },
  ],
  realizada: [{ status: "no_show", label: "Corregir: no asistió", icon: <UserX className="h-4 w-4" aria-hidden /> }],
  no_show: [{ status: "realizada", label: "Corregir: sí asistió", icon: <Check className="h-4 w-4" aria-hidden /> }],
  cancelada: [],
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-24 shrink-0 text-text-3">{label}</dt>
      <dd className="min-w-0 flex-1 font-medium">{children}</dd>
    </div>
  );
}

/** Detalle de una cita o bloqueo: cambiar estado, mover, cancelar y editar notas. */
export function BookingDetail({
  booking: b,
  rooms,
  onClose,
  onUpdated,
  onConflict,
}: {
  booking: Booking;
  rooms: Room[];
  onClose: () => void;
  /** La cita ya cambió en el servidor: avisa y refresca la agenda. */
  onUpdated: (updated: Booking, message: string) => void;
  onConflict: () => void;
}) {
  const api = useApi();
  const isBlock = b.kind === "block";
  const wall = wallClock(b.scheduledAtUtc, TZ);

  const [mode, setMode] = useState<"view" | "move" | "cancel">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(b.notes ?? "");
  const [moveDay, setMoveDay] = useState(wall.day);
  const [moveTime, setMoveTime] = useState(hhmm(wall.minutes));
  const [moveRoom, setMoveRoom] = useState("");
  const [shortNotice, setShortNotice] = useState(false);
  const [copied, setCopied] = useState(false);

  async function patch(body: BookingPatch, message: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.appointments.update(b.id, body);
      setMode("view");
      onUpdated(updated, message);
    } catch (e) {
      if (isConflict(e)) onConflict();
      setError(mode === "move" && isConflict(e) ? `${messageFor(e)} La cita sigue en su horario original.` : messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  const submitMove = (e: FormEvent) => {
    e.preventDefault();
    const startUtc = isIsoDate(moveDay) ? utcOf(moveDay, moveTime) : null;
    if (!startUtc) return setError("Elige una fecha válida.");
    if (startUtc === b.scheduledAtUtc && !moveRoom) return setError("Elige otro horario u otro consultorio.");
    void patch(
      {
        ...(startUtc !== b.scheduledAtUtc ? { scheduledAtUtc: startUtc } : {}),
        ...(moveRoom ? { roomId: moveRoom } : {}),
        ...(shortNotice ? { allowShortNotice: true } : {}),
      },
      isBlock ? "Bloqueo movido." : "Cita movida."
    );
  };

  const copyPhone = async () => {
    try {
      await navigator.clipboard.writeText(b.patient?.phone ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* sin portapapeles: el número sigue visible para copiarlo a mano */
    }
  };

  const active = b.status === "agendada";
  const notesChanged = notes.trim() !== (b.notes ?? "");

  return (
    <Modal
      variant="side"
      initialFocus="panel"
      title={bookingTitle(b)}
      description={isBlock ? "Bloqueo de consultorio" : "Cita"}
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        <dl className="divide-y">
          <Row label="Estado">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className={cn("h-2.5 w-2.5 rounded-full", bookingTone(b).dot)} />
              {statusLabel(b)}
            </span>
          </Row>
          <Row label="Cuándo">
            <span className="first-letter:uppercase">{longDayLabel(wall.day)}</span>
            <span className="block font-mono text-[13px] text-text-2">
              {fmtSpan(b.scheduledAtUtc, b.durationMinutes)} · {b.durationMinutes} min
            </span>
          </Row>
          {!isBlock && b.doctor && (
            <Row label="Doctor">
              {b.doctor.name}
              <span className="block text-xs font-normal text-text-3">{b.doctor.specialty}</span>
            </Row>
          )}
          {b.room && <Row label="Consultorio">{b.room.name}</Row>}
          {!isBlock && (
            <Row label="Teléfono">
              {b.patient?.phone ? (
                <span className="inline-flex items-center gap-2">
                  {fmtPhone(b.patient.phone)}
                  <button
                    type="button"
                    onClick={() => void copyPhone()}
                    aria-label="Copiar teléfono"
                    className="flex h-6 w-6 items-center justify-center rounded text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                  </button>
                </span>
              ) : (
                <span className="font-normal text-text-3">Sin teléfono</span>
              )}
            </Row>
          )}
          <Row label="Origen">
            {b.source === "ai" ? (
              <Pill tone="brand">
                <Bot className="h-3 w-3" aria-hidden /> Agendó el bot de WhatsApp
              </Pill>
            ) : (
              <Pill>Personal de la clínica</Pill>
            )}
          </Row>
        </dl>

        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void patch({ notes: notes.trim() || null }, "Notas guardadas.");
          }}
        >
          <Field label={isBlock ? "Motivo" : "Notas"} hint={isBlock ? undefined : "Texto administrativo. No anotes síntomas."}>
            <TextArea value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {notesChanged && (
            <div>
              <BusyButton type="submit" size="sm" variant="outline" busy={busy}>
                Guardar notas
              </BusyButton>
            </div>
          )}
        </form>

        {mode === "view" && active && (
          <section aria-label="Acciones" className="flex flex-col gap-2">
            {!isBlock &&
              CORRECTIONS.agendada.map((c) => (
                <BusyButton key={c.status} busy={busy} variant="outline" className="justify-start" onClick={() => void patch({ status: c.status }, c.status === "realizada" ? "Cita marcada como realizada." : "Cita marcada como «No asistió».")}>
                  {c.icon}
                  {c.label}
                </BusyButton>
              ))}
            <Button variant="outline" className="justify-start" onClick={() => setMode("move")}>
              <CalendarClock className="h-4 w-4" aria-hidden />
              {isBlock ? "Mover el bloqueo" : "Mover a otro horario"}
            </Button>
            <Button variant="outline" className="justify-start text-danger-text" onClick={() => setMode("cancel")}>
              <X className="h-4 w-4" aria-hidden />
              {isBlock ? "Quitar el bloqueo" : "Cancelar la cita"}
            </Button>
          </section>
        )}

        {mode === "view" && !isBlock && (b.status === "realizada" || b.status === "no_show") && (
          <section aria-label="Corregir estado" className="flex flex-col gap-2">
            {CORRECTIONS[b.status].map((c) => (
              <BusyButton key={c.status} busy={busy} variant="outline" className="justify-start" onClick={() => void patch({ status: c.status }, "Estado corregido.")}>
                {c.icon}
                {c.label}
              </BusyButton>
            ))}
          </section>
        )}

        {mode === "move" && (
          <form onSubmit={submitMove} aria-label="Mover" className="flex flex-col gap-3 rounded-lg border bg-subtle p-3">
            <p className="text-sm font-semibold">{isBlock ? "Mover el bloqueo" : "Mover a otro horario"}</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nueva fecha" className="col-span-2 sm:col-span-1">
                <TextInput type="date" value={moveDay} onChange={(e) => setMoveDay(e.target.value)} />
              </Field>
              <Field label="Nueva hora" className="col-span-1">
                <Select value={moveTime} onChange={(e) => setMoveTime(e.target.value)}>
                  {TIMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Consultorio">
              <Select value={moveRoom} onChange={(e) => setMoveRoom(e.target.value)}>
                <option value="">Conservar el actual</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            {!isBlock && (
              <Checkbox label="Cita de mostrador" hint="Omite la antelación mínima de 60 minutos." checked={shortNotice} onChange={(e) => setShortNotice(e.target.checked)} />
            )}
            <FormError>{error}</FormError>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setMode("view"); setError(null); }}>
                Volver
              </Button>
              <BusyButton type="submit" busy={busy}>
                Mover
              </BusyButton>
            </div>
          </form>
        )}

        {mode === "cancel" && (
          <section aria-label="Confirmar cancelación" className="flex flex-col gap-3 rounded-lg border border-danger-soft bg-danger-tint p-3">
            <p className="text-sm font-semibold text-danger-text">
              {isBlock ? "¿Quitar este bloqueo?" : `¿Cancelar la cita de ${bookingTitle(b)}?`}
            </p>
            <p className="text-xs text-danger-text">
              {isBlock ? "El consultorio vuelve a quedar libre." : "El horario queda libre otra vez. La cita se conserva en el historial como cancelada; no se puede reactivar."}
            </p>
            <FormError>{error}</FormError>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setMode("view"); setError(null); }}>
                No, volver
              </Button>
              <BusyButton busy={busy} className={dangerButton} onClick={() => void patch({ status: "cancelada" }, isBlock ? "Bloqueo quitado." : "Cita cancelada.")}>
                {isBlock ? "Sí, quitar" : "Sí, cancelar la cita"}
              </BusyButton>
            </div>
          </section>
        )}

        {mode === "view" && <FormError>{error}</FormError>}

        {b.status === "cancelada" && (
          <p className="rounded-md border border-dashed bg-subtle px-3 py-2 text-sm text-text-3">{isBlock ? "Este bloqueo ya se quitó." : "Esta cita está cancelada y ya no ocupa el horario."}</p>
        )}
      </div>
    </Modal>
  );
}
