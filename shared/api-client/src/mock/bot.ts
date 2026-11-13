import type { AttentionItem, Booking, Channel } from "../types";
import { HttpError, badRequest, invalid } from "./http";
import { TZ, nextFreeSlot } from "./rules";
import { nextId, type DB } from "./state";
import { todayInTz } from "@clinica/calendar/src/lib/slots";

/**
 * Lo que hace el bot contra la API, como funciones del simulador (el simulador no expone `/api/bot/*` por HTTP): la identidad de quien
 * escribe, el aislamiento entre canales y `telefono_contacto`. Las mismas reglas que `server/app/api/bot.py`:
 *
 * - La identidad es (canal, clave): `telefono` en WhatsApp, `canal` + `contacto_id` (id de Meta) en Messenger / Instagram. `canal`
 *   ausente = WhatsApp. `telefono` con otro canal, un canal desconocido o un `contacto_id` mal formado = 400; un telefono de WhatsApp
 *   mal formado = 422 (como siempre).
 * - El mismo numero en dos canales son dos personas: una cita solo es de la identidad que coincide en canal Y clave.
 * - Fuera de WhatsApp, `telefono_contacto` (8 a 15 digitos) es obligatorio al agendar (400).
 */
export const CHANNELS = ["whatsapp", "facebook", "instagram"] as const satisfies readonly Channel[];
const PHONE = /^[0-9]{8,15}$/;
/** El id de Meta (PSID / IGSID) aceptado. */
export const CONTACT_ID = /^[0-9A-Za-z_-]{5,64}$/;
const CONTACT_PHONE_ERROR = "se requiere telefono_contacto (8 a 15 digitos) para este canal";

export type BotWho = { channel: Channel; key: string };
type Obj = Record<string, unknown>;

export const isChannel = (v: unknown): v is Channel => typeof v === "string" && (CHANNELS as readonly string[]).includes(v);

/** `telefono` (WhatsApp) o `canal` + `contacto_id`, nunca mezcladas. `optionalPhone`: el traspaso acepta WhatsApp sin telefono. */
export function botWho(src: Obj, optionalPhone = false): BotWho {
  const canal = src.canal ?? "whatsapp";
  if (!isChannel(canal)) throw badRequest(`canal debe ser ${CHANNELS.join(" | ")}`);
  if (canal === "whatsapp") {
    if (src.telefono == null && optionalPhone) return { channel: "whatsapp", key: "" };
    if (typeof src.telefono !== "string" || !PHONE.test(src.telefono)) throw invalid("telefono inválido (8 a 15 dígitos).");
    return { channel: "whatsapp", key: src.telefono };
  }
  if (src.telefono != null) throw badRequest("telefono solo aplica a whatsapp");
  if (typeof src.contacto_id !== "string" || !CONTACT_ID.test(src.contacto_id)) {
    throw badRequest("contacto_id es obligatorio fuera de whatsapp (letras, dígitos, - y _; de 5 a 64 caracteres)");
  }
  return { channel: canal, key: src.contacto_id };
}

/** El `patient.id` de una cita de Messenger / Instagram: estable y NUNCA el telefono de contacto. */
export const metaPatientId = (channel: Channel, key: string) => `${channel}:${key}`;

/** Esta cita es de esta identidad: WhatsApp compara el telefono; los demas canales, SOLO el id de Meta (nunca `phone`). */
export function ownsBooking(who: BotWho, b: Booking): boolean {
  if (!who.key || b.kind !== "session" || !b.patient) return false;
  const channel = b.channel ?? "whatsapp";
  if (channel !== who.channel) return false;
  return who.channel === "whatsapp" ? b.patient.phone === who.key : b.patient.id === metaPatientId(who.channel, who.key);
}

/** `mis_citas`: agendadas, futuras o en curso, de ESA identidad. */
export function botMine(db: DB, now: Date, who: BotWho): Booking[] {
  return db.bookings
    .filter((b) => b.status === "agendada" && ownsBooking(who, b) && Date.parse(b.scheduledAtUtc) + b.durationMinutes * 60_000 > now.getTime())
    .sort((a, b) => a.scheduledAtUtc.localeCompare(b.scheduledAtUtc))
    .map((b) => structuredClone(b));
}

/** `agendar`: la cita `source: "ai"` en el primer hueco libre del doctor. Fuera de WhatsApp exige `contactPhone`. */
export function botBook(db: DB, now: Date, who: BotWho, input: { patientName: string; doctorId: string; contactPhone?: unknown }): Booking | null {
  let phone: string;
  if (who.channel === "whatsapp") phone = who.key; // en WhatsApp el telefono es la identidad y el de contacto se ignora
  else if (typeof input.contactPhone === "string" && PHONE.test(input.contactPhone)) phone = input.contactPhone;
  else throw badRequest(CONTACT_PHONE_ERROR);
  const doctor = db.doctors.find((d) => d.id === input.doctorId);
  if (!doctor) return null;
  const startUtc = nextFreeSlot(db, now, doctor.id, todayInTz(new Date(now.getTime() + 61 * 60_000), TZ));
  if (!startUtc) return null;
  // placeInSchedule ya eligio consultorio al probar el hueco: aqui se toma el primero libre a esa hora
  const taken = new Set(db.bookings.filter((b) => b.status !== "cancelada" && b.scheduledAtUtc === startUtc).map((b) => b.room?.id));
  const room = db.rooms.find((r) => !taken.has(r.id))!;
  const booking: Booking = {
    id: nextId(db, "b"), kind: "session", status: "agendada", source: "ai", channel: who.channel, scheduledAtUtc: startUtc, durationMinutes: 30,
    patient: { id: who.channel === "whatsapp" ? phone : metaPatientId(who.channel, who.key), name: input.patientName, phone },
    contactPhone: phone,
    doctor: { id: doctor.id, name: doctor.name, specialty: doctor.specialty, color: doctor.color ?? null },
    room: { ...room }, notes: null,
  };
  db.bookings.push(booking);
  return booking;
}

/** `cancelar`: 404 si la cita no existe O es de otra identidad (otro telefono, otro id u otro canal: no se distingue). */
export function botCancel(db: DB, who: BotWho, bookingId: string): Booking {
  const b = db.bookings.find((x) => x.id === bookingId);
  if (!b || b.status !== "agendada" || !ownsBooking(who, b)) throw new HttpError(404, "cita_no_encontrada", "No hay una cita agendada con ese id.");
  b.status = "cancelada";
  return structuredClone(b);
}

const HANDOFF_REASONS = ["modelo_fallo", "accion_invalida", "pidio_persona", "fuera_de_alcance", "otro"];

/** Traspaso a una persona. WhatsApp: `telefono` opcional. Messenger / Instagram: canal + id obligatorios y SIN telefono. */
export function botHandoff(db: DB, now: Date, src: Obj): AttentionItem {
  const who = botWho(src, true);
  const conv = src.conversationId;
  if (typeof conv !== "string" || !conv.trim() || typeof src.reason !== "string" || !HANDOFF_REASONS.includes(src.reason)) {
    throw invalid(`se requieren conversationId y reason (${HANDOFF_REASONS.join(" | ")})`);
  }
  const item: AttentionItem = {
    id: nextId(db, "at"), kind: "handoff", status: "open", createdAtUtc: now.toISOString(), conversationId: conv.trim().slice(0, 64),
    channel: who.channel, contactId: who.channel === "whatsapp" ? null : who.key,
    phone: who.channel === "whatsapp" && who.key ? who.key : null,
    reason: src.reason, detail: typeof src.detail === "string" && src.detail ? src.detail.slice(0, 500) : null,
  };
  db.attention.push(item);
  return structuredClone(item);
}
