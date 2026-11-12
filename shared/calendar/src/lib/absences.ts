import { wallClock } from "./calendar";
import { addDaysISO, zonedWallClockToUtc } from "./slots";

/**
 * Ausencias en la rejilla. Capa propia (no toca `calendar.ts` ni `slots.ts`, copiados de Vocero).
 *
 * Una ausencia es un intervalo `[startUtc, endUtc)` que puede durar horas, un dia, varios dias o semanas. Para pintarla en la
 * columna de un dia se recorta contra ese dia EN LA ZONA DE LA CLINICA (no `bookingSegments`: esa funcion parte una cita en
 * a lo mucho 7 dias y una ausencia larga, de vacaciones, tiene que verse en cualquier semana de su rango).
 */

export type AbsenceSegment = {
  /** Minuto del dia en que empieza el tramo (0–1439). */
  startMin: number;
  /** Minuto en que termina (1–1440). */
  endMin: number;
  /** La ausencia viene de un dia anterior / sigue al dia siguiente. */
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/** El tramo de la ausencia que cae en `day` (`AAAA-MM-DD`, hora de la clinica), o `null` si no toca ese dia. */
export function absenceDaySegment(a: { startUtc: string; endUtc: string }, day: string, tz: string): AbsenceSegment | null {
  const start = Date.parse(a.startUtc);
  const end = Date.parse(a.endUtc);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  const dayStart = zonedWallClockToUtc(day, "00:00", tz)?.getTime();
  const dayEnd = zonedWallClockToUtc(addDaysISO(day, 1), "00:00", tz)?.getTime();
  if (dayStart === undefined || dayEnd === undefined) return null;

  const lo = Math.max(start, dayStart);
  const hi = Math.min(end, dayEnd);
  if (lo >= hi) return null;
  const startMin = lo === dayStart ? 0 : wallClock(new Date(lo), tz).minutes;
  const endMin = hi === dayEnd ? 1440 : wallClock(new Date(hi), tz).minutes;
  return { startMin, endMin: Math.max(endMin, startMin + 1), continuesBefore: start < dayStart, continuesAfter: end > dayEnd };
}

/** El texto de la franja: «Ausencia» o «Ausencia · Congreso» (con el motivo, si lo hay). */
export function absenceLabel(a: { reason?: string | null; kind?: "absence" | "busy" }): string {
  if (a.kind === "busy") return BUSY_LABEL;   // el evento personal es privado: sin motivo, aunque llegue uno
  const reason = a.reason?.trim();
  return reason ? `Ausencia · ${reason}` : "Ausencia";
}

/** Lo unico que el personal lee de un evento personal de un doctor. */
export const BUSY_LABEL = "No disponible";
