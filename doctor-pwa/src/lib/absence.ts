import { addDaysISO, wallClock } from "@clinica/calendar";
import type { Absence } from "@clinica/api-client";
import { TZ, fmtDateTime, fmtDay } from "./fmt";

/**
 * Cómo se lee una ausencia: «jue 12 nov (todo el día)», «jue 12 nov al vie 13 nov (todo el día)» o,
 * si no empieza ni termina a medianoche de Cancún, «jue 12 nov · 09:00 → jue 12 nov · 12:00».
 */
export function describeAbsence(a: Pick<Absence, "startUtc" | "endUtc">): string {
  const s = wallClock(a.startUtc, TZ);
  const e = wallClock(a.endUtc, TZ);
  if (s.minutes === 0 && e.minutes === 0) {
    const lastDay = addDaysISO(e.day, -1);
    return lastDay === s.day ? `${fmtDay(s.day)} (todo el día)` : `${fmtDay(s.day)} al ${fmtDay(lastDay)} (todo el día)`;
  }
  return `${fmtDateTime(a.startUtc)} → ${fmtDateTime(a.endUtc)}`;
}

/** ¿La ausencia toca el intervalo `[fromUtc, toUtc)`? */
export function overlapsRange(a: Pick<Absence, "startUtc" | "endUtc">, fromUtc: string, toUtc: string): boolean {
  return Date.parse(a.startUtc) < Date.parse(toUtc) && Date.parse(fromUtc) < Date.parse(a.endUtc);
}

/** «Se avisó…» tras registrar una ausencia: cuántas citas agendadas quedan en ese rango. */
export function affectedMessage(count: number): string {
  if (count <= 0) return "No tienes citas agendadas en ese rango.";
  return count === 1
    ? "Tienes 1 cita agendada en ese rango. No se canceló: el personal ya fue avisado para contactar al paciente."
    : `Tienes ${count} citas agendadas en ese rango. No se cancelaron: el personal ya fue avisado para contactar a los pacientes.`;
}
