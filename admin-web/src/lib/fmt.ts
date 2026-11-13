import { dayHeading, timeLabel, timeRangeLabel, wallClock } from "@clinica/calendar";
import type { Role } from "@clinica/api-client";

/** «30 min», «1 h», «1 h 30 min». */
export const durationLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`);

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

/**
 * Teléfono para leer: "529980001234" -> "+52 998 000 1234". Un número de 10 dígitos (el de contacto que da quien escribe por Messenger
 * o Instagram, sin lada de país) se agrupa SIN el "+", porque no sabemos de qué país es: "9981234567" -> "998 123 4567". Lo demás
 * queda como "+dígitos".
 */
export function fmtPhone(digits: string): string {
  if (/^52\d{10}$/.test(digits)) return `+52 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  if (/^\d{10}$/.test(digits)) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return `+${digits}`;
}
