import { addDaysISO, todayInTz, zonedWallClockToUtc } from "@clinica/calendar/src/lib/slots";
import { daysBetween, isIsoDate, wallClock } from "@clinica/calendar/src/lib/calendar";
import { checkLogo } from "../image";
import { isHexColor, isReadableOnWhite } from "@clinica/calendar/src/lib/doctor-color";
import type { Absence, AttentionItem, Booking, Branding, BookingStatus, Channel, PersonalEvent, Role, ScheduleChangeRequest, WeeklyHours } from "../types";
import { CHANNELS, applyBotChannel, botView, isChannel } from "./bot";
import {
  HttpError,
  asObject,
  badRequest,
  forbidden,
  invalid,
  isoInstant,
  noContent,
  notFound,
  ok,
  optBool,
  optString,
  reqString,
  route,
  rule,
  stateConflict,
  type Ctx,
  type Result,
  type Route,
} from "./http";
import { HORIZON_DAYS, TZ, hoursInside, outsideHours, parseWeeklyHours, placeInSchedule } from "./rules";
import {
  applyBotChanges,
  bookingFor,
  doctorRef,
  doctorView,
  fnv1a,
  hashBytes,
  accountKey,
  nextDoctorCode,
  nextId,
  publicUser,
  type DB,
  type StoredDoctor,
  type StoredPersonalEvent,
  type StoredUser,
} from "./state";

/** Maximo de rango que acepta `GET /api/appointments` (`MAX_RANGE_DAYS` de shared/calendar). */
const MAX_RANGE_DAYS = 92;
/** Donde dice el simulador que vive la app del doctor (en el servidor real es `DOCTOR_APP_URL`). */
export const MOCK_DOCTOR_APP_URL = "https://clinica.test/doctor/";
/** Cuánto dura un enlace para establecer la contraseña (como el servidor: 72 h). */
export const PASSWORD_LINK_HOURS = 72;
/** Cuántos días como máximo se piden de una vez a `listMoveSlots` (la cuadrícula de un mes son 42). */
export const MAX_MOVE_SLOT_DAYS = 42;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_BLOCK_MS = 60_000;

const STAFF: readonly Role[] = ["admin", "staff"];
const ALL: readonly Role[] = ["admin", "staff", "doctor"];
const ADMIN: readonly Role[] = ["admin"];
const DOCTOR: readonly Role[] = ["doctor"];

const PHONE = /^[0-9]{8,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES: BookingStatus[] = ["agendada", "realizada", "no_show", "cancelada"];
const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  agendada: ["realizada", "no_show", "cancelada"],
  realizada: ["no_show"],
  no_show: ["realizada"],
  cancelada: [],
};

type C = Ctx<StoredUser>;
type MockRoute = Route<StoredUser>;

/** El color elegido de un doctor: `null` = automatico; si no, `#rrggbb` con texto blanco legible (igual que el servidor). */
function parseColor(value: unknown): string | null {
  if (value === null) return null;
  if (!isHexColor(value)) throw invalid("color: usa el formato #rrggbb (por ejemplo #1d4ed8) o null para el automático.");
  const hex = value.toLowerCase();
  if (!isReadableOnWhite(hex)) throw invalid("color: es demasiado claro, el texto blanco de las citas no se leería; elige uno más oscuro.");
  return hex;
}

export function buildRoutes(db: DB): MockRoute[] {
  const doctorById = (id: string): StoredDoctor => db.doctors.find((d) => d.id === id) ?? (() => { throw notFound("El doctor no existe."); })();
  const mine = (c: C): StoredDoctor => {
    if (!c.user.doctorId) throw forbidden("Tu usuario no está ligado a un doctor.");
    return doctorById(c.user.doctorId);
  };
  const stamp = (c: C) => ({ decidedBy: c.user.name, decidedAtUtc: c.now.toISOString() });

  /** La marca vigente tal como la sirve la API: `logoUrl` lleva la huella (`?v=`) para que ningun cache confunda versiones. */
  const brandingView = (): Branding => ({
    name: db.branding.name,
    logoUrl: db.branding.logo ? `/api/branding/logo?v=${db.branding.logo.hash}` : null,
  });

  /** Nombre de la clinica: texto de 1 a 80 caracteres, con los espacios normalizados (igual que el servidor). */
  function cleanClinicName(value: unknown): string {
    if (typeof value !== "string") throw invalid("El nombre debe ser texto.");
    const name = value.split(/\s+/).filter(Boolean).join(" ");
    if (!name) throw invalid("Escribe el nombre de la clínica.");
    if (name.length > 80) throw invalid("El nombre admite hasta 80 caracteres.");
    return name;
  }

  /**
   * Abre sesion si `user` existe, esta activo y la contrasena coincide; si no, 401 (el mismo para cualquier fallo). 5 fallos seguidos
   * bloquean la cuenta (`key`: su correo, o lo que se escribio si no hay cuenta) durante un rato.
   */
  function signIn(c: C, key: string, user: StoredUser | undefined, password: string, failMessage: string): Result {
    const now = c.now.getTime();
    const fail = db.loginFailures.get(key);
    if (fail && fail.blockedUntil > now) {
      throw new HttpError(429, "demasiados_intentos", "Demasiados intentos. Espera un minuto e inténtalo de nuevo.");
    }
    // Una cuenta que todavía no tiene contraseña no entra, y esos intentos no cuentan (como en el servidor).
    if (user && user.active && user.password === null) throw new HttpError(401, "credenciales_invalidas", failMessage);
    if (!user || !user.active || user.password !== password) {
      // Un bloqueo ya vencido (blockedUntil != 0) vuelve a contar desde cero.
      const count = (fail && fail.blockedUntil === 0 ? fail.count : 0) + 1;
      db.loginFailures.set(key, { count, blockedUntil: count >= LOGIN_MAX_FAILURES ? now + LOGIN_BLOCK_MS : 0 });
      throw new HttpError(401, "credenciales_invalidas", failMessage);
    }
    db.loginFailures.delete(key);
    return startSession(user);
  }

  /** El rango (`from`, `to`), el consultorio pedido y «cita de mostrador» de una consulta de horarios libres, ya validados. */
  function parseSlotsQuery(c: C) {
    const from = c.query.get("from");
    const to = c.query.get("to");
    if (!isIsoDate(from) || !isIsoDate(to)) throw invalid(`Pide el rango con "from" y "to" (AAAA-MM-DD).`);
    const days = daysBetween(from, to);
    if (days <= 0 || days > MAX_MOVE_SLOT_DAYS) throw rule("rango_invalido", `El rango debe ser de 1 a ${MAX_MOVE_SLOT_DAYS} días.`);
    const shortRaw = c.query.get("allowShortNotice") ?? "false";
    if (shortRaw !== "true" && shortRaw !== "false") throw invalid(`"allowShortNotice" debe ser true o false.`);
    const roomIn = c.query.get("roomId") || undefined;
    if (roomIn && !db.rooms.some((r) => r.id === roomIn)) throw invalid("El consultorio no existe.");
    return { from, days, allowShortNotice: shortRaw === "true", roomIn };
  }

  /** Cada inicio de 7:00 a 19:30 se prueba con `placeInSchedule` (las reglas de verdad, sin tocar nada): los que pasan son los libres. */
  function freeSlots(c: C, q: ReturnType<typeof parseSlotsQuery>, p: { kind: "session" | "block"; doctorId: string | null; durationMinutes: number; roomId?: string; excludeId?: string }) {
    const out: { date: string; slots: string[] }[] = [];
    for (let i = 0; i < q.days; i++) {
      const day = addDaysISO(q.from, i);
      const slots: string[] = [];
      for (let min = 7 * 60; min < 20 * 60; min += 30) {
        const hhmm = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
        const start = zonedWallClockToUtc(day, hhmm, TZ);
        if (!start) continue;
        try {
          placeInSchedule(db, c.now, { ...p, startUtc: start.toISOString(), allowShortNotice: q.allowShortNotice });
          slots.push(hhmm);
        } catch (e) {
          if (!(e instanceof HttpError)) throw e; // una regla incumplida: ese inicio no esta libre
        }
      }
      if (slots.length) out.push({ date: day, slots });
    }
    return { slotMinutes: 30, durationMinutes: p.durationMinutes, days: out };
  }

  /** Abre la sesión de `user` (cookie y token CSRF nuevos). */
  function startSession(user: StoredUser): Result {
    const sid = `${nextId(db, "sess")}-${Math.random().toString(36).slice(2, 10)}`;
    const csrf = `csrf-${Math.random().toString(36).slice(2, 14)}`;
    db.sessions.set(sid, { userId: user.id, csrfTokens: new Set([csrf]) });
    return { ...ok({ user: publicUser(user), csrfToken: csrf }), setSession: sid };
  }

  /** La cuenta de doctor a la que pertenece ese enlace, si sigue vigente; si no, 404 `enlace_invalido` (no existe, venció o ya se usó: es lo mismo). */
  function userForLink(token: unknown, now: Date): StoredUser {
    const user = typeof token === "string" && token ? db.users.find((u) => u.setup?.token === token) : undefined;
    if (!user || user.role !== "doctor" || !user.active || !user.setup || user.setup.expiresAt <= now.getTime()) {
      throw new HttpError(404, "enlace_invalido", "Este enlace ya no sirve. Pide uno nuevo a la clínica.");
    }
    return user;
  }

  /* ------------------------------------------------------------ citas */

  function parseRange(q: URLSearchParams): { from: string; to: string } {
    const from = q.get("from");
    const to = q.get("to");
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      throw rule("rango_invalido", "Pide el rango con from y to (fecha y hora ISO).");
    }
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (span <= 0) throw rule("rango_invalido", "La fecha inicial va antes que la final.");
    if (span > MAX_RANGE_DAYS) throw rule("rango_invalido", `El rango máximo es de ${MAX_RANGE_DAYS} días.`);
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }

  function bookingsList(c: C, scopeDoctorId: string | null): Result {
    const { from, to } = parseRange(c.query);
    const status = c.query.get("status");
    if (status && !STATUSES.includes(status as BookingStatus)) throw invalid(`"status" no es válido.`);
    const doctorId = scopeDoctorId ?? c.query.get("doctorId");
    const roomId = scopeDoctorId ? null : c.query.get("roomId");
    const items = db.bookings
      .filter((b) => b.scheduledAtUtc >= from && b.scheduledAtUtc < to)
      .filter((b) => !doctorId || b.doctor?.id === doctorId)
      .filter((b) => !roomId || b.room?.id === roomId)
      .filter((b) => !status || b.status === status)
      .sort((a, b) => a.scheduledAtUtc.localeCompare(b.scheduledAtUtc) || a.id.localeCompare(b.id))
      .map((b) => bookingFor(c.user.role, b));
    const etag = `W/"${fnv1a(JSON.stringify(items))}"`;
    const sent = c.headers.get("If-None-Match");
    if (sent && sent.split(",").some((t) => t.trim() === etag)) return { status: 304, headers: { ETag: etag } };
    return ok({ items, serverTimeUtc: c.now.toISOString() }, 200, { ETag: etag });
  }

  function newBooking(c: C, b: ReturnType<typeof asObject>): Booking {
    const kind = b.kind ?? "session";
    if (kind !== "session" && kind !== "block") throw invalid(`"kind" debe ser session o block.`);
    const startUtc = isoInstant(b, "scheduledAtUtc");
    const duration = b.durationMinutes === undefined ? 30 : b.durationMinutes;
    if (typeof duration !== "number") throw invalid(`"durationMinutes" debe ser un número.`);
    const notes = optString(b, "notes", 500) ?? null;
    const allowShortNotice = optBool(b, "allowShortNotice") ?? false;
    const roomIdIn = optString(b, "roomId");

    if (kind === "block") {
      if (!roomIdIn) throw invalid("Un bloqueo necesita roomId.");
      if (b.doctorId !== undefined) throw invalid("Un bloqueo no lleva doctor.");
      const { roomId } = placeInSchedule(db, c.now, { kind: "block", startUtc, durationMinutes: duration, doctorId: null, roomId: roomIdIn });
      return {
        id: nextId(db, "b"), kind: "block", status: "agendada", source: "manual", scheduledAtUtc: startUtc, durationMinutes: duration,
        patient: null, doctor: null, room: db.rooms.find((r) => r.id === roomId)!, notes,
      };
    }

    const name = reqString(b, "patientName", 120).replace(/\s+/g, " ");
    if (name.split(" ").length < 2) throw rule("falta_nombre_completo", "Escribe el nombre y el apellido del paciente.");
    const doctorId = reqString(b, "doctorId");
    const phone = optString(b, "phone", 15);
    if (phone !== undefined && !PHONE.test(phone)) throw invalid("El teléfono debe tener entre 8 y 15 dígitos, con lada.");
    const { roomId } = placeInSchedule(db, c.now, { kind: "session", startUtc, durationMinutes: duration, doctorId, roomId: roomIdIn, allowShortNotice });
    const doctor = doctorById(doctorId);
    const id = nextId(db, "b");
    return {
      id, kind: "session", status: "agendada", source: "manual", scheduledAtUtc: startUtc, durationMinutes: duration,
      patient: phone ? { id: phone, name, phone } : { id, name },
      channel: "whatsapp",
      ...(phone ? { contactPhone: phone } : {}),
      doctor: doctorRef(doctor),
      room: db.rooms.find((r) => r.id === roomId)!, notes,
    };
  }

  function patchBooking(c: C): Booking {
    const b = asObject(c.body);
    if (Object.keys(b).length === 0) throw invalid("No hay nada que cambiar.");
    const cur = db.bookings.find((x) => x.id === c.params.appointmentId);
    if (!cur) throw notFound("La cita no existe.");

    const status = b.status as BookingStatus | undefined;
    if (status !== undefined && !STATUSES.includes(status)) throw invalid(`"status" no es válido.`);
    const startIn = b.scheduledAtUtc === undefined ? undefined : isoInstant(b, "scheduledAtUtc");
    const roomIn = optString(b, "roomId");
    const allowShortNotice = optBool(b, "allowShortNotice") ?? false;
    let notes: string | null | undefined;
    if ("notes" in b) {
      if (b.notes === null) notes = null;
      else notes = optString(b, "notes", 500);
    }

    const changesStatus = status !== undefined && status !== cur.status;
    if (changesStatus) {
      const allowed = cur.kind === "block" ? (cur.status === "agendada" ? (["cancelada"] as BookingStatus[]) : []) : TRANSITIONS[cur.status];
      if (!allowed.includes(status!)) {
        throw stateConflict(`No se puede pasar de "${cur.status}" a "${status}".`);
      }
    }

    const moves = startIn !== undefined || roomIn !== undefined;
    let next: { start: string; room: { id: string; name: string } } | null = null;
    if (moves) {
      if (cur.status !== "agendada" || (status !== undefined && status !== "agendada")) {
        throw stateConflict("Solo se puede mover una cita agendada.");
      }
      const start = startIn ?? cur.scheduledAtUtc;
      const base = {
        kind: cur.kind, startUtc: start, durationMinutes: cur.durationMinutes, doctorId: cur.doctor?.id ?? null,
        excludeId: cur.id, allowShortNotice,
      };
      let roomId: string;
      if (roomIn) roomId = placeInSchedule(db, c.now, { ...base, roomId: roomIn }).roomId;
      else {
        // Sin consultorio pedido se prefiere el actual; si esta ocupado, cualquiera libre.
        try {
          roomId = placeInSchedule(db, c.now, { ...base, roomId: cur.room?.id }).roomId;
        } catch (e) {
          if (!(e instanceof HttpError) || e.status !== 409) throw e;
          roomId = placeInSchedule(db, c.now, base).roomId;
        }
      }
      next = { start, room: db.rooms.find((r) => r.id === roomId)! };
    }

    // Todo validado: recien ahora se escribe (si algo fallo arriba, la cita queda intacta).
    if (next) {
      cur.scheduledAtUtc = next.start;
      cur.room = { ...next.room };
    }
    if (changesStatus) cur.status = status!;
    if (notes !== undefined) cur.notes = notes;
    return cur;
  }

  /* --------------------------------------------------------- doctores */

  function applyHours(doc: StoredDoctor, hours: WeeklyHours | null, now: Date) {
    if (hours !== null && !hoursInside(hours, db.clinicHours)) {
      throw rule("fuera_de_horario", "El horario del doctor debe quedar dentro del de la clínica.");
    }
    const effective = hours ?? db.clinicHours;
    const affected = outsideHours(db, doc.id, effective, now);
    doc.ownHours = hours === null ? null : structuredClone(hours);
    return affected;
  }

  function absenceInput(b: ReturnType<typeof asObject>): { startUtc: string; endUtc: string; reason: string | null } {
    const startUtc = isoInstant(b, "startUtc");
    const endUtc = isoInstant(b, "endUtc");
    if (Date.parse(endUtc) <= Date.parse(startUtc)) throw rule("rango_invalido", "La ausencia debe terminar después de empezar.");
    return { startUtc, endUtc, reason: optString(b, "reason", 200) || null };
  }

  const affectedBy = (doctorId: string, a: { startUtc: string; endUtc: string }): Booking[] =>
    db.bookings.filter(
      (x) =>
        x.kind === "session" && x.status === "agendada" && x.doctor?.id === doctorId &&
        Date.parse(x.scheduledAtUtc) < Date.parse(a.endUtc) && Date.parse(a.startUtc) < Date.parse(x.scheduledAtUtc) + x.durationMinutes * 60_000
    );

  function addAbsence(doctorId: string, a: { startUtc: string; endUtc: string; reason: string | null }): Absence {
    const absence: Absence = { id: nextId(db, "a"), doctorId, ...a };
    db.absences.push(absence);
    return absence;
  }

  /* ------------------------------------------- eventos personales del doctor */

  const EVENT_MAX_MS = 24 * 3_600_000; // mas largo (varios dias) es una ausencia
  const EVENT_WINDOW_MS = 400 * 86_400_000;

  /** La forma que ve su dueno (sin `doctorId`): con titulo y notas. */
  const eventView = ({ id, title, notes, startUtc, endUtc }: StoredPersonalEvent): PersonalEvent => ({ id, title, notes, startUtc, endUtc });

  function checkEventSpan(c: C, startUtc: string, endUtc: string) {
    const s = Date.parse(startUtc);
    const e = Date.parse(endUtc);
    if (e <= s) throw invalid("El evento debe terminar después de empezar.");
    if (e - s > EVENT_MAX_MS) throw invalid("Un evento dura como máximo 24 horas; para varios días marca una ausencia.");
    if (Math.abs(s - c.now.getTime()) > EVENT_WINDOW_MS) throw invalid("La fecha está fuera de rango.");
  }

  /** Un evento no puede caer sobre una cita agendada del doctor (hay que mover la cita primero). */
  function rejectIfSession(doctorId: string, startUtc: string, endUtc: string) {
    if (affectedBy(doctorId, { startUtc, endUtc }).length) {
      throw new HttpError(409, "evento_con_cita", "Ya tienes una cita agendada en ese horario. Pide a recepción que la mueva y vuelve a intentarlo.");
    }
  }

  const eventNotes = (b: ReturnType<typeof asObject>): string | null => (b.notes === null ? null : optString(b, "notes", 1000) || null);
  const eventTitle = (b: ReturnType<typeof asObject>): string => reqString(b, "title", 120).replace(/\s+/g, " ");

  function decide(c: C, status: "approved" | "rejected", note?: string): { req: ScheduleChangeRequest; affected: Booking[] } {
    const req = db.requests.find((r) => r.id === c.params.requestId);
    if (!req) throw notFound("La solicitud no existe.");
    if (req.status !== "pending") throw stateConflict("La solicitud ya fue resuelta.");
    const affected = status === "approved" ? applyHours(doctorById(req.doctorId), req.weeklyHours, c.now) : [];
    Object.assign(req, { status, ...stamp(c) });
    if (note) req.note = [req.note, `Respuesta: ${note}`].filter(Boolean).join(" · ");
    return { req, affected };
  }

  /* --------------------------------------------------------- usuarios */

  function checkUserShape(role: Role, doctorId: string | null | undefined): string | null {
    if (role === "doctor") {
      if (!doctorId) throw invalid("Un usuario doctor debe ligarse a un doctor (doctorId).");
      if (!db.doctors.some((d) => d.id === doctorId)) throw invalid("El doctor no existe.");
      return doctorId;
    }
    if (doctorId) throw invalid("Solo un usuario con rol doctor lleva doctorId.");
    return null;
  }

  const parsePassword = (b: ReturnType<typeof asObject>): string | undefined => {
    const p = b.password;
    if (p === undefined) return undefined;
    if (typeof p !== "string" || p.length < 10) throw invalid("La contraseña debe tener al menos 10 caracteres.");
    return p;
  };

  const parseRole = (v: unknown): Role => {
    if (v !== "admin" && v !== "staff" && v !== "doctor") throw invalid(`"role" debe ser admin, staff o doctor.`);
    return v;
  };

  /* ------------------------------------------------------------ rutas */

  return [
    route<StoredUser>("health", null, () => ok({ status: "ok" })),

    /* ------------------------------------------- marca de la clinica (nombre y logotipo) */

    // Leer es PUBLICO (el login la muestra). Cambiar, solo el administrador.
    route<StoredUser>("getBranding", null, () => ok(brandingView())),

    route<StoredUser>("getBrandingLogo", null, (c) => {
      const logo = db.branding.logo;
      if (!logo) throw notFound("No hay logotipo.");
      const etag = `"${logo.hash}"`;
      const headers = { ETag: etag, "Cache-Control": "public, max-age=86400" };
      if ((c.headers.get("If-None-Match") ?? "").split(",").some((t) => t.trim() === etag)) return { status: 304, headers };
      return { status: 200, binary: { bytes: logo.bytes, contentType: logo.contentType }, headers };
    }),

    route<StoredUser>("setBranding", ADMIN, (c) => {
      db.branding.name = cleanClinicName(asObject(c.body).name);
      return ok(brandingView());
    }),

    // Se valida por los BYTES (igual que el servidor): PNG/JPG/WebP, cuadrada (1:1), 64 a 2048 px, hasta 1 MB.
    route<StoredUser>("uploadBrandingLogo", ADMIN, (c) => {
      const bytes = c.rawBody ?? new Uint8Array();
      const check = checkLogo(bytes);
      if (!check.ok) throw invalid(check.message);
      db.branding.logo = { contentType: check.info.contentType, bytes: new Uint8Array(bytes), hash: hashBytes(bytes) };
      return ok(brandingView());
    }),

    route<StoredUser>("deleteBrandingLogo", ADMIN, () => {
      db.branding.logo = null;
      return ok(brandingView());
    }),

    route<StoredUser>("login", null, (c) => {
      const b = asObject(c.body);
      const email = reqString(b, "email", 254).toLowerCase();
      const password = typeof b.password === "string" ? b.password : "";
      return signIn(c, email, db.users.find((u) => u.email?.toLowerCase() === email), password, "Correo o contraseña incorrectos.");
    }),

    // La lista de la pantalla de entrada del doctor: PUBLICA, solo codigo y nombre de quienes tienen una cuenta activa Y con contrasena, por codigo.
    route<StoredUser>("listLoginDoctors", null, () => {
      const withAccount = db.doctors.filter((d) => db.users.some((u) => u.role === "doctor" && u.active && u.password !== null && u.doctorId === d.id));
      return ok({ items: withAccount.sort((a, b) => a.code.localeCompare(b.code)).map((d) => ({ code: d.code, name: d.name })) });
    }),

    // Entrada del doctor con su codigo (sin correo). Solo cuentas de doctor; un codigo desconocido y una contrasena mala son el mismo 401.
    route<StoredUser>("doctorLogin", null, (c) => {
      const b = asObject(c.body);
      const code = reqString(b, "doctorCode", 20);
      const password = typeof b.password === "string" ? b.password : "";
      const doctor = /^[0-9]{4}$/.test(code) ? db.doctors.find((d) => d.code === code) : undefined;
      const user = doctor ? db.users.find((u) => u.role === "doctor" && u.active && u.doctorId === doctor.id) : undefined;
      // El contador es de la CUENTA (como en el servidor): entrar por codigo o por correo suma igual.
      return signIn(c, user ? accountKey(user) : `codigo:${code}`, user, password, "Usuario o contraseña incorrectos.");
    }),

    // La pagina del enlace: de quien es y hasta cuando vale. No cambia nada.
    route<StoredUser>("checkPasswordLink", null, (c) => {
      const user = userForLink(asObject(c.body).token, c.now);
      const doctor = doctorById(user.doctorId!);
      return ok({ doctorCode: doctor.code, doctorName: doctor.name, expiresAtUtc: new Date(user.setup!.expiresAt).toISOString() });
    }),

    // El doctor establece su contrasena con el enlace (un solo uso) y entra de una vez. Una contrasena que no cumple NO gasta el enlace.
    route<StoredUser>("usePasswordLink", null, (c) => {
      const b = asObject(c.body);
      const token = reqString(b, "token", 200);
      const password = parsePassword(b);
      if (!password) throw invalid(`Falta "password".`);
      const user = userForLink(token, c.now);
      user.password = password;
      user.setup = null;
      db.loginFailures.delete(accountKey(user)); // quita cualquier bloqueo
      for (const [sid, s] of db.sessions) if (s.userId === user.id) db.sessions.delete(sid); // la contrasena cambio: nada anterior sirve
      return startSession(user);
    }),

    route<StoredUser>("logout", ALL, () => ({ ...noContent(), setSession: null })),

    route<StoredUser>("me", ALL, (c) => {
      const csrf = `csrf-${Math.random().toString(36).slice(2, 14)}`;
      db.sessions.get(c.sessionId!)?.csrfTokens.add(csrf);
      return ok({ user: publicUser(c.user), csrfToken: csrf });
    }),

    route<StoredUser>("listAppointments", STAFF, (c) => bookingsList(c, null)),

    route<StoredUser>("createAppointment", STAFF, (c) => {
      const booking = newBooking(c, asObject(c.body));
      db.bookings.push(booking);
      return ok(bookingFor(c.user.role, booking), 201);
    }),

    route<StoredUser>("getAppointment", STAFF, (c) => {
      const b = db.bookings.find((x) => x.id === c.params.appointmentId);
      if (!b) throw notFound("La cita no existe.");
      return ok(bookingFor(c.user.role, b));
    }),

    route<StoredUser>("updateAppointment", STAFF, (c) => ok(bookingFor(c.user.role, patchBooking(c)))),

    // Los horarios libres a los que se puede mover una cita: se prueba cada inicio con LAS MISMAS reglas que el movimiento (`placeInSchedule`,
    // sin tocar nada), asi que lo que sale es exactamente lo que `updateAppointment` aceptaria. Su propio horario cuenta como libre.
    route<StoredUser>("listMoveSlots", STAFF, (c) => {
      const cur = db.bookings.find((x) => x.id === c.params.appointmentId);
      if (!cur) throw notFound("La cita no existe.");
      const q = parseSlotsQuery(c);
      if (cur.status !== "agendada") throw stateConflict("Solo se puede mover una cita agendada.");
      return ok(freeSlots(c, q, {
        kind: cur.kind, doctorId: cur.doctor?.id ?? null, durationMinutes: cur.durationMinutes,
        roomId: q.roomIn ?? (cur.kind === "block" ? cur.room?.id : undefined), // un bloqueo se queda en su consultorio
        excludeId: cur.id,
      }));
    }),

    // Lo mismo para una cita (o bloqueo) NUEVA, la que se llena en «Nueva cita»: lo que `createAppointment` aceptaria.
    route<StoredUser>("listAvailability", STAFF, (c) => {
      const q = parseSlotsQuery(c);
      const kindRaw = c.query.get("kind") ?? "session";
      if (kindRaw !== "session" && kindRaw !== "block") throw invalid(`"kind" debe ser session o block.`);
      const durRaw = c.query.get("durationMinutes");
      const durationMinutes = durRaw === null || durRaw === "" ? 30 : Number(durRaw);
      if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes % 30 !== 0 || durationMinutes > 1440) {
        throw invalid("La duración debe ser múltiplo de 30 minutos (hasta 24 h).");
      }
      const doctorId = c.query.get("doctorId") || null;
      if (kindRaw === "block") {
        if (doctorId) throw invalid("Un bloqueo de consultorio no lleva doctor.");
        if (!q.roomIn) throw invalid("Un bloqueo de consultorio exige consultorio.");
      } else if (!doctorId || !db.doctors.some((d) => d.id === doctorId)) {
        throw invalid("El doctor no existe o no se indicó.");
      }
      return ok(freeSlots(c, q, { kind: kindRaw, doctorId, durationMinutes, roomId: q.roomIn }));
    }),

    route<StoredUser>("listRooms", ALL, () => ok({ items: structuredClone(db.rooms) })),

    route<StoredUser>("getClinicHours", ALL, () => ok(structuredClone(db.clinicHours))),

    route<StoredUser>("setClinicHours", STAFF, (c) => {
      const hours = parseWeeklyHours(c.body, "El horario de la clínica");
      const outside = db.doctors.find((d) => d.ownHours && !hoursInside(d.ownHours, hours));
      if (outside) throw rule("fuera_de_horario", `El horario de ${outside.name} quedaría fuera del de la clínica.`);
      db.clinicHours = hours;
      return ok(structuredClone(hours));
    }),

    route<StoredUser>("listDoctors", ALL, (c) => {
      const list = c.user.role === "doctor" ? db.doctors.filter((d) => d.id === c.user.doctorId) : db.doctors;
      return ok({ items: list.map((d) => doctorView(db, d)) });
    }),

    route<StoredUser>("createDoctor", STAFF, (c) => {
      const b = asObject(c.body);
      const aliases = b.aliases === undefined ? [] : b.aliases;
      if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== "string")) throw invalid(`"aliases" debe ser una lista de textos.`);
      const color = b.color === undefined ? null : parseColor(b.color);
      const doc: StoredDoctor = {
        id: nextId(db, "d"), code: nextDoctorCode(db), name: reqString(b, "name", 120), specialty: reqString(b, "specialty", 120),
        aliases: (aliases as string[]).map((a) => a.trim()).filter(Boolean), active: optBool(b, "active") ?? true, ownHours: null, color,
      };
      db.doctors.push(doc);
      // Su cuenta nace con el doctor: sin correo y SIN contraseña (la establece con el enlace que genera el personal).
      db.users.push({ id: nextId(db, "u"), email: null, name: doc.name, role: "doctor", doctorId: doc.id, active: true, password: null });
      return ok(doctorView(db, doc), 201);
    }),

    route<StoredUser>("updateDoctor", STAFF, (c) => {
      const doc = doctorById(c.params.doctorId!);
      const b = asObject(c.body);
      const name = optString(b, "name", 120);
      const specialty = optString(b, "specialty", 120);
      const active = optBool(b, "active");
      if (name === "" || specialty === "") throw invalid("El nombre y la especialidad no pueden quedar vacíos.");
      if (b.aliases !== undefined && (!Array.isArray(b.aliases) || b.aliases.some((a) => typeof a !== "string"))) {
        throw invalid(`"aliases" debe ser una lista de textos.`);
      }
      const color = "color" in b ? parseColor(b.color) : undefined; // null = volver al automatico; se valida antes de tocar nada
      if (name !== undefined) doc.name = name;
      if (specialty !== undefined) doc.specialty = specialty;
      if (active !== undefined) doc.active = active;
      if (color !== undefined) doc.color = color;
      if (b.aliases !== undefined) doc.aliases = (b.aliases as string[]).map((a) => a.trim()).filter(Boolean);
      // Las citas ya agendadas llevan una copia del nombre: se mantiene al dia. Y el nombre de su cuenta sigue al del doctor.
      for (const x of db.bookings) if (x.doctor?.id === doc.id) x.doctor = doctorRef(doc);
      if (name !== undefined) for (const u of db.users) if (u.role === "doctor" && u.doctorId === doc.id) u.name = name;
      return ok(doctorView(db, doc));
    }),

    // Eliminar de verdad: solo el administrador y solo si nunca tuvo citas ni una cuenta con contraseña (la cuenta recien creada, sin usar,
    // se elimina con el doctor); si no, se da de baja.
    route<StoredUser>("deleteDoctor", ADMIN, (c) => {
      const doc = doctorById(c.params.doctorId!);
      if (db.bookings.some((x) => x.doctor?.id === doc.id)) {
        throw new HttpError(409, "doctor_con_citas", "Este doctor tiene citas en el historial: no se puede eliminar. Dalo de baja para que deje de ofrecerse.");
      }
      if (db.users.some((u) => u.doctorId === doc.id && u.password !== null)) {
        throw new HttpError(409, "doctor_con_usuario", "Este doctor ya tiene una cuenta con contraseña en uso: no se puede eliminar. Dalo de baja (o desactiva su cuenta en Usuarios).");
      }
      db.users = db.users.filter((u) => u.doctorId !== doc.id);
      db.doctors.splice(db.doctors.indexOf(doc), 1);
      db.absences = db.absences.filter((a) => a.doctorId !== doc.id);
      db.personalEvents = db.personalEvents.filter((ev) => ev.doctorId !== doc.id);
      db.requests = db.requests.filter((r) => r.doctorId !== doc.id);
      return noContent();
    }),

    // El enlace para que un doctor establezca su contrasena (la primera vez, o una nueva si la olvido): de un solo uso, 72 h, reemplaza al anterior.
    route<StoredUser>("createPasswordLink", STAFF, (c) => {
      const doc = doctorById(c.params.doctorId!);
      let user = db.users.find((u) => u.role === "doctor" && u.doctorId === doc.id);
      if (!user) {
        user = { id: nextId(db, "u"), email: null, name: doc.name, role: "doctor", doctorId: doc.id, active: true, password: null };
        db.users.push(user);
      } else if (!user.active) {
        throw invalid("La cuenta de este doctor está desactivada: un administrador debe reactivarla en Usuarios.");
      }
      const token = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10).padEnd(8, "x")).join("");
      const expiresAt = c.now.getTime() + PASSWORD_LINK_HOURS * 3600_000;
      user.setup = { token, expiresAt };
      return ok({ url: `${MOCK_DOCTOR_APP_URL}#/contrasena?t=${token}`, expiresAtUtc: new Date(expiresAt).toISOString() });
    }),

    route<StoredUser>("setDoctorWeeklyHours", STAFF, (c) => {
      const doc = doctorById(c.params.doctorId!);
      const b = asObject(c.body);
      if (!("weeklyHours" in b)) throw invalid(`Falta "weeklyHours" (un horario o null).`);
      const hours = b.weeklyHours === null ? null : parseWeeklyHours(b.weeklyHours, "El horario del doctor");
      const affected = applyHours(doc, hours, c.now);
      return ok({ doctor: doctorView(db, doc), affectedAppointments: affected.map((x) => bookingFor(c.user.role, x)) });
    }),

    route<StoredUser>("listDoctorAbsences", STAFF, (c) => {
      const doc = doctorById(c.params.doctorId!);
      const from = c.query.get("from");
      const to = c.query.get("to");
      const items = db.absences
        .filter((a) => a.doctorId === doc.id)
        .filter((a) => !from || a.endUtc > new Date(from).toISOString())
        .filter((a) => !to || a.startUtc < new Date(to).toISOString())
        .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
      return ok({ items });
    }),

    route<StoredUser>("listAbsences", STAFF, (c) => {
      const from = c.query.get("from"), to = c.query.get("to");
      if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(to) <= Date.parse(from))
        throw invalid(`Se requieren "from" y "to" (instantes) con from < to.`);
      const lo = new Date(from).toISOString(), hi = new Date(to).toISOString();
      return ok({ items: db.absences.filter((a) => a.endUtc > lo && a.startUtc < hi).sort((a, b) => a.startUtc.localeCompare(b.startUtc)) });
    }),

    // Lo que el personal sabe de un evento personal: SOLO que el doctor esta ocupado (nunca el titulo ni las notas).
    route<StoredUser>("listBusyTimes", STAFF, (c) => {
      const { from, to } = parseRange(c.query);
      const items = db.personalEvents
        .filter((ev) => ev.endUtc > from && ev.startUtc < to)
        .sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.id.localeCompare(b.id))
        .map(({ id, doctorId, startUtc, endUtc }) => ({ id, doctorId, startUtc, endUtc }));
      return ok({ items });
    }),

    route<StoredUser>("createDoctorAbsence", STAFF, (c) => {
      const doc = doctorById(c.params.doctorId!);
      const input = absenceInput(asObject(c.body));
      const absence = addAbsence(doc.id, input);
      return ok({ absence, affectedAppointments: affectedBy(doc.id, input).map((x) => bookingFor(c.user.role, x)) }, 201);
    }),

    route<StoredUser>("deleteDoctorAbsence", STAFF, (c) => {
      const i = db.absences.findIndex((a) => a.id === c.params.absenceId && a.doctorId === c.params.doctorId);
      if (i < 0) throw notFound("La ausencia no existe.");
      db.absences.splice(i, 1);
      return noContent();
    }),

    route<StoredUser>("listScheduleChangeRequests", STAFF, (c) => {
      const status = c.query.get("status");
      if (status && !["pending", "approved", "rejected"].includes(status)) throw invalid(`"status" no es válido.`);
      return ok({ items: db.requests.filter((r) => !status || r.status === status).sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc)) });
    }),

    route<StoredUser>("approveScheduleChange", STAFF, (c) => {
      const { req, affected } = decide(c, "approved");
      return ok({ ...req, affectedAppointments: affected.map((x) => bookingFor(c.user.role, x)) });
    }),

    route<StoredUser>("rejectScheduleChange", STAFF, (c) => {
      const note = c.body === undefined ? undefined : optString(asObject(c.body), "note", 500);
      return ok(decide(c, "rejected", note).req);
    }),

    route<StoredUser>("getBotSettings", STAFF, (c) => ok(botView(db, c.now))),

    route<StoredUser>("setBotSettings", STAFF, (c) => {
      const b = asObject(c.body);
      // Tres formas, como el servidor: `{channel, active?, mode?, schedule?}` (un canal), `{channels}` (varios; solo los que vienen) y
      // `{active}` (la forma vieja: SOLO WhatsApp). Lo invalido de las formas nuevas es 400; en la vieja sigue siendo 422.
      let changes: Partial<Record<Channel, boolean>>;
      if ("channels" in b) {
        const ch = b.channels;
        if (Object.keys(b).some((k) => k !== "channels")) throw badRequest(`use "channels" solo, o "channel" con "active", "mode" o "schedule"`);
        if (typeof ch !== "object" || ch === null || Array.isArray(ch) || Object.keys(ch).length === 0) {
          throw badRequest(`"channels" debe ser un objeto con al menos un canal: ${CHANNELS.join(", ")}`);
        }
        changes = {};
        for (const [name, value] of Object.entries(ch)) {
          if (!isChannel(name)) throw badRequest(`canal desconocido; debe ser uno de: ${CHANNELS.join(", ")}`);
          if (typeof value !== "boolean") throw badRequest(`el valor de "${name}" debe ser verdadero o falso`);
          changes[name] = value;
        }
      } else if ("channel" in b) {
        if (!isChannel(b.channel)) throw badRequest(`canal desconocido; debe ser uno de: ${CHANNELS.join(", ")}`);
        if (Object.keys(b).some((k) => !["channel", "active", "mode", "schedule"].includes(k))) throw badRequest("campos desconocidos en la peticion");
        applyBotChannel(db, b.channel, b, c.now, c.user.name);
        return ok(botView(db, c.now));
      } else {
        if (typeof b.active !== "boolean") throw invalid(`"active" debe ser verdadero o falso.`);
        changes = { whatsapp: b.active };
      }
      applyBotChanges(db, changes, c.now, c.user.name);
      return ok(botView(db, c.now));
    }),

    route<StoredUser>("listAttention", STAFF, (c) => {
      const status = c.query.get("status") ?? "open";
      if (status !== "open" && status !== "resolved") throw invalid(`"status" debe ser open o resolved.`);
      // paginacion opcional, igual que el servidor: `limit` 1 a 100, `offset` desde 0 y solo junto con `limit`
      const intParam = (name: string, lo: number, hi?: number): number | undefined => {
        const raw = c.query.get(name);
        if (raw === null || raw === "") return undefined;
        const n = Number(raw);
        if (!Number.isInteger(n)) throw invalid(`${name}: debe ser un entero`);
        if (n < lo || (hi !== undefined && n > hi)) throw invalid(hi !== undefined ? `${name}: debe estar entre ${lo} y ${hi}` : `${name}: debe ser ${lo} o más`);
        return n;
      };
      const limit = intParam("limit", 1, 100);
      const offset = intParam("offset", 0);
      if (offset && limit === undefined) throw invalid("offset: solo se admite junto con limit");
      const channel = c.query.get("channel");
      if (channel !== null && !isChannel(channel)) throw invalid(`"channel" debe ser ${CHANNELS.join(" | ")}.`);
      const all = db.attention
        .filter((a) => a.status === status && (channel === null || (a.channel ?? "whatsapp") === channel))
        .sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc));
      return ok({ items: limit === undefined ? all : all.slice(offset ?? 0, (offset ?? 0) + limit), total: all.length });
    }),

    route<StoredUser>("resolveAttention", STAFF, (c) => {
      const item = db.attention.find((a) => a.id === c.params.attentionId);
      if (!item) throw notFound("El caso no existe.");
      item.status = "resolved";
      return ok(item);
    }),

    route<StoredUser>("listUsers", ADMIN, () => ok({ items: db.users.map(publicUser) })),

    route<StoredUser>("createUser", ADMIN, (c) => {
      const b = asObject(c.body);
      const email = reqString(b, "email", 254).toLowerCase();
      if (!EMAIL.test(email)) throw invalid("El correo no es válido.");
      if (db.users.some((u) => u.email?.toLowerCase() === email)) throw invalid("Ya existe un usuario con ese correo.");
      const role = parseRole(b.role);
      if (role === "doctor") {
        throw invalid("Aquí solo se crean usuarios de personal y administrador. La cuenta de un doctor se crea sola al darlo de alta; en «Datos» del doctor se genera el enlace para que establezca su contraseña.");
      }
      const password = parsePassword(b);
      if (!password) throw invalid(`Falta "password".`);
      const doctorId = checkUserShape(role, typeof b.doctorId === "string" ? b.doctorId : undefined);
      const user: StoredUser = { id: nextId(db, "u"), email, name: reqString(b, "name", 120), role, doctorId, active: true, password };
      db.users.push(user);
      return ok(publicUser(user), 201);
    }),

    route<StoredUser>("updateUser", ADMIN, (c) => {
      const b = asObject(c.body);
      if (Object.keys(b).length === 0) throw invalid("No hay nada que cambiar.");
      const user = db.users.find((u) => u.id === c.params.userId);
      if (!user) throw notFound("El usuario no existe.");
      const name = optString(b, "name", 120);
      if (name === "") throw invalid("El nombre no puede quedar vacío.");
      const role = b.role === undefined ? user.role : parseRole(b.role);
      const active = optBool(b, "active");
      const password = parsePassword(b);
      if (b.doctorId !== undefined && b.doctorId !== null && typeof b.doctorId !== "string") throw invalid(`"doctorId" debe ser texto o null.`);
      const doctorIn = b.doctorId === undefined ? (role === user.role ? user.doctorId : null) : b.doctorId;
      if (user.id === c.user.id && (role !== user.role || active === false)) {
        throw invalid("No puedes quitarte el acceso ni cambiar tu propio rol.");
      }
      const doctorId = checkUserShape(role, doctorIn);
      if (name !== undefined) user.name = name;
      user.role = role;
      user.doctorId = doctorId;
      if (active !== undefined) user.active = active;
      if (password) user.password = password;
      if (!user.active) for (const [sid, s] of db.sessions) if (s.userId === user.id) db.sessions.delete(sid);
      return ok(publicUser(user));
    }),

    /* ----------------------------------------------- PWA del doctor */

    route<StoredUser>("doctorAppointments", DOCTOR, (c) => bookingsList(c, mine(c).id)),

    route<StoredUser>("doctorHours", DOCTOR, (c) => ok(doctorView(db, mine(c)))),

    route<StoredUser>("doctorListAbsences", DOCTOR, (c) => {
      const doc = mine(c);
      return ok({ items: db.absences.filter((a) => a.doctorId === doc.id).sort((a, b) => a.startUtc.localeCompare(b.startUtc)) });
    }),

    route<StoredUser>("doctorCreateAbsence", DOCTOR, (c) => {
      const doc = mine(c);
      const input = absenceInput(asObject(c.body));
      const absence = addAbsence(doc.id, input);
      const affected = affectedBy(doc.id, input);
      if (affected.length) {
        const item: AttentionItem = {
          id: nextId(db, "at"), kind: "absence_affects_appointments", status: "open", createdAtUtc: c.now.toISOString(),
          conversationId: null, channel: "whatsapp", contactId: null, phone: null,
          reason: `${doc.name} marcó una ausencia con citas agendadas`,
          detail: `${affected.length} cita(s) entre el ${wallClock(input.startUtc, TZ).day} y el ${wallClock(input.endUtc, TZ).day}: avisa a los pacientes.`,
        };
        db.attention.push(item);
      }
      return ok({ absence, affectedCount: affected.length }, 201);
    }),

    route<StoredUser>("doctorDeleteAbsence", DOCTOR, (c) => {
      const doc = mine(c);
      const i = db.absences.findIndex((a) => a.id === c.params.absenceId && a.doctorId === doc.id);
      if (i < 0) throw notFound("La ausencia no existe.");
      db.absences.splice(i, 1);
      return noContent();
    }),

    route<StoredUser>("doctorListPersonalEvents", DOCTOR, (c) => {
      const doc = mine(c);
      const { from, to } = parseRange(c.query);
      const items = db.personalEvents
        .filter((ev) => ev.doctorId === doc.id && ev.endUtc > from && ev.startUtc < to)
        .sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.id.localeCompare(b.id))
        .map(eventView);
      return ok({ items });
    }),

    route<StoredUser>("doctorCreatePersonalEvent", DOCTOR, (c) => {
      const doc = mine(c);
      const b = asObject(c.body);
      const title = eventTitle(b);
      const notes = eventNotes(b);
      const startUtc = isoInstant(b, "startUtc");
      const endUtc = isoInstant(b, "endUtc");
      checkEventSpan(c, startUtc, endUtc);
      rejectIfSession(doc.id, startUtc, endUtc);
      const ev: StoredPersonalEvent = { id: nextId(db, "pe"), doctorId: doc.id, title, notes, startUtc, endUtc };
      db.personalEvents.push(ev);
      return ok(eventView(ev), 201);
    }),

    // Parche: solo cambia lo que se manda. Ajeno o inexistente = 404 (no se distingue).
    route<StoredUser>("doctorUpdatePersonalEvent", DOCTOR, (c) => {
      const doc = mine(c);
      const b = asObject(c.body);
      if (!["title", "notes", "startUtc", "endUtc"].some((k) => k in b)) throw invalid("No hay nada que cambiar.");
      const ev = db.personalEvents.find((x) => x.id === c.params.eventId && x.doctorId === doc.id);
      if (!ev) throw notFound("El evento no existe.");
      const title = "title" in b ? eventTitle(b) : ev.title;
      const notes = "notes" in b ? eventNotes(b) : ev.notes;
      const startUtc = "startUtc" in b ? isoInstant(b, "startUtc") : ev.startUtc;
      const endUtc = "endUtc" in b ? isoInstant(b, "endUtc") : ev.endUtc;
      if (startUtc !== ev.startUtc || endUtc !== ev.endUtc) {
        checkEventSpan(c, startUtc, endUtc);
        rejectIfSession(doc.id, startUtc, endUtc);
      }
      Object.assign(ev, { title, notes, startUtc, endUtc });
      return ok(eventView(ev));
    }),

    route<StoredUser>("doctorDeletePersonalEvent", DOCTOR, (c) => {
      const doc = mine(c);
      const i = db.personalEvents.findIndex((x) => x.id === c.params.eventId && x.doctorId === doc.id);
      if (i < 0) throw notFound("El evento no existe.");
      db.personalEvents.splice(i, 1);
      return noContent();
    }),

    route<StoredUser>("doctorListScheduleChanges", DOCTOR, (c) => {
      const doc = mine(c);
      return ok({ items: db.requests.filter((r) => r.doctorId === doc.id).sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc)) });
    }),

    route<StoredUser>("doctorCreateScheduleChange", DOCTOR, (c) => {
      const doc = mine(c);
      const b = asObject(c.body);
      const weeklyHours = parseWeeklyHours(b.weeklyHours, "El horario solicitado");
      if (!hoursInside(weeklyHours, db.clinicHours)) throw rule("fuera_de_horario", "El horario debe quedar dentro del de la clínica.");
      const effectiveFrom = reqString(b, "effectiveFrom", 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw invalid(`"effectiveFrom" debe ser una fecha AAAA-MM-DD.`);
      if (effectiveFrom <= todayInTz(c.now, TZ) || effectiveFrom > addDaysISO(todayInTz(c.now, TZ), HORIZON_DAYS * 3)) {
        throw invalid("La fecha de inicio debe ser futura.");
      }
      const req: ScheduleChangeRequest = {
        id: nextId(db, "s"), doctorId: doc.id, weeklyHours, effectiveFrom, note: optString(b, "note", 500) || null,
        status: "pending", createdAtUtc: c.now.toISOString(), decidedBy: null, decidedAtUtc: null,
      };
      db.requests.push(req);
      return ok(req, 201);
    }),

    // Solo una solicitud MIA y pendiente: ajena o inexistente = 404 (no se distingue); ya resuelta = 409.
    route<StoredUser>("doctorDeleteScheduleChange", DOCTOR, (c) => {
      const doc = mine(c);
      const i = db.requests.findIndex((r) => r.id === c.params.requestId && r.doctorId === doc.id);
      if (i < 0) throw notFound("La solicitud no existe.");
      if (db.requests[i]!.status !== "pending") throw stateConflict("la solicitud ya fue resuelta por el personal: ya no se puede eliminar");
      db.requests.splice(i, 1);
      return noContent();
    }),

    route<StoredUser>("doctorSubscribePush", DOCTOR, (c) => {
      const b = asObject(c.body);
      reqString(b, "endpoint", 2000);
      asObject(b.keys, "keys");
      return noContent();
    }),

    route<StoredUser>("doctorUnsubscribePush", DOCTOR, (c) => {
      reqString(asObject(c.body), "endpoint", 2000);
      return noContent();
    }),
  ];
}
