import { WEEKDAYS, addDaysISO, isValidInterval, todayInTz, zonedWallClockToUtc, type WeekdayKey } from "@clinica/calendar/src/lib/slots";
import { wallClock, workingBands } from "@clinica/calendar/src/lib/calendar";
import type { Booking, WeeklyHours } from "../types";
import { conflict, invalid, rule } from "./http";
import type { DB, StoredDoctor } from "./state";

/** Reglas de agenda del contrato, en el servidor simulado (las mismas que `bot/scheduler.py`). */
export const TZ = "America/Cancun";
export const SLOT_MINUTES = 30;
export const MIN_LEAD_MINUTES = 60;
export const HORIZON_DAYS = 60;

export const hoursOf = (db: DB, d: StoredDoctor): WeeklyHours => d.ownHours ?? db.clinicHours;

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/** ¿[inicio, inicio + duracion) cabe en un tramo del horario de ese dia (hora de Cancun)? */
export function fitsHours(hours: WeeklyHours, startUtc: string, durationMinutes: number): boolean {
  const { day, minutes } = wallClock(startUtc, TZ);
  return workingBands(hours, day).some((b) => minutes >= b.startMin && minutes + durationMinutes <= b.endMin);
}

/** Cada tramo de `inner` esta contenido en algun tramo de `outer` el mismo dia. */
export function hoursInside(inner: WeeklyHours, outer: WeeklyHours): boolean {
  return WEEKDAYS.every((d) =>
    (inner[d] ?? []).every((iv) =>
      (outer[d] ?? []).some((o) => toMin(iv.start) >= toMin(o.start) && toMin(iv.end) <= toMin(o.end))
    )
  );
}

/** Valida y normaliza un horario semanal recibido: dias conocidos, tramos HH:MM, sin solaparse. */
export function parseWeeklyHours(value: unknown, what = "El horario"): WeeklyHours {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${what} debe ser un objeto por día.`);
  const out: WeeklyHours = {};
  for (const [key, list] of Object.entries(value)) {
    if (!(WEEKDAYS as string[]).includes(key)) throw invalid(`${what}: "${key}" no es un día válido (mon..sun).`);
    if (!Array.isArray(list)) throw invalid(`${what}: "${key}" debe ser una lista de tramos.`);
    const ivs = list.map((iv) => {
      if (!isValidInterval(iv)) throw invalid(`${what}: tramo inválido en "${key}" (usa HH:MM y que termine después de empezar).`);
      return { start: iv.start, end: iv.end };
    });
    ivs.sort((a, b) => toMin(a.start) - toMin(b.start));
    for (let i = 1; i < ivs.length; i++) {
      if (toMin(ivs[i]!.start) < toMin(ivs[i - 1]!.end)) throw invalid(`${what}: los tramos de "${key}" se solapan.`);
    }
    if (ivs.length) out[key as WeekdayKey] = ivs;
  }
  return out;
}

const endMs = (startUtc: string, durationMinutes: number) => Date.parse(startUtc) + durationMinutes * 60_000;

function overlapping(db: DB, startUtc: string, durationMinutes: number, excludeId?: string): Booking[] {
  const s = Date.parse(startUtc);
  const e = endMs(startUtc, durationMinutes);
  return db.bookings.filter(
    (b) =>
      b.id !== excludeId &&
      b.status !== "cancelada" &&
      Date.parse(b.scheduledAtUtc) < e &&
      s < endMs(b.scheduledAtUtc, b.durationMinutes)
  );
}

export type Placement = {
  kind: "session" | "block";
  startUtc: string;
  durationMinutes: number;
  doctorId: string | null;
  /** Consultorio pedido; si falta, se elige el primero libre. */
  roomId?: string | null;
  /** Al mover: la propia cita no cuenta como ocupada. */
  excludeId?: string;
  /** Solo personal/admin: omite la antelacion de 60 min (no el pasado, ni el resto). */
  allowShortNotice?: boolean;
  /** Para los datos de ejemplo: sin antelacion ni horizonte. */
  relaxed?: boolean;
};

/**
 * Aplica TODAS las reglas de agenda a un hueco y devuelve el consultorio. Es la
 * unica puerta para crear y para mover, asi que reservar y reprogramar no
 * pueden desviarse. Lanza `HttpError` (409 ocupado, 422 regla incumplida); no
 * toca el estado, de modo que un movimiento fallido deja la cita original intacta.
 */
export function placeInSchedule(db: DB, now: Date, p: Placement): { roomId: string } {
  const start = Date.parse(p.startUtc);
  if (Number.isNaN(start)) throw invalid("La fecha y hora no es válida.");
  if (start % (SLOT_MINUTES * 60_000) !== 0) throw invalid("La hora debe ser en punto o y media (citas de 30 minutos).");
  if (!Number.isInteger(p.durationMinutes) || p.durationMinutes < SLOT_MINUTES || p.durationMinutes % SLOT_MINUTES !== 0) {
    throw invalid("La duración debe ser múltiplo de 30 minutos.");
  }

  if (!p.relaxed) {
    const today = todayInTz(now, TZ);
    if (wallClock(p.startUtc, TZ).day > addDaysISO(today, HORIZON_DAYS)) {
      throw rule("fuera_de_rango", `Solo se agenda hasta ${HORIZON_DAYS} días a futuro (hasta el ${addDaysISO(today, HORIZON_DAYS)}).`);
    }
    if (p.kind === "session") {
      if (start < now.getTime()) throw rule("horario_pasado_o_muy_cercano", "Ese horario ya pasó.");
      if (!p.allowShortNotice && start < now.getTime() + MIN_LEAD_MINUTES * 60_000) {
        throw rule("horario_pasado_o_muy_cercano", `Se necesitan al menos ${MIN_LEAD_MINUTES} minutos de antelación.`);
      }
    }
  }

  let doctor: StoredDoctor | undefined;
  if (p.kind === "session") {
    doctor = db.doctors.find((d) => d.id === p.doctorId);
    if (!doctor) throw invalid("El doctor no existe.");
    if (!doctor.active) throw rule("doctor_no_disponible", `${doctor.name} está dado de baja.`);
    if (!fitsHours(hoursOf(db, doctor), p.startUtc, p.durationMinutes)) {
      throw rule("fuera_de_horario", `${doctor.name} no atiende en ese horario.`);
    }
    const e = endMs(p.startUtc, p.durationMinutes);
    const absent = db.absences.some((a) => a.doctorId === doctor!.id && Date.parse(a.startUtc) < e && start < Date.parse(a.endUtc));
    if (absent) throw rule("doctor_no_disponible", `${doctor.name} está ausente en ese horario.`);
  }

  const busy = overlapping(db, p.startUtc, p.durationMinutes, p.excludeId);
  if (doctor && busy.some((b) => b.doctor?.id === doctor!.id)) {
    throw conflict(`${doctor.name} ya tiene una cita en ese horario.`);
  }

  const taken = new Set(busy.map((b) => b.room?.id));
  if (p.roomId) {
    if (!db.rooms.some((r) => r.id === p.roomId)) throw invalid("El consultorio no existe.");
    if (taken.has(p.roomId)) throw conflict("Ese consultorio ya está ocupado en ese horario.");
    return { roomId: p.roomId };
  }
  const free = db.rooms.find((r) => !taken.has(r.id));
  if (!free) throw conflict("Los dos consultorios están ocupados en ese horario.");
  return { roomId: free.id };
}

/** Citas agendadas futuras del doctor que NO caben en `hours`. */
export function outsideHours(db: DB, doctorId: string, hours: WeeklyHours, now: Date): Booking[] {
  return db.bookings.filter(
    (b) =>
      b.kind === "session" &&
      b.status === "agendada" &&
      b.doctor?.id === doctorId &&
      Date.parse(b.scheduledAtUtc) >= now.getTime() &&
      !fitsHours(hours, b.scheduledAtUtc, b.durationMinutes)
  );
}

/** Primer hueco libre del doctor desde `fromDay` (para los datos de ejemplo y el "bot" simulado). */
export function nextFreeSlot(db: DB, now: Date, doctorId: string, fromDay: string, days = 21): string | null {
  const doctor = db.doctors.find((d) => d.id === doctorId);
  if (!doctor) return null;
  for (let i = 0; i < days; i++) {
    const day = addDaysISO(fromDay, i);
    for (const band of workingBands(hoursOf(db, doctor), day)) {
      for (let m = band.startMin; m + SLOT_MINUTES <= band.endMin; m += SLOT_MINUTES) {
        const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        const startUtc = zonedWallClockToUtc(day, hhmm, TZ)!.toISOString();
        try {
          placeInSchedule(db, now, { kind: "session", startUtc, durationMinutes: SLOT_MINUTES, doctorId });
          return startUtc;
        } catch {
          /* ocupado o fuera de reglas: siguiente */
        }
      }
    }
  }
  return null;
}
