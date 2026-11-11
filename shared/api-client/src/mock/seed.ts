import { addDaysISO, todayInTz, zonedWallClockToUtc } from "@clinica/calendar/src/lib/slots";
import { weekdayIndex } from "@clinica/calendar/src/lib/calendar";
import type { Booking, WeeklyHours } from "../types";
import { TZ, placeInSchedule } from "./rules";
import { nextId, type DB, type StoredDoctor } from "./state";

/**
 * Cuentas de la API simulada. Son datos de ejemplo para desarrollar; no existen
 * en el servidor real ni se usan fuera del simulador.
 */
export const DEMO_ACCOUNTS = [
  { email: "admin@clinica.test", password: "demo-admin-2026", name: "Administrador Técnico", role: "admin" as const },
  { email: "recepcion@clinica.test", password: "demo-recepcion-2026", name: "Recepción Clínica", role: "staff" as const },
  { email: "cervantes@clinica.test", password: "demo-doctor-2026", name: "Dr. Cervantes Peláez", role: "doctor" as const, doctorId: "d1" },
];

const WEEKDAY_HOURS = [{ start: "09:00", end: "18:00" }];
export const CLINIC_HOURS: WeeklyHours = {
  mon: WEEKDAY_HOURS,
  tue: WEEKDAY_HOURS,
  wed: WEEKDAY_HOURS,
  thu: WEEKDAY_HOURS,
  fri: WEEKDAY_HOURS,
  sat: [{ start: "09:00", end: "13:00" }],
};

/** Los 7 doctores de la clinica. Los horarios propios de Pérez Lago y Geydi son de ejemplo (PENDIENTE real). */
export const DOCTORS: StoredDoctor[] = [
  { id: "d1", name: "Dr. Cervantes Peláez", specialty: "Proctología", aliases: ["proctologo", "proctólogo", "colon", "recto"], active: true, ownHours: null },
  {
    id: "d2",
    name: "Dr. Pérez Lago",
    specialty: "Ginecología",
    aliases: ["ginecologo", "ginecólogo", "gine"],
    active: true,
    ownHours: { tue: [{ start: "10:00", end: "14:00" }], thu: [{ start: "10:00", end: "14:00" }] },
  },
  { id: "d3", name: "Dra. Bordas Rodríguez", specialty: "Ortopedia y Traumatología", aliases: ["ortopedista", "traumatologo", "traumatólogo", "huesos"], active: true, ownHours: null },
  { id: "d4", name: "Dr. Gustavo Torrealba", specialty: "Ultrasonidos", aliases: ["usg", "ultrasonido", "sonografia"], active: true, ownHours: null },
  { id: "d5", name: "Dr. Molina López", specialty: "Otorrinolaringología", aliases: ["otorrino", "oido", "nariz", "garganta"], active: true, ownHours: null },
  { id: "d6", name: "Dra. Geydi", specialty: "Anestesiología", aliases: ["anestesiologo", "anestesiólogo"], active: true, ownHours: { sat: [{ start: "09:00", end: "13:00" }] } },
  { id: "d7", name: "Dra. Ana del Carmen Argüelles", specialty: "Reumatología", aliases: ["reumatologo", "reumatólogo"], active: true, ownHours: null },
];

/** Nombres de ejemplo. 12 y 11 son primos entre si: las parejas (n % 12, n % 11) no se repiten en 132 citas. */
const FIRST = ["María", "José Luis", "Ana Karen", "Carlos", "Lucía", "Roberto", "Guadalupe", "Miguel Ángel", "Diana", "Fernando", "Sofía", "Jorge"];
const LAST = ["Hernández Cruz", "Ramírez Soto", "Pech Canul", "Mena Ortiz", "Cetina Uc", "Chan Poot", "Sánchez Arias", "Ortiz Vega", "Tun May", "Castillo Díaz", "Valdez Herrera"];
const patientName = (n: number) => `${FIRST[n % FIRST.length]} ${LAST[n % LAST.length]}`;

type Pattern = { doctor: string; time: string; duration: number };
const DAILY: Pattern[] = [
  { doctor: "d1", time: "09:00", duration: 30 },
  { doctor: "d3", time: "09:00", duration: 30 },
  { doctor: "d4", time: "10:30", duration: 30 },
  { doctor: "d5", time: "11:00", duration: 60 },
  { doctor: "d7", time: "12:00", duration: 30 },
  { doctor: "d1", time: "16:00", duration: 30 },
];
const TUE_THU: Pattern[] = [
  { doctor: "d2", time: "10:00", duration: 30 },
  { doctor: "d2", time: "10:30", duration: 30 },
  { doctor: "d2", time: "12:00", duration: 30 },
];

/** Una base de datos de ejemplo, con citas repartidas alrededor de `now` (se rehace en cada arranque). */
export function createSeededDb(now: Date): DB {
  const db: DB = {
    users: [],
    doctors: structuredClone(DOCTORS),
    rooms: [
      { id: "r1", name: "Consultorio 1" },
      { id: "r2", name: "Consultorio 2" },
    ],
    clinicHours: structuredClone(CLINIC_HOURS),
    bookings: [],
    absences: [],
    requests: [],
    bot: { active: true, updatedAt: now.toISOString(), updatedBy: null },
    attention: [],
    sessions: new Map(),
    loginFailures: new Map(),
    // Los doctores de ejemplo ya traen id (d1..d7): el contador sigue desde ahi para que un alta no repita id.
    counters: { d: DOCTORS.length },
  };

  for (const a of DEMO_ACCOUNTS) {
    db.users.push({ id: nextId(db, "u"), email: a.email, name: a.name, role: a.role, doctorId: ("doctorId" in a ? a.doctorId : null) ?? null, active: true, password: a.password });
  }
  db.users.push({ id: nextId(db, "u"), email: "exrecepcion@clinica.test", name: "Ex Recepción", role: "staff", doctorId: null, active: false, password: "demo-baja-2026-x" });

  const today = todayInTz(now, TZ);
  let n = 0;
  const place = (day: string, p: Pattern) => {
    const startUtc = zonedWallClockToUtc(day, p.time, TZ)!.toISOString();
    const doctor = db.doctors.find((d) => d.id === p.doctor)!;
    let roomId: string;
    try {
      roomId = placeInSchedule(db, now, { kind: "session", startUtc, durationMinutes: p.duration, doctorId: p.doctor, relaxed: true }).roomId;
    } catch {
      return; // el doctor no atiende ese dia u hora: no hay cita de ejemplo
    }
    const past = Date.parse(startUtc) < now.getTime();
    const name = patientName(n);
    const phone = `5299800${String(1000 + n).padStart(5, "0")}`;
    const status: Booking["status"] = past ? (n % 5 === 0 ? "no_show" : "realizada") : "agendada";
    db.bookings.push({
      id: nextId(db, "b"),
      kind: "session",
      status,
      source: n % 3 === 0 ? "manual" : "ai",
      scheduledAtUtc: startUtc,
      durationMinutes: p.duration,
      patient: { id: phone, name, phone },
      doctor: { id: doctor.id, name: doctor.name, specialty: doctor.specialty },
      room: db.rooms.find((r) => r.id === roomId)!,
      notes: null,
    });
    n++;
  };

  for (let off = -3; off <= 10; off++) {
    const day = addDaysISO(today, off);
    const wd = weekdayIndex(day);
    if (wd === 6) continue; // domingo
    DAILY.forEach((p) => place(day, p));
    if (wd === 1 || wd === 3) TUE_THU.forEach((p) => place(day, p));
    if (wd === 5) place(day, { doctor: "d6", time: "09:00", duration: 30 });
  }

  // Una cita cancelada y un bloqueo, para que se vean en el calendario.
  const cancelled = db.bookings.find((b) => b.status === "agendada");
  if (cancelled) cancelled.status = "cancelada";
  db.bookings.push({
    id: nextId(db, "b"),
    kind: "block",
    status: "agendada",
    source: "manual",
    scheduledAtUtc: zonedWallClockToUtc(addDaysISO(today, 2), "14:00", TZ)!.toISOString(),
    durationMinutes: 120,
    patient: null,
    doctor: null,
    room: db.rooms[1]!,
    notes: "Mantenimiento",
  });

  // Una ausencia futura del Dr. Molina que afecta citas ya agendadas, con su aviso al personal.
  const absStart = zonedWallClockToUtc(addDaysISO(today, 4), "09:00", TZ)!.toISOString();
  const absEnd = zonedWallClockToUtc(addDaysISO(today, 5), "18:00", TZ)!.toISOString();
  db.absences.push({ id: nextId(db, "a"), doctorId: "d5", startUtc: absStart, endUtc: absEnd, reason: "Congreso médico" });
  const hit = db.bookings.filter((b) => b.doctor?.id === "d5" && b.status === "agendada" && b.scheduledAtUtc >= absStart && b.scheduledAtUtc < absEnd);
  if (hit.length) {
    db.attention.push({
      id: nextId(db, "at"),
      kind: "absence_affects_appointments",
      status: "open",
      createdAtUtc: new Date(now.getTime() - 3 * 3600_000).toISOString(),
      conversationId: null,
      phone: null,
      reason: "Dr. Molina López marcó una ausencia con citas agendadas",
      detail: `${hit.length} cita(s) del ${addDaysISO(today, 4)} al ${addDaysISO(today, 5)}: avisa a los pacientes.`,
    });
  }

  db.requests.push({
    id: nextId(db, "s"),
    doctorId: "d3",
    weeklyHours: { mon: [{ start: "10:00", end: "16:00" }], wed: [{ start: "10:00", end: "16:00" }], fri: [{ start: "10:00", end: "16:00" }] },
    effectiveFrom: addDaysISO(today, 14),
    note: "Voy a pasar consulta en otra sede los martes y jueves.",
    status: "pending",
    createdAtUtc: new Date(now.getTime() - 26 * 3600_000).toISOString(),
    decidedBy: null,
    decidedAtUtc: null,
  });

  db.attention.push(
    {
      id: nextId(db, "at"),
      kind: "handoff",
      status: "open",
      createdAtUtc: new Date(now.getTime() - 40 * 60_000).toISOString(),
      conversationId: "conv-demo-1",
      phone: "529980000777",
      reason: "pidio_persona",
      detail: "El paciente pidió hablar con una persona sobre el costo de la consulta.",
    },
    {
      id: nextId(db, "at"),
      kind: "event_failed",
      status: "open",
      createdAtUtc: new Date(now.getTime() - 5 * 3600_000).toISOString(),
      conversationId: "conv-demo-2",
      phone: "529980000888",
      reason: "El modelo no respondió tras 5 intentos",
      detail: null,
    },
    {
      id: nextId(db, "at"),
      kind: "handoff",
      status: "resolved",
      createdAtUtc: new Date(now.getTime() - 30 * 3600_000).toISOString(),
      conversationId: "conv-demo-3",
      phone: "529980000999",
      reason: "fuera_de_alcance",
      detail: "Preguntó por un estudio que la clínica no ofrece.",
    }
  );

  return db;
}
