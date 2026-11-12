import type { CSSProperties } from "react";
import { ON_DOCTOR_COLOR, colorOf } from "../lib/doctor-color";
import type { Booking, BookingStatus } from "../types";

export type { Booking };

/** Como se ve y como se nombra una cita, igual en las cuatro vistas. */

export const STATUS_LABEL: Record<BookingStatus, string> = {
  agendada: "Agendada",
  realizada: "Realizada",
  no_show: "No asistió",
  cancelada: "Cancelada",
};

/** Un bloqueo no se "agenda" ni se "cancela": esta activo o se quito. */
export function statusLabel(b: Booking): string {
  if (b.kind === "block") return b.status === "cancelada" ? "Quitado" : "Activo";
  return STATUS_LABEL[b.status];
}

/** Lo que se lee en la rejilla: el paciente o, en un bloqueo, su nota. */
export function bookingTitle(b: Booking): string {
  if (b.kind === "block") return b.notes?.trim() || "Bloqueo";
  return b.patient?.name.trim() || "Sin paciente";
}

/** Segunda linea: doctor y consultorio (o solo uno, segun la vista). */
export function bookingSubtitle(b: Booking, parts: { doctor?: boolean; room?: boolean } = { doctor: true, room: true }): string {
  const out: string[] = [];
  if (parts.doctor && b.doctor) out.push(b.doctor.name);
  if (parts.room && b.room) out.push(b.room.name);
  return out.join(" · ");
}

/**
 * El color del DOCTOR sobre la cita, para saber de un vistazo de quien es. Va como estilo en linea (encima de las clases
 * de `bookingTone`): una cita "agendada" se rellena con el color del doctor; las demas conservan el aspecto de su estado
 * (realizada, no asistio, cancelada) con una franja a la izquierda del color del doctor. Un bloqueo no tiene doctor: sin color.
 */
export function bookingStyle(b: Booking): CSSProperties | undefined {
  const color = b.kind === "block" ? null : colorOf(b.doctor);
  if (!color) return undefined;
  if (b.status === "agendada") return { backgroundColor: color, borderColor: color, color: ON_DOCTOR_COLOR };
  return { borderLeftColor: color, borderLeftWidth: 4, borderLeftStyle: "solid" };
}

/** El puntito de la cita (mes, lista, detalle): del color del doctor; sin doctor conserva el del estado (`bookingTone`). */
export function bookingDotStyle(b: Booking): CSSProperties | undefined {
  const color = b.kind === "block" ? null : colorOf(b.doctor);
  return color ? { backgroundColor: color } : undefined;
}

/** Color por estado, solo con tokens del tema (ver styles.css). */
export function bookingTone(b: Booking): { box: string; dot: string } {
  if (b.status === "cancelada") {
    return { box: "border-dashed border-border-strong bg-subtle text-text-3 line-through", dot: "bg-text-4" };
  }
  if (b.kind === "block") {
    return { box: "booking-hatch border-border-strong text-text-2", dot: "bg-text-3" };
  }
  if (b.status === "realizada") {
    return { box: "border-success-soft bg-success-tint text-success-text", dot: "bg-success" };
  }
  if (b.status === "no_show") {
    return { box: "border-warning-soft bg-warning-tint text-warning-text", dot: "bg-warning" };
  }
  return { box: "border-transparent bg-brand text-brand-fg", dot: "bg-brand" };
}
