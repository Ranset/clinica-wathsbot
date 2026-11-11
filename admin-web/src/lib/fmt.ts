import { dayHeading, hhmm, wallClock } from "@clinica/calendar";
import type { Role } from "@clinica/api-client";

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

/** "hace 4 s" / "hace 2 min". */
export function ago(from: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (s < 5) return "ahora mismo";
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.floor(m / 60)} h`;
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Administrador técnico",
  staff: "Personal de la clínica",
  doctor: "Doctor",
};

/** Teléfono para leer: "529980001234" -> "+52 998 000 1234" (lo demás queda como "+dígitos"). */
export function fmtPhone(digits: string): string {
  if (/^52\d{10}$/.test(digits)) return `+52 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  return `+${digits}`;
}
