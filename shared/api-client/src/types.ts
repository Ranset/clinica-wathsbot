import type { components } from "./schema";

/**
 * Tipos de la API. Salen de `src/schema.d.ts`, generado de `docs/openapi.yaml`
 * (`npm run generate`); aqui solo se les pone un nombre corto. `Booking`,
 * `BookingStatus` y `WeeklyHours` son los de `shared/calendar`: el contrato los
 * calca y `test/types.test.ts` comprueba que siguen siendo el mismo tipo.
 */
export type { Booking, BookingStatus, WeeklyHours, Lane } from "@clinica/calendar/src/types";
export type { Interval, WeekdayKey } from "@clinica/calendar/src/lib/slots";

type S = components["schemas"];

export type ErrorCode = S["ErrorCode"];
export type ErrorBody = S["ErrorBody"];
export type BookingList = S["BookingList"];
export type BookingCreate = S["BookingCreate"];
export type BookingPatch = S["BookingPatch"];
export type Room = S["Room"];
export type Doctor = S["Doctor"];
export type DoctorInput = S["DoctorInput"];
export type Absence = S["Absence"];
export type AbsenceInput = S["AbsenceInput"];
export type AbsenceResult = S["AbsenceResult"];
export type PersonalEvent = S["PersonalEvent"];
export type PersonalEventInput = S["PersonalEventInput"];
export type PersonalEventPatch = S["PersonalEventPatch"];
export type BusyTime = S["BusyTime"];
export type RequestStatus = S["RequestStatus"];
export type ScheduleChangeRequest = S["ScheduleChangeRequest"];
export type ScheduleChangeApplied = S["ScheduleChangeApplied"];
export type Role = S["Role"];
export type User = S["User"];
export type UserCreate = S["UserCreate"];
export type UserPatch = S["UserPatch"];
export type SessionInfo = S["SessionInfo"];
/** Un doctor de la lista de la pantalla de entrada: codigo de 4 digitos y nombre (publico). */
export type LoginDoctor = S["LoginDoctor"];
/** El enlace que el personal le manda al doctor para que establezca su contraseña (`url` completa y cuándo vence). */
export type PasswordLink = S["PasswordLink"];
/** Los horarios libres a los que se puede mover una cita, por día (hora de pared de la clínica, `HH:MM`). */
export type MoveSlots = S["MoveSlots"];
/** De quién es un enlace (código y nombre del doctor) y hasta cuándo vale. */
export type PasswordLinkInfo = S["PasswordLinkInfo"];
export type AttentionItem = S["AttentionItem"];
export type AttentionList = S["AttentionList"];
export type Branding = S["Branding"];
export type BotSettings = S["BotSettings"];

/** Respuesta de `PUT /api/doctors/{id}/weekly-hours` (y de aprobar una solicitud, por dentro). */
export type WeeklyHoursResult = {
  doctor: Doctor;
  affectedAppointments: import("@clinica/calendar/src/types").Booking[];
};
