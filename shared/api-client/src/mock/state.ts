import type {
  Absence,
  AttentionItem,
  Booking,
  BotSettings,
  Doctor,
  Role,
  Room,
  ScheduleChangeRequest,
  User,
  WeeklyHours,
} from "../types";

export type StoredUser = User & { password: string };

/** El doctor tal como se guarda: `ownHours: null` = sigue el horario de la clinica. */
export type StoredDoctor = {
  id: string;
  name: string;
  specialty: string;
  aliases: string[];
  active: boolean;
  ownHours: WeeklyHours | null;
};

export type Session = { userId: string; csrfTokens: Set<string> };

export type DB = {
  users: StoredUser[];
  doctors: StoredDoctor[];
  rooms: Room[];
  clinicHours: WeeklyHours;
  /** Citas y bloqueos, con `patient.phone` completo (se quita al servir al doctor). */
  bookings: Booking[];
  absences: Absence[];
  requests: ScheduleChangeRequest[];
  bot: BotSettings;
  attention: AttentionItem[];
  sessions: Map<string, Session>;
  loginFailures: Map<string, { count: number; blockedUntil: number }>;
  counters: Record<string, number>;
};

export function nextId(db: DB, prefix: string): string {
  db.counters[prefix] = (db.counters[prefix] ?? 0) + 1;
  return `${prefix}${db.counters[prefix]}`;
}

export function doctorView(db: DB, d: StoredDoctor): Doctor {
  return {
    id: d.id,
    name: d.name,
    specialty: d.specialty,
    aliases: [...d.aliases],
    active: d.active,
    weeklyHours: structuredClone(d.ownHours ?? db.clinicHours),
    usesClinicHours: d.ownHours === null,
  };
}

export function publicUser(u: StoredUser): User {
  const { password: _password, ...rest } = u;
  return rest;
}

/** El doctor ve la cita sin telefono, y su `patient.id` no puede ser el telefono. */
export function bookingFor(role: Role, b: Booking): Booking {
  const copy = structuredClone(b);
  if (role === "doctor" && copy.patient) {
    copy.patient = { id: copy.id, name: copy.patient.name };
  }
  return copy;
}

/** Hash corto y estable de una cadena (FNV-1a): el `ETag` de las listas. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
