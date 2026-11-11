import { Bot, Building2, Clock, StickyNote, UserRound } from "lucide-react";
import { bookingTitle, statusLabel, wallClock } from "@clinica/calendar";
import type { Booking } from "@clinica/api-client";
import { fmtDay, fmtSpan, TZ } from "../../lib/fmt";
import { Modal } from "../../ui/modal";
import { Pill } from "../../ui/controls";

const TONE: Record<Booking["status"], "brand" | "ok" | "warn" | "neutral"> = {
  agendada: "brand",
  realizada: "ok",
  no_show: "warn",
  cancelada: "neutral",
};

function Row({ icon: Icon, label, children }: { icon: typeof Clock; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden />
      <div className="min-w-0">
        <dt className="kicker">{label}</dt>
        <dd className="text-sm">{children}</dd>
      </div>
    </div>
  );
}

/** El detalle de una cita, SOLO lectura: el doctor no cambia el estado desde aquí (lo hace el personal) y no ve el teléfono. */
export function BookingSheet({ booking: b, onClose }: { booking: Booking; onClose: () => void }) {
  const day = wallClock(b.scheduledAtUtc, TZ).day;
  return (
    <Modal title={bookingTitle(b)} onClose={onClose} variant="side" initialFocus="panel">
      <div className="flex flex-col gap-4">
        <div>
          <Pill tone={TONE[b.status]}>{statusLabel(b)}</Pill>
        </div>
        <dl className="flex flex-col gap-3.5">
          <Row icon={Clock} label="Fecha y hora">
            {fmtDay(day)} · {fmtSpan(b.scheduledAtUtc, b.durationMinutes)} <span className="text-text-3">({b.durationMinutes} min)</span>
          </Row>
          {b.room && (
            <Row icon={Building2} label="Consultorio">
              {b.room.name}
            </Row>
          )}
          <Row icon={b.source === "ai" ? Bot : UserRound} label="Agendada por">
            {b.source === "ai" ? "El asistente de WhatsApp" : "El personal de la clínica"}
          </Row>
          {b.notes && (
            <Row icon={StickyNote} label="Notas">
              <span className="whitespace-pre-wrap">{b.notes}</span>
            </Row>
          )}
        </dl>
        <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-3">
          Por privacidad no ves el teléfono del paciente. Si necesitas contactarlo o cambiar la cita, pídelo al personal de la clínica.
        </p>
      </div>
    </Modal>
  );
}
