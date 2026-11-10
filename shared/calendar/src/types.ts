import type { Interval, WeekdayKey } from "./lib/slots";

/** Horario semanal por dia: `{ mon: [{start:"09:00", end:"18:00"}], ... }` (hora de pared). */
export type WeeklyHours = Partial<Record<WeekdayKey, Interval[]>>;

export type BookingStatus = "agendada" | "realizada" | "no_show" | "cancelada";

/**
 * Una cita de la clinica. `kind: "block"` es un bloqueo (consultorio en
 * mantenimiento, etc.). Los instantes viajan en UTC; la rejilla los pinta en
 * la zona de la clinica.
 */
export type Booking = {
  id: string;
  kind: "session" | "block";
  status: BookingStatus;
  /** `ai` = la agendo el bot de WhatsApp; `manual` = el personal. */
  source: "manual" | "ai";
  scheduledAtUtc: string;
  durationMinutes: number;
  patient: { id: string; name: string; phone?: string } | null;
  doctor: { id: string; name: string; specialty: string } | null;
  room: { id: string; name: string } | null;
  notes: string | null;
};

/** Una columna de la vista de dia: un doctor o un consultorio. */
export type Lane = {
  id: string;
  label: string;
  sublabel?: string;
  /** Si existe, sombrea lo que esta fuera del horario de ESTE carril. */
  weeklyHours?: WeeklyHours;
};
