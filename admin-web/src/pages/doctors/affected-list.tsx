import { Phone } from "lucide-react";
import type { Booking } from "@clinica/api-client";
import { fmtDateTime, fmtPhone } from "../../lib/fmt";
import { Notice } from "../../ui/controls";

/**
 * Las citas que un cambio de horario o una ausencia deja fuera. El servidor NO las
 * cancela (y el bot no puede escribir primero): el personal avisa a cada paciente.
 */
export function AffectedList({ items, onDismiss }: { items: Booking[]; onDismiss: () => void }) {
  if (items.length === 0) return null;
  return (
    <Notice tone="warn" className="flex flex-col gap-2">
      <p className="font-semibold">
        {items.length === 1 ? "1 cita agendada queda afectada." : `${items.length} citas agendadas quedan afectadas.`} No se cancelaron: avisa a los pacientes para reprogramar.
      </p>
      <ul className="flex flex-col gap-1 text-[13px]">
        {items.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-x-2">
            <span className="font-semibold">{b.patient?.name ?? "Sin paciente"}</span>
            <span>{fmtDateTime(b.scheduledAtUtc)}</span>
            {b.patient?.phone && (
              <span className="inline-flex items-center gap-1">
                <Phone className="h-3 w-3" aria-hidden />
                {fmtPhone(b.patient.phone)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onDismiss} className="w-fit text-xs font-semibold underline underline-offset-2">
        Ya los avisé
      </button>
    </Notice>
  );
}
