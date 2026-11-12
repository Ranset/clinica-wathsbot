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
  /** `color`: el elegido para el doctor (`#rrggbb`); `null` o ausente = automatico (`doctorColor(id)`). */
  doctor: { id: string; name: string; specialty: string; color?: string | null } | null;
  room: { id: string; name: string } | null;
  notes: string | null;
};

/**
 * Una ausencia de un doctor para pintarla en la rejilla (franja rayada con el motivo). Es un subconjunto de la `Absence` de la API,
 * asi que se puede pasar tal cual.
 */
export type CalendarAbsence = {
  startUtc: string;
  endUtc: string;
  reason?: string | null;
  /**
   * `"absence"` (por defecto): franja ambar «Ausencia · motivo». `"busy"`: el doctor esta ocupado por un evento PERSONAL cuyo
   * detalle es privado: franja gris «No disponible», sin motivo (aunque se pase uno, no se muestra). Asi lo ve el personal.
   */
  kind?: "absence" | "busy";
  /**
   * Con carriles (un dia, una columna por doctor/consultorio) la ausencia solo se pinta en el carril con ESE id (p. ej. el id del
   * doctor). Sin `laneId` se pinta en todas las columnas, que es lo que quiere la agenda de UN doctor.
   */
  laneId?: string;
};

/**
 * Un evento personal del doctor, con su texto (solo lo ve su dueno: la PWA). NO es una cita de la clinica: en esa franja el
 * doctor no recibe citas. Es un subconjunto del `PersonalEvent` de la API, asi que se puede pasar tal cual. Es para la agenda
 * de UN doctor (la PWA): la web del personal nunca recibe el texto, solo `CalendarAbsence` con `kind: "busy"`.
 */
export type CalendarPersonalEvent = {
  id: string;
  title: string;
  notes?: string | null;
  startUtc: string;
  endUtc: string;
  /** Con carriles solo se pinta en el carril con ESE id; sin `laneId`, en todos (lo normal: la agenda de UN doctor tiene un solo carril). */
  laneId?: string;
};

/** Una columna de la vista de dia: un doctor o un consultorio. */
export type Lane = {
  id: string;
  label: string;
  sublabel?: string;
  /** Color del carril (`#rrggbb`): una franja sobre el encabezado. Los carriles de doctor usan `doctorColor(id)`. */
  color?: string;
  /** Si existe, sombrea lo que esta fuera del horario de ESTE carril. */
  weeklyHours?: WeeklyHours;
};
