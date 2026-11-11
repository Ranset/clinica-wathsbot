import { addDaysISO, dayHeading, hhmm, wallClock } from "@clinica/calendar";

export const TZ = "America/Cancun";

/** "11:00" (hora de Cancún). */
export const fmtTime = (utc: string): string => hhmm(wallClock(utc, TZ).minutes);

/** "jue 12 nov" para una fecha AAAA-MM-DD. */
export function fmtDay(day: string): string {
  const h = dayHeading(day);
  return `${h.weekday} ${h.day} ${h.month}`;
}

/** "jue 12 nov · 11:00" para un instante UTC. */
export function fmtDateTime(utc: string): string {
  const w = wallClock(utc, TZ);
  return `${fmtDay(w.day)} · ${hhmm(w.minutes)}`;
}

/** "11:00 – 11:30". */
export function fmtSpan(utc: string, minutes: number): string {
  const w = wallClock(utc, TZ);
  return `${hhmm(w.minutes)} – ${hhmm(w.minutes + minutes)}`;
}

/** "hace 4 s" / "hace 2 min" / "hace 3 h" / "hace 2 d". */
export function ago(from: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (s < 5) return "ahora mismo";
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

/** "hoy 10:42" o "jue 12 nov 10:42": cuándo fue la última sincronización, en hora de Cancún. */
export function fmtSyncTime(at: Date, now: Date): string {
  const w = wallClock(at, TZ);
  const today = wallClock(now, TZ).day;
  const day = w.day === today ? "hoy" : w.day === addDaysISO(today, -1) ? "ayer" : fmtDay(w.day);
  return `${day} ${hhmm(w.minutes)}`;
}
