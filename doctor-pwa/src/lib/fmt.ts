import { addDaysISO, dayHeading, timeLabel, timeRangeLabel, wallClock } from "@clinica/calendar";

export const TZ = "America/Cancun";

/** "11:00 AM" (hora de Cancún, formato de 12 h). */
export const fmtTime = (utc: string): string => timeLabel(wallClock(utc, TZ).minutes);

/** "jue 12 nov" para una fecha AAAA-MM-DD. */
export function fmtDay(day: string): string {
  const h = dayHeading(day);
  return `${h.weekday} ${h.day} ${h.month}`;
}

/** "jue 12 nov · 11:00 AM" para un instante UTC. */
export function fmtDateTime(utc: string): string {
  const w = wallClock(utc, TZ);
  return `${fmtDay(w.day)} · ${timeLabel(w.minutes)}`;
}

/** "11:00 AM – 11:30 AM". */
export function fmtSpan(utc: string, minutes: number): string {
  const w = wallClock(utc, TZ);
  return timeRangeLabel(w.minutes, w.minutes + minutes);
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

/** "hoy 10:42 AM" o "jue 12 nov 10:42 AM": cuándo fue la última sincronización, en hora de Cancún. */
export function fmtSyncTime(at: Date, now: Date): string {
  const w = wallClock(at, TZ);
  const today = wallClock(now, TZ).day;
  const day = w.day === today ? "hoy" : w.day === addDaysISO(today, -1) ? "ayer" : fmtDay(w.day);
  return `${day} ${timeLabel(w.minutes)}`;
}
