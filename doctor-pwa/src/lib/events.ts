import { addDaysISO, hhmm, wallClock } from "@clinica/calendar";
import type { PersonalEvent } from "@clinica/api-client";
import { TZ } from "./fmt";
import { utcOf } from "./range";

/**
 * Eventos personales: lo que el formulario captura (día, hora de inicio y DURACIÓN, o todo el día) y cómo se convierte
 * a los instantes UTC de la API y de vuelta. Todo en la hora de pared de Cancún.
 */

/** Horas de inicio cada 15 min, todo el día (un evento personal no tiene que caer en la rejilla de 30 min de las citas). */
export const START_TIMES: string[] = Array.from({ length: 96 }, (_, i) => hhmm(i * 15));

/** Duraciones que se ofrecen (minutos). Un evento con otra duración (p. ej. 80 min) agrega la suya al editarlo. */
export const DURATIONS: number[] = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];

/** «30 min», «1 h», «1 h 30 min». */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export type EventForm = {
  day: string;
  allDay: boolean;
  /** `HH:MM` de inicio (se ignora con `allDay`). */
  time: string;
  /** Duración en minutos (se ignora con `allDay`). */
  duration: number;
};

/** El formulario de un evento que ya existe. Un evento de 24 h que empieza a medianoche es «todo el día». */
export function formOf(ev: Pick<PersonalEvent, "startUtc" | "endUtc">): EventForm {
  const start = wallClock(ev.startUtc, TZ);
  const duration = Math.max(1, Math.round((Date.parse(ev.endUtc) - Date.parse(ev.startUtc)) / 60_000));
  return { day: start.day, allDay: start.minutes === 0 && duration === 1440, time: hhmm(start.minutes), duration };
}

/** Los instantes UTC `[startUtc, endUtc)` del formulario, o `null` si el día o la hora no existen. */
export function instantsOf(f: EventForm): { startUtc: string; endUtc: string } | null {
  if (f.allDay) {
    const startUtc = utcOf(f.day, "00:00");
    const endUtc = utcOf(addDaysISO(f.day, 1), "00:00");
    return startUtc && endUtc ? { startUtc, endUtc } : null;
  }
  const startUtc = utcOf(f.day, f.time);
  if (!startUtc || !Number.isFinite(f.duration) || f.duration <= 0) return null;
  return { startUtc, endUtc: new Date(Date.parse(startUtc) + f.duration * 60_000).toISOString() };
}

/** ¿Los dos intervalos `[a0, a1)` y `[b0, b1)` (instantes ISO) se solapan? */
export const overlaps = (a0: string, a1: string, b0: string, b1: string): boolean =>
  Date.parse(a0) < Date.parse(b1) && Date.parse(b0) < Date.parse(a1);
