import type {
  Absence,
  AttentionItem,
  Booking,
  BotSettings,
  Doctor,
  PersonalEvent,
  Role,
  Room,
  ScheduleChangeRequest,
  User,
  WeeklyHours,
} from "../types";

/**
 * Un usuario tal como se guarda. `password: null` = todavía sin contraseña (la cuenta de un doctor recién dado de alta); `setup` = el
 * enlace vigente para establecerla (de un solo uso). La API los muestra como `passwordSet` (si ya hay contraseña) y nunca el resto.
 */
export type StoredUser = Omit<User, "passwordSet"> & { password: string | null; setup?: { token: string; expiresAt: number } | null };

/** Un evento personal con su dueno: la API del doctor lo sirve SIN `doctorId`, y el personal solo ve horas + doctor. */
export type StoredPersonalEvent = PersonalEvent & { doctorId: string };

/** El doctor tal como se guarda: `ownHours: null` = sigue el horario de la clinica. */
export type StoredDoctor = {
  id: string;
  /** Codigo de acceso de 4 digitos (lo asigna el alta; no se edita). */
  code: string;
  name: string;
  specialty: string;
  aliases: string[];
  active: boolean;
  ownHours: WeeklyHours | null;
  /** Color elegido (`#rrggbb`); `null`/ausente = automatico. */
  color?: string | null;
};

export type Session = { userId: string; csrfTokens: Set<string> };

/** El logotipo tal como llego (los bytes de la imagen) y su huella (la `?v=` de la direccion). */
export type StoredLogo = { contentType: string; bytes: Uint8Array; hash: string };

export type DB = {
  users: StoredUser[];
  doctors: StoredDoctor[];
  rooms: Room[];
  clinicHours: WeeklyHours;
  /** Citas y bloqueos, con `patient.phone` completo (se quita al servir al doctor). */
  bookings: Booking[];
  absences: Absence[];
  /** Nombre y logotipo de la clinica (publicos; solo el administrador los cambia). */
  branding: { name: string; logo: StoredLogo | null };
  /** Eventos personales de los doctores (privados: titulo y notas solo salen por las rutas del propio doctor). */
  personalEvents: StoredPersonalEvent[];
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

/** El menor codigo de doctor libre desde 1001 (igual que el servidor: `app/doctor_codes.py`). */
export function nextDoctorCode(db: DB): string {
  const taken = new Set(db.doctors.map((d) => d.code));
  for (let n = 1001; n <= 9999; n++) if (!taken.has(String(n))) return String(n);
  throw new Error("Ya no quedan códigos de doctor libres.");
}

export function doctorView(db: DB, d: StoredDoctor): Doctor {
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    specialty: d.specialty,
    aliases: [...d.aliases],
    active: d.active,
    weeklyHours: structuredClone(d.ownHours ?? db.clinicHours),
    usesClinicHours: d.ownHours === null,
    color: d.color ?? null,
  };
}

/** El doctor tal como va dentro de una cita (`Booking.doctor`). */
export function doctorRef(d: StoredDoctor): NonNullable<Booking["doctor"]> {
  return { id: d.id, name: d.name, specialty: d.specialty, color: d.color ?? null };
}

export function publicUser(u: StoredUser): User {
  const { password, setup: _setup, ...rest } = u;
  return { ...rest, passwordSet: password !== null };
}

/** La clave del contador de intentos de una cuenta: su correo, o su id si no tiene (la cuenta de un doctor). */
export const accountKey = (u: StoredUser): string => (u.email ? u.email.toLowerCase() : `cuenta:${u.id}`);

/** El doctor ve la cita sin telefono, y su `patient.id` no puede ser el telefono. */
export function bookingFor(role: Role, b: Booking): Booking {
  const copy = structuredClone(b);
  if (role === "doctor" && copy.patient) {
    copy.patient = { id: copy.id, name: copy.patient.name };
  }
  return copy;
}

/** Huella corta y estable de unos bytes (FNV-1a): la `?v=` del logotipo en el simulador (el servidor real usa SHA-256). */
export function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
