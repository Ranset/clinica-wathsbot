import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zonedWallClockToUtc } from "@clinica/calendar/src/lib/slots";
import { ApiError, LOGO_MAX_BYTES, createApiClient, type ApiClient, type Role } from "../src";
import { gif, jpeg, padTo, png, svg, webpExtended, webpLossless, webpLossy } from "./images";
import { DEMO_ACCOUNTS, LOGIN_MAX_FAILURES, createMockApi, type MockApi } from "../src/mock";
import { contractFetch } from "./spec";

/**
 * Las reglas de agenda y de permisos del simulador, vistas desde el cliente.
 * "Ahora" es martes 2026-11-10 10:00 en Cancun. Cada prueba parte de una agenda
 * vacia (sin las citas de ejemplo) para elegir los huecos sin tropezar.
 */
const NOW = new Date("2026-11-10T15:00:00Z");
const at = (day: string, hhmm: string) => zonedWallClockToUtc(day, hhmm, "America/Cancun")!.toISOString();
const D = { cervantes: "d1", perez: "d2", bordas: "d3", torrealba: "d4", geydi: "d6" };

let mock: MockApi;
/** El «ahora» del simulador: se puede adelantar dentro de una prueba (se restablece antes de cada una). */
let clock = NOW;
let api: ApiClient;
/** Mismo servidor y misma sesion, pero SIN validar la peticion contra el contrato: para mandar a proposito lo invalido. */
let lax: ApiClient;
let violations: string[];

async function login(role: Role = "staff") {
  const acc = DEMO_ACCOUNTS.find((a) => a.role === role)!;
  await api.auth.login(acc.email, acc.password);
  lax.csrfToken = api.csrfToken;
}

const book = (over: Partial<Parameters<ApiClient["appointments"]["create"]>[0]> = {}) =>
  api.appointments.create({ patientName: "Paciente Uno", doctorId: D.cervantes, scheduledAtUtc: at("2026-11-12", "11:00"), ...over });

const code = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x) => x
  );
  expect(e).toBeInstanceOf(ApiError);
  return `${(e as ApiError).status} ${(e as ApiError).code}`;
};

beforeEach(async () => {
  clock = NOW;
  mock = createMockApi({ now: () => clock });
  mock.db.bookings.length = 0;
  mock.db.absences.length = 0;
  mock.db.personalEvents.length = 0;
  const cf = contractFetch(mock.fetch);
  violations = cf.violations;
  api = createApiClient({ fetch: cf.fetch });
  lax = createApiClient({ fetch: mock.fetch });
  await login("staff");
});
afterEach(() => expect(violations).toEqual([]));

describe("reservar", () => {
  it("crea la cita manual, elige consultorio y usa el telefono como id del paciente", async () => {
    const b = await book({ phone: "529980001234" });
    expect(b).toMatchObject({
      kind: "session", status: "agendada", source: "manual", durationMinutes: 30,
      patient: { id: "529980001234", name: "Paciente Uno", phone: "529980001234" },
      doctor: { id: "d1", specialty: "Proctología" }, room: { id: "r1" },
    });
    const sin = await book({ doctorId: D.bordas, patientName: "Sin Telefono" });
    expect(sin.patient).toEqual({ id: sin.id, name: "Sin Telefono" });
  });

  it("pide nombre y apellido", async () => {
    expect(await code(book({ patientName: "Solonombre" }))).toBe("422 falta_nombre_completo");
  });

  it("solo en punto o y media", async () => {
    expect(await code(book({ scheduledAtUtc: at("2026-11-12", "11:15") }))).toBe("422 validacion");
    expect(await code(lax.appointments.create({ patientName: "Paciente Uno", doctorId: D.cervantes, scheduledAtUtc: at("2026-11-12", "11:00"), durationMinutes: 45 }))).toBe("422 validacion");
  });

  it("antelacion minima de 60 min: personal puede saltarsela, pero no reservar en el pasado", async () => {
    expect(await code(book({ scheduledAtUtc: at("2026-11-10", "10:30") }))).toBe("422 horario_pasado_o_muy_cercano"); // faltan 30 min
    expect((await book({ scheduledAtUtc: at("2026-11-10", "11:00") })).status).toBe("agendada"); // justo 60 min: se permite
    expect((await book({ doctorId: D.bordas, scheduledAtUtc: at("2026-11-10", "10:30"), allowShortNotice: true })).status).toBe("agendada");
    expect(await code(book({ doctorId: D.torrealba, scheduledAtUtc: at("2026-11-10", "09:30"), allowShortNotice: true }))).toBe("422 horario_pasado_o_muy_cercano");
  });

  it("horizonte de 60 dias (el dia 60 si, el 61 no)", async () => {
    expect((await book({ scheduledAtUtc: at("2027-01-09", "10:00") })).status).toBe("agendada"); // sabado, dia 60
    expect(await code(book({ scheduledAtUtc: at("2027-01-11", "10:00") }))).toBe("422 fuera_de_rango"); // lunes, dia 62
  });

  it("dentro del horario de la clinica y del doctor", async () => {
    expect(await code(book({ scheduledAtUtc: at("2026-11-12", "18:00") }))).toBe("422 fuera_de_horario"); // cierra a las 18
    expect(await code(book({ scheduledAtUtc: at("2026-11-12", "17:30"), durationMinutes: 60 }))).toBe("422 fuera_de_horario"); // se pasa
    expect(await code(book({ scheduledAtUtc: at("2026-11-15", "10:00") }))).toBe("422 fuera_de_horario"); // domingo
    expect(await code(book({ scheduledAtUtc: at("2026-11-14", "13:00") }))).toBe("422 fuera_de_horario"); // sabado cierra a las 13
    expect(await code(book({ doctorId: D.perez, scheduledAtUtc: at("2026-11-13", "10:00") }))).toBe("422 fuera_de_horario"); // Perez solo mar y jue
    expect((await book({ doctorId: D.perez, scheduledAtUtc: at("2026-11-12", "10:00") })).status).toBe("agendada");
  });

  it("el doctor no puede estar en dos citas, ni en otro consultorio", async () => {
    await book();
    expect(await code(book({ patientName: "Otra Persona" }))).toBe("409 horario_ocupado");
    expect(await code(book({ patientName: "Otra Persona", roomId: "r2" }))).toBe("409 horario_ocupado");
  });

  it("nunca mas de 2 citas a la vez: con 2 consultorios ocupados, el tercer doctor no cabe", async () => {
    const a = await book();
    const b = await book({ doctorId: D.bordas, patientName: "Paciente Dos" });
    expect([a.room!.id, b.room!.id].sort()).toEqual(["r1", "r2"]);
    expect(await code(book({ doctorId: D.torrealba, patientName: "Paciente Tres" }))).toBe("409 horario_ocupado");
  });

  it("un consultorio pedido y ocupado es 409; uno que no existe es 422", async () => {
    await book({ roomId: "r1" });
    expect(await code(book({ doctorId: D.bordas, patientName: "Paciente Dos", roomId: "r1" }))).toBe("409 horario_ocupado");
    expect(await code(book({ doctorId: D.bordas, patientName: "Paciente Dos", roomId: "r9" }))).toBe("422 validacion");
  });

  it("una cita cancelada libera el hueco", async () => {
    const a = await book();
    await api.appointments.update(a.id, { status: "cancelada" });
    expect((await book({ patientName: "Paciente Nuevo" })).status).toBe("agendada");
  });

  it("las citas que se solapan a medias tambien chocan (60 min contra 30 min)", async () => {
    await book({ scheduledAtUtc: at("2026-11-12", "11:00"), durationMinutes: 60 });
    expect(await code(book({ scheduledAtUtc: at("2026-11-12", "11:30") }))).toBe("409 horario_ocupado");
    expect((await book({ scheduledAtUtc: at("2026-11-12", "12:00") })).status).toBe("agendada");
  });

  it("doctor dado de baja o inexistente", async () => {
    await login("admin");
    await api.doctors.update(D.torrealba, { active: false });
    expect(await code(book({ doctorId: D.torrealba }))).toBe("422 doctor_no_disponible");
    expect(await code(book({ doctorId: "d99" }))).toBe("422 validacion");
  });
});

describe("bloqueos de consultorio", () => {
  it("un bloqueo ocupa el consultorio: la cita cae en el otro, y con los dos bloqueados no cabe", async () => {
    const blk = await api.appointments.create({ kind: "block", roomId: "r1", scheduledAtUtc: at("2026-11-12", "11:00"), durationMinutes: 120, notes: "Mantenimiento" });
    expect(blk).toMatchObject({ kind: "block", doctor: null, patient: null, room: { id: "r1" }, durationMinutes: 120 });
    expect((await book()).room!.id).toBe("r2");
    await api.appointments.create({ kind: "block", roomId: "r2", scheduledAtUtc: at("2026-11-12", "12:00"), durationMinutes: 30 }).catch(() => {});
    expect(await code(book({ doctorId: D.bordas, patientName: "Paciente Dos", roomId: "r1" }))).toBe("409 horario_ocupado");
  });

  it("exige consultorio, no lleva doctor y no se pisa con una cita existente", async () => {
    expect(await code(api.appointments.create({ kind: "block", scheduledAtUtc: at("2026-11-12", "11:00") }))).toBe("422 validacion");
    expect(await code(api.appointments.create({ kind: "block", roomId: "r1", doctorId: "d1", scheduledAtUtc: at("2026-11-12", "11:00") }))).toBe("422 validacion");
    const a = await book({ roomId: "r1" });
    expect(await code(api.appointments.create({ kind: "block", roomId: a.room!.id, scheduledAtUtc: at("2026-11-12", "11:00") }))).toBe("409 horario_ocupado");
  });

  it("quitar un bloqueo (cancelada) lo libera; un bloqueo no puede quedar 'realizado'", async () => {
    const blk = await api.appointments.create({ kind: "block", roomId: "r1", scheduledAtUtc: at("2026-11-12", "11:00") });
    expect(await code(api.appointments.update(blk.id, { status: "realizada" }))).toBe("409 transicion_invalida");
    await api.appointments.update(blk.id, { status: "cancelada" });
    expect((await book({ roomId: "r1" })).room!.id).toBe("r1");
  });
});

describe("cambiar estado", () => {
  it("agendada -> realizada <-> no_show; cancelada es terminal", async () => {
    const b = await book();
    expect((await api.appointments.update(b.id, { status: "realizada" })).status).toBe("realizada");
    expect((await api.appointments.update(b.id, { status: "no_show" })).status).toBe("no_show");
    expect((await api.appointments.update(b.id, { status: "realizada" })).status).toBe("realizada");
    expect(await code(api.appointments.update(b.id, { status: "agendada" }))).toBe("409 transicion_invalida");
    expect(await code(api.appointments.update(b.id, { status: "cancelada" }))).toBe("409 transicion_invalida");

    const c = await book({ patientName: "Paciente Dos", doctorId: D.bordas });
    await api.appointments.update(c.id, { status: "cancelada" });
    for (const s of ["agendada", "realizada", "no_show"] as const) {
      expect(await code(api.appointments.update(c.id, { status: s }))).toBe("409 transicion_invalida");
    }
  });

  it("las notas se editan siempre (null las borra) y un cuerpo vacio es invalido", async () => {
    const b = await book();
    expect((await api.appointments.update(b.id, { notes: "Llega con estudios" })).notes).toBe("Llega con estudios");
    expect((await api.appointments.update(b.id, { notes: null })).notes).toBeNull();
    expect(await code(lax.appointments.update(b.id, {}))).toBe("422 validacion");
    expect(await code(lax.appointments.update(b.id, { notes: "x".repeat(501) }))).toBe("422 validacion");
  });
});

describe("mover una cita (atomico)", () => {
  it("mueve a otro horario libre y cambia el hueco", async () => {
    const b = await book();
    const moved = await api.appointments.update(b.id, { scheduledAtUtc: at("2026-11-12", "12:00") });
    expect(moved.scheduledAtUtc).toBe(at("2026-11-12", "12:00"));
    expect((await book({ patientName: "Paciente Dos" })).status).toBe("agendada"); // el hueco de las 11:00 quedo libre
  });

  it("si el nuevo horario falla, la cita original queda intacta", async () => {
    const a = await book();
    await book({ patientName: "Paciente Dos", scheduledAtUtc: at("2026-11-12", "12:00") }); // mismo doctor
    expect(await code(api.appointments.update(a.id, { scheduledAtUtc: at("2026-11-12", "12:00") }))).toBe("409 horario_ocupado");
    expect(await code(api.appointments.update(a.id, { scheduledAtUtc: at("2026-11-12", "19:00") }))).toBe("422 fuera_de_horario");
    expect(await code(api.appointments.update(a.id, { scheduledAtUtc: at("2026-11-10", "10:30") }))).toBe("422 horario_pasado_o_muy_cercano");
    expect(await code(api.appointments.update(a.id, { scheduledAtUtc: at("2027-02-01", "10:00") }))).toBe("422 fuera_de_rango");
    expect(await api.appointments.get(a.id)).toMatchObject({ scheduledAtUtc: at("2026-11-12", "11:00"), status: "agendada", room: a.room });
  });

  it("al mover se aplican las reglas de reservar, incluida la antelacion", async () => {
    const b = await book();
    expect(await code(api.appointments.update(b.id, { scheduledAtUtc: at("2026-11-10", "10:30") }))).toBe("422 horario_pasado_o_muy_cercano");
    expect((await api.appointments.update(b.id, { scheduledAtUtc: at("2026-11-10", "10:30"), allowShortNotice: true })).scheduledAtUtc).toBe(at("2026-11-10", "10:30"));
  });

  it("puede cambiar de consultorio, y solo si esta libre", async () => {
    const a = await book({ roomId: "r1" });
    await book({ doctorId: D.bordas, patientName: "Paciente Dos", roomId: "r2" });
    expect(await code(api.appointments.update(a.id, { roomId: "r2" }))).toBe("409 horario_ocupado");
    const c = await book({ doctorId: D.torrealba, patientName: "Paciente Tres", scheduledAtUtc: at("2026-11-12", "12:00") });
    expect((await api.appointments.update(c.id, { roomId: "r2" })).room!.id).toBe("r2");
  });

  it("solo se mueve una cita agendada", async () => {
    const b = await book();
    await api.appointments.update(b.id, { status: "realizada" });
    expect(await code(api.appointments.update(b.id, { scheduledAtUtc: at("2026-11-12", "12:00") }))).toBe("409 transicion_invalida");
  });
});

describe("horario del doctor y ausencias", () => {
  it("una ausencia deja de ofrecer al doctor de inmediato y avisa de las citas afectadas, sin cancelarlas", async () => {
    const existing = await book({ scheduledAtUtc: at("2026-11-12", "11:00") });
    const res = await api.doctors.absences.create(D.cervantes, { startUtc: at("2026-11-12", "09:00"), endUtc: at("2026-11-12", "18:00"), reason: "Congreso" });
    expect(res.affectedAppointments.map((x) => x.id)).toEqual([existing.id]);
    expect((await api.appointments.get(existing.id)).status).toBe("agendada");
    expect(await code(book({ patientName: "Paciente Dos", scheduledAtUtc: at("2026-11-12", "12:00") }))).toBe("422 doctor_no_disponible");
    // otro doctor sigue disponible
    expect((await book({ doctorId: D.bordas, patientName: "Paciente Dos", scheduledAtUtc: at("2026-11-12", "12:00") })).status).toBe("agendada");

    await api.doctors.absences.remove(D.cervantes, res.absence.id);
    expect((await book({ patientName: "Paciente Tres", scheduledAtUtc: at("2026-11-12", "12:00") })).status).toBe("agendada");
  });

  it("valida la ausencia: fin despues del inicio, y que el doctor y la ausencia existan", async () => {
    expect(await code(api.doctors.absences.create(D.cervantes, { startUtc: at("2026-11-12", "12:00"), endUtc: at("2026-11-12", "10:00") }))).toBe("422 rango_invalido");
    expect(await code(api.doctors.absences.create("d99", { startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "12:00") }))).toBe("404 no_encontrado");
    expect(await code(api.doctors.absences.remove(D.cervantes, "a99"))).toBe("404 no_encontrado");
  });

  it("horario propio: dentro del de la clinica; lista las citas que quedan fuera; null vuelve al general", async () => {
    const tarde = await book({ scheduledAtUtc: at("2026-11-12", "16:00") });
    const manana = await book({ patientName: "Paciente Dos", scheduledAtUtc: at("2026-11-12", "10:00") });
    const r = await api.doctors.setWeeklyHours(D.cervantes, { thu: [{ start: "09:00", end: "13:00" }] });
    expect(r.doctor).toMatchObject({ usesClinicHours: false, weeklyHours: { thu: [{ start: "09:00", end: "13:00" }] } });
    expect(r.affectedAppointments.map((x) => x.id)).toEqual([tarde.id]);
    expect(manana.id).toBeTruthy();
    expect(await code(book({ patientName: "Paciente Tres", scheduledAtUtc: at("2026-11-12", "15:00") }))).toBe("422 fuera_de_horario");

    expect(await code(api.doctors.setWeeklyHours(D.cervantes, { thu: [{ start: "08:00", end: "13:00" }] }))).toBe("422 fuera_de_horario"); // antes de abrir
    expect(await code(api.doctors.setWeeklyHours(D.cervantes, { sun: [{ start: "10:00", end: "12:00" }] }))).toBe("422 fuera_de_horario");
    expect(await code(api.doctors.setWeeklyHours(D.cervantes, { thu: [{ start: "12:00", end: "10:00" }] }))).toBe("422 validacion");
    expect(await code(api.doctors.setWeeklyHours(D.cervantes, { thu: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] }))).toBe("422 validacion");

    const back = await api.doctors.setWeeklyHours(D.cervantes, null);
    expect(back.doctor.usesClinicHours).toBe(true);
    expect(back.doctor.weeklyHours.mon).toEqual([{ start: "09:00", end: "18:00" }]);
    expect(back.affectedAppointments).toEqual([]);
  });

  it("el administrador no puede acortar el horario de la clinica por debajo del de un doctor", async () => {
    await login("admin");
    expect(await code(api.clinicHours.set({ tue: [{ start: "09:00", end: "12:00" }], thu: [{ start: "09:00", end: "18:00" }] }))).toBe("422 fuera_de_horario"); // Perez: 10-14
    const hours = await api.clinicHours.get();
    expect(hours.mon).toEqual([{ start: "09:00", end: "18:00" }]);
  });

  it("aprobar una solicitud aplica el horario; una ya resuelta no se vuelve a resolver", async () => {
    const [req] = await api.scheduleChanges.list("pending");
    expect(req).toBeDefined();
    const done = await api.scheduleChanges.approve(req!.id);
    expect(done).toMatchObject({ status: "approved", decidedBy: "Recepción Clínica" });
    const docs = await api.doctors.list();
    expect(docs.find((d) => d.id === req!.doctorId)!.weeklyHours).toEqual(req!.weeklyHours);
    expect(await code(api.scheduleChanges.approve(req!.id))).toBe("409 transicion_invalida");
    expect(await code(lax.scheduleChanges.reject(req!.id))).toBe("409 transicion_invalida");
    expect(await api.scheduleChanges.list("pending")).toEqual([]);
  });
});

describe("listar con ETag", () => {
  const range = { from: at("2026-11-09", "00:00"), to: at("2026-11-16", "00:00") };

  it("304 mientras nada cambia; 200 con ETag nuevo cuando cambia (aun siendo otra instancia de la misma lista)", async () => {
    const b = await book();
    const first = await api.appointments.list(range);
    if (first.notModified) throw new Error("se esperaba 200");
    expect(first.data.items.map((x) => x.id)).toEqual([b.id]);
    expect(first.data.serverTimeUtc).toBe(NOW.toISOString());

    expect(await api.appointments.list(range, { etag: first.etag })).toMatchObject({ notModified: true });
    await api.appointments.update(b.id, { notes: "cambio" });
    const after = await api.appointments.list(range, { etag: first.etag });
    expect(after.notModified).toBe(false);
    expect(after.etag).not.toBe(first.etag);
  });

  it("filtra por doctor, consultorio y estado, ordenado por inicio", async () => {
    const late = await book({ doctorId: D.bordas, patientName: "Paciente Tarde", scheduledAtUtc: at("2026-11-12", "15:00") });
    const early = await book({ patientName: "Paciente Temprano", scheduledAtUtc: at("2026-11-11", "09:00") });
    const ids = async (q: object) => {
      const r = await api.appointments.list({ ...range, ...q });
      return r.notModified ? [] : r.data.items.map((x) => x.id);
    };
    expect(await ids({})).toEqual([early.id, late.id]);
    expect(await ids({ doctorId: D.bordas })).toEqual([late.id]);
    expect(await ids({ roomId: early.room!.id, doctorId: D.cervantes })).toEqual([early.id]);
    await api.appointments.update(late.id, { status: "cancelada" });
    expect(await ids({ status: "cancelada" })).toEqual([late.id]);
  });

  it("el rango: from y to obligatorios, to despues de from y maximo 92 dias", async () => {
    expect(await code(api.appointments.list({ from: range.to, to: range.from }))).toBe("422 rango_invalido");
    expect(await code(api.appointments.list({ from: at("2026-11-01", "00:00"), to: at("2027-02-15", "00:00") }))).toBe("422 rango_invalido");
    expect((await api.appointments.list({ from: at("2026-11-01", "00:00"), to: at("2027-02-01", "00:00") })).notModified).toBe(false); // 92 dias justos
  });
});

describe("permisos y sesion", () => {
  it("sin sesion es 401 y el cliente avisa; con otro rol es 403", async () => {
    const seen = vi.fn();
    api.onUnauthenticated(seen);
    expect(await code(api.users.list())).toBe("403 sin_permiso"); // staff no administra usuarios
    expect(await code(api.doctorSelf.hours())).toBe("403 sin_permiso");

    mock.controls.expireSession();
    expect(await code(api.appointments.list({ from: NOW.toISOString(), to: new Date(NOW.getTime() + 86_400_000).toISOString() }))).toBe("401 no_autenticado");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("el personal (recepcion) da de alta, edita y da de baja doctores; un doctor recibe 403", async () => {
    await login("staff");
    const created = await api.doctors.create({ name: "Dra. Alta Recepcion", specialty: "Pediatria", aliases: ["pediatra"] });
    expect(created).toMatchObject({ name: "Dra. Alta Recepcion", specialty: "Pediatria", active: true });
    expect((await api.doctors.update(created.id, { specialty: "Pediatria general" })).specialty).toBe("Pediatria general");
    expect((await api.doctors.update(created.id, { active: false })).active).toBe(false);

    await api.auth.logout();
    await login("doctor");
    expect(await code(api.doctors.create({ name: "Dr. X Y", specialty: "Z" }))).toBe("403 sin_permiso");
    expect(await code(api.doctors.update(D.torrealba, { specialty: "Otra" }))).toBe("403 sin_permiso");
  });

  it("solo el administrador elimina doctores, y solo sin citas ni cuenta ligada; si no, se da de baja", async () => {
    const nuevo = await api.doctors.create({ name: "Dr. Por Error", specialty: "Cardiologia" });   // sesion: personal
    expect(await code(api.doctors.remove(nuevo.id))).toBe("403 sin_permiso");
    await api.auth.logout();
    await login("doctor");
    expect(await code(api.doctors.remove(nuevo.id))).toBe("403 sin_permiso");
    await api.auth.logout();
    await login("admin");

    expect(await code(api.doctors.remove(D.cervantes))).toBe("409 doctor_con_usuario");             // tiene cuenta (la PWA)
    const cita = await book({ doctorId: D.bordas });
    expect(await code(api.doctors.remove(D.bordas))).toBe("409 doctor_con_citas");
    await api.appointments.update(cita.id, { status: "cancelada" });
    expect(await code(api.doctors.remove(D.bordas))).toBe("409 doctor_con_citas");                  // cancelada sigue siendo historial
    expect((await api.doctors.update(D.bordas, { active: false })).active).toBe(false);             // lo que si se puede: la baja

    expect(await api.doctors.remove(nuevo.id)).toBeUndefined();                                      // sin historial: se elimina
    expect((await api.doctors.list()).map((d) => d.id)).not.toContain(nuevo.id);
    expect((await api.doctors.list()).map((d) => d.id)).toContain(D.bordas);                         // el de baja sigue ahi
    expect(await code(api.doctors.remove(nuevo.id))).toBe("404 no_encontrado");
  });

  it("el color de un doctor se elige, se quita y llega a sus citas; uno demasiado claro o mal escrito se rechaza", async () => {
    expect((await api.doctors.list()).every((d) => d.color === null)).toBe(true);                     // sin color elegido: automatico
    const d = await api.doctors.create({ name: "Dr. Con Color", specialty: "Urologia", color: "#1D4ED8" });
    expect(d.color).toBe("#1d4ed8");                                                                  // se guarda en minusculas

    const cita = await book({ doctorId: d.id });
    expect(cita.doctor?.color).toBe("#1d4ed8");
    expect((await api.doctors.update(d.id, { color: "#be185d" })).color).toBe("#be185d");
    expect((await api.doctors.update(d.id, { specialty: "Urologia general" })).color).toBe("#be185d");  // no se pierde al editar otra cosa
    expect((await api.appointments.get(cita.id)).doctor?.color).toBe("#be185d");                      // la cita ya agendada lo sigue
    expect((await api.doctors.update(d.id, { color: null })).color).toBeNull();                        // null = automatico
    expect((await api.appointments.get(cita.id)).doctor?.color).toBeNull();

    for (const malo of ["azul", "#fff", "1d4ed8", "#12345g", 123, ""]) {
      expect(await code(lax.doctors.update(d.id, { color: malo as never }))).toBe("422 validacion");
    }
    for (const claro of ["#ffffff", "#ffff00", "#cccccc", "#777777"]) {
      expect(await code(api.doctors.update(d.id, { color: claro }))).toBe("422 validacion");          // el texto blanco no se leeria
      expect(await code(api.doctors.create({ name: "Dr. Muy Claro", specialty: "X", color: claro }))).toBe("422 validacion");
    }
    expect((await api.doctors.list()).some((x) => x.name === "Dr. Muy Claro")).toBe(false);
    expect((await api.doctors.update(d.id, { color: "#767676" })).color).toBe("#767676");             // justo el limite AA
  });

  it("el personal (recepcion) cambia el horario de la clinica; un doctor recibe 403 y el horario no se mueve", async () => {
    await login("staff");
    const before = await api.clinicHours.get();
    const next = { ...before, mon: [{ start: "09:00", end: "17:00" }] };
    expect(await api.clinicHours.set(next)).toEqual(next);
    expect(await api.clinicHours.get()).toEqual(next);
    expect(await code(api.clinicHours.set({}))).not.toBe("403 sin_permiso"); // llega a la validacion (el servidor rechaza un horario vacio)

    await api.auth.logout();
    await login("doctor");
    expect(await code(api.clinicHours.set(before))).toBe("403 sin_permiso");
    expect(await api.clinicHours.get()).toEqual(next);                         // el doctor puede leerlo, no cambiarlo
  });

  it("el doctor elimina sus solicitudes de cambio de horario PENDIENTES: una resuelta (409), ajena o inexistente (404) y los demas roles (403) no", async () => {
    const hours = { mon: [{ start: "10:00", end: "14:00" }] };
    const pedir = (note: string) => api.doctorSelf.scheduleChanges.create({ weeklyHours: hours, effectiveFrom: "2026-12-01", note });
    await api.auth.logout();
    await login("doctor");
    const [a, b, c] = [await pedir("a"), await pedir("b"), await pedir("c")];
    expect((await api.doctorSelf.scheduleChanges.list()).map((r) => r.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(await api.doctorSelf.scheduleChanges.remove(a.id)).toBeUndefined();
    expect((await api.doctorSelf.scheduleChanges.list()).map((r) => r.id)).not.toContain(a.id);
    expect(await code(api.doctorSelf.scheduleChanges.remove(a.id))).toBe("404 no_encontrado");           // ya no existe
    expect(await code(api.doctorSelf.scheduleChanges.remove("no-existe"))).toBe("404 no_encontrado");

    // el personal resuelve b: queda como historial y ya no se elimina
    await api.auth.logout();
    await login("staff");
    expect((await api.scheduleChanges.approve(b.id)).status).toBe("approved");
    expect(await code(api.doctorSelf.scheduleChanges.remove(b.id))).toBe("403 sin_permiso");             // el personal no usa esta ruta
    await api.auth.logout();
    await login("doctor");
    expect(await code(api.doctorSelf.scheduleChanges.remove(b.id))).toBe("409 transicion_invalida");
    expect((await api.doctorSelf.scheduleChanges.list()).map((r) => r.id)).toContain(b.id);

    // la de OTRO doctor: 404 (como inexistente) y no se toca
    const otra = mock.db.requests.find((r) => r.doctorId !== "d1" && r.status === "pending")!;
    expect(await code(api.doctorSelf.scheduleChanges.remove(otra.id))).toBe("404 no_encontrado");
    expect(mock.db.requests.some((r) => r.id === otra.id)).toBe(true);
    // el administrador tampoco
    await api.auth.logout();
    await login("admin");
    expect(await code(api.doctorSelf.scheduleChanges.remove(c.id))).toBe("403 sin_permiso");
    expect(mock.db.requests.some((r) => r.id === c.id)).toBe(true);
  });

  it("el doctor solo ve lo suyo, sin telefono, y no entra a la agenda del personal", async () => {
    await login("staff");
    const mine = await book({ phone: "529980001234", patientName: "Paciente De Cervantes" });
    await book({ doctorId: D.bordas, patientName: "Paciente De Bordas", scheduledAtUtc: at("2026-11-12", "12:00") });
    await api.auth.logout();
    await login("doctor");

    const range = { from: at("2026-11-09", "00:00"), to: at("2026-11-16", "00:00") };
    const res = await api.doctorSelf.appointments(range);
    if (res.notModified) throw new Error("se esperaba 200");
    expect(res.data.items.map((x) => x.id)).toEqual([mine.id]);
    expect(res.data.items[0]!.patient).toEqual({ id: mine.id, name: "Paciente De Cervantes" }); // ni phone, ni el telefono como id
    expect(JSON.stringify(res.data)).not.toContain("529980001234");

    expect(await code(api.appointments.list(range))).toBe("403 sin_permiso");
    expect(await code(lax.appointments.get(mine.id))).toBe("403 sin_permiso"); // el contrato no declara 403 aqui
    expect((await api.doctors.list()).map((d) => d.id)).toEqual(["d1"]);
  });

  it("un doctor no puede borrar la ausencia de otro (404, no 403)", async () => {
    const other = await api.doctors.absences.create(D.bordas, { startUtc: at("2026-11-20", "09:00"), endUtc: at("2026-11-20", "18:00") });
    await api.auth.logout();
    await login("doctor");
    expect(await code(api.doctorSelf.absences.remove(other.absence.id))).toBe("404 no_encontrado");
  });

  it("las escrituras sin token CSRF (o con uno falso) son 403", async () => {
    const raw = (token?: string) =>
      mock.fetch("/api/settings/bot", { method: "PUT", headers: { "Content-Type": "application/json", ...(token ? { "X-CSRF-Token": token } : {}) }, body: JSON.stringify({ active: false }) });
    expect((await raw()).status).toBe(403);
    expect((await raw("inventado")).status).toBe(403);
    expect((await raw(api.csrfToken!)).status).toBe(200);
  });

  it("el login bloquea tras demasiados intentos y avisa con 429", async () => {
    const fresh = createApiClient({ fetch: createMockApi({ now: () => NOW }).fetch });
    const staff = DEMO_ACCOUNTS.find((a) => a.role === "staff")!;
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect(await code(fresh.auth.login(staff.email, "mal"))).toBe("401 credenciales_invalidas");
    expect(await code(fresh.auth.login(staff.email, staff.password))).toBe("429 demasiados_intentos"); // ni con la buena
  });

  it("un usuario dado de baja no entra", async () => {
    const fresh = createApiClient({ fetch: mock.fetch });
    expect(await code(fresh.auth.login("exrecepcion@clinica.test", "demo-baja-2026-x"))).toBe("401 credenciales_invalidas");
  });
});

describe("usuarios (administrador)", () => {
  beforeEach(async () => {
    await api.auth.logout();
    await login("admin");
  });

  it("valida correo, contrasena de 10+, duplicados y que aqui no se creen doctores (solo personal y administrador)", async () => {
    const base = { email: "nueva@clinica.test", name: "Persona Nueva", role: "staff" as const, password: "contrasena-larga-1" };
    expect(await code(lax.users.create({ ...base, email: "no-es-correo" }))).toBe("422 validacion");
    expect(await code(lax.users.create({ ...base, password: "corta" }))).toBe("422 validacion");
    // la cuenta de un doctor nace con el doctor: desde Usuarios no se crea (ni con doctorId)
    expect(await code(lax.users.create({ ...base, role: "doctor" } as never))).toBe("422 validacion");
    expect(await code(lax.users.create({ ...base, role: "doctor", doctorId: "d3" } as never))).toBe("422 validacion");
    expect(await code(lax.users.create({ ...base, doctorId: "d1" } as never))).toBe("422 validacion");
    expect(mock.db.users.some((x) => x.email === "nueva@clinica.test")).toBe(false);
    const u = await api.users.create(base);
    expect(u).toMatchObject({ email: "nueva@clinica.test", role: "staff", doctorId: null, active: true, passwordSet: true });
    expect(JSON.stringify(u)).not.toContain("contrasena");
    expect(await code(api.users.create({ ...base, email: "NUEVA@clinica.test" }))).toBe("422 validacion");
  });

  it("restablece contrasena, cambia rol y da de baja (y la baja cierra su sesion)", async () => {
    const u = await api.users.create({ email: "temp@clinica.test", name: "Persona Temporal", role: "staff", password: "contrasena-larga-1" });
    const theirs = createApiClient({ fetch: mock.fetch });
    // otra instancia del simulador = otro navegador: se prueba con la misma base
    const second = createMockApi({ now: () => NOW });
    second.db.users.push({ ...u, password: "contrasena-larga-1" });
    const other = createApiClient({ fetch: second.fetch });
    await other.auth.login("temp@clinica.test", "contrasena-larga-1");
    expect(theirs).toBeTruthy();

    expect((await api.users.update(u.id, { role: "doctor", doctorId: "d3" })).doctorId).toBe("d3");
    expect((await api.users.update(u.id, { role: "staff" })).doctorId).toBeNull();
    expect((await api.users.update(u.id, { password: "otra-contrasena-2" })).id).toBe(u.id);
    expect(await code(lax.users.update(u.id, { password: "corta" }))).toBe("422 validacion");
    expect((await api.users.update(u.id, { active: false })).active).toBe(false);
    expect(await code(api.users.update("u99", { name: "X" }))).toBe("404 no_encontrado");
  });

  it("no puedes quitarte el acceso ni cambiar tu propio rol", async () => {
    const me = (await api.auth.me()).user;
    expect(await code(api.users.update(me.id, { active: false }))).toBe("422 validacion");
    expect(await code(api.users.update(me.id, { role: "staff" }))).toBe("422 validacion");
    expect((await api.users.update(me.id, { name: "Otro Nombre" })).name).toBe("Otro Nombre");
  });
});

describe("bot y casos de atencion", () => {
  it("el interruptor guarda quien lo cambio y cuando", async () => {
    expect(await api.bot.get()).toMatchObject({ active: true });
    const off = await api.bot.set(false);
    expect(off).toMatchObject({ active: false, updatedBy: "Recepción Clínica", updatedAt: NOW.toISOString() });
    expect(await api.bot.get()).toEqual(off);
  });

  it("los casos abiertos salen mas recientes primero y al atenderlos pasan a resueltos", async () => {
    const open = await api.attention.list("open");
    expect(open.length).toBeGreaterThanOrEqual(2);
    expect([...open].sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc))).toEqual(open);
    const done = await api.attention.resolve(open[0]!.id);
    expect(done.status).toBe("resolved");
    expect((await api.attention.list("open")).map((x) => x.id)).not.toContain(done.id);
    expect((await api.attention.list("resolved")).map((x) => x.id)).toContain(done.id);
    expect(await code(api.attention.resolve("at99"))).toBe("404 no_encontrado");
  });

  it("los casos se piden por paginas (limit/offset) con su total, igual que el servidor", async () => {
    // 25 atendidos en desorden: «caso 25» es el mas nuevo
    mock.db.attention = mock.db.attention.filter((a) => a.status !== "resolved");
    const base = Date.parse("2026-10-01T15:00:00.000Z");
    const orden = Array.from({ length: 25 }, (_, i) => i);
    for (const i of [...orden.filter((n) => n % 2 === 0), ...orden.filter((n) => n % 2 === 1).reverse()]) {
      mock.db.attention.push({ id: `r${i + 1}`, kind: "handoff", status: "resolved", createdAtUtc: new Date(base + (i + 1) * 3_600_000).toISOString(), conversationId: null, phone: null, reason: "otro", detail: `caso ${i + 1}` });
    }
    const detalles = (r: { items: { detail?: string | null }[] }) => r.items.map((x) => x.detail);
    const p1 = await api.attention.page("resolved", { limit: 10 });
    expect(p1.total).toBe(25);
    expect(detalles(p1)).toEqual(Array.from({ length: 10 }, (_, i) => `caso ${25 - i}`));            // el mas reciente primero
    const p2 = await api.attention.page("resolved", { limit: 10, offset: 10 });
    expect(detalles(p2)).toEqual(Array.from({ length: 10 }, (_, i) => `caso ${15 - i}`));
    const p3 = await api.attention.page("resolved", { limit: 10, offset: 20 });
    expect(detalles(p3)).toEqual(["caso 5", "caso 4", "caso 3", "caso 2", "caso 1"]);
    expect(await api.attention.page("resolved", { limit: 10, offset: 30 })).toEqual({ items: [], total: 25 });
    // sin `limit` salen todos (como antes) y cada estado cuenta lo suyo
    expect(await api.attention.list("resolved")).toHaveLength(25);
    const abiertos = await api.attention.page("open", { limit: 1 });
    expect(abiertos.items).toHaveLength(1);
    expect(abiertos.total).toBe((await api.attention.list("open")).length);
  });

  it("limit y offset invalidos son 422, como en el servidor (y offset solo con limit)", async () => {
    const q = (qs: string) => mock.fetch(`/api/attention?status=resolved${qs}`).then((r) => r.status);
    for (const qs of ["&limit=0", "&limit=101", "&limit=abc", "&limit=1.5", "&limit=10&offset=-1", "&limit=10&offset=x", "&offset=5"]) {
      expect(await q(qs), qs).toBe(422);
    }
    expect(await q("&limit=100")).toBe(200);
    expect(await q("&limit=10&offset=0")).toBe(200);
    expect(await q("&offset=0")).toBe(200);                                                          // offset 0 no necesita limit
  });

  it("una ausencia del doctor con citas agendadas avisa al personal", async () => {
    const before = (await api.attention.list("open")).length;
    await book({ scheduledAtUtc: at("2026-11-12", "11:00") });
    await api.auth.logout();
    await login("doctor");
    const r = await api.doctorSelf.absences.create({ startUtc: at("2026-11-12", "09:00"), endUtc: at("2026-11-12", "18:00") });
    expect(r.affectedCount).toBe(1);
    await api.auth.logout();
    await login("staff");
    const after = await api.attention.list("open");
    expect(after.length).toBe(before + 1);
    expect(after[0]).toMatchObject({ kind: "absence_affects_appointments" });
  });
});

describe("eventos personales del doctor", () => {
  const TITULO = "Cirugía de la Sra. Margarita Quintana";
  const NOTAS = "hipertensión, llevar estudios";
  const week = { from: at("2026-11-09", "00:00"), to: at("2026-11-16", "00:00") };
  const ev = (over: Partial<Parameters<ApiClient["doctorSelf"]["personalEvents"]["create"]>[0]> = {}) => ({
    title: "Dentista", startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "11:00"), ...over,
  });
  /** Entra como el doctor (d1). */
  const asDoctor = async () => {
    await api.auth.logout();
    await login("doctor");
  };

  it("el doctor crea, lista, edita (parche) y borra sus eventos", async () => {
    await asDoctor();
    const made = await api.doctorSelf.personalEvents.create(ev({ notes: "llevar radiografía" }));
    expect(made).toMatchObject({ title: "Dentista", notes: "llevar radiografía", startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "11:00") });
    expect(made).not.toHaveProperty("doctorId");
    expect(await api.doctorSelf.personalEvents.list(week)).toEqual([made]);
    expect(await api.doctorSelf.personalEvents.list({ from: at("2026-11-13", "00:00"), to: at("2026-11-14", "00:00") })).toEqual([]);

    const t = await api.doctorSelf.personalEvents.update(made.id, { title: "  Dentista   (cambio) " });
    expect(t).toMatchObject({ title: "Dentista (cambio)", notes: "llevar radiografía", startUtc: made.startUtc }); // lo demas no se toco
    expect((await api.doctorSelf.personalEvents.update(made.id, { notes: null })).notes).toBeNull();
    const moved = await api.doctorSelf.personalEvents.update(made.id, { startUtc: at("2026-11-12", "14:00"), endUtc: at("2026-11-12", "15:30") });
    expect(moved).toMatchObject({ startUtc: at("2026-11-12", "14:00"), endUtc: at("2026-11-12", "15:30"), title: "Dentista (cambio)" });

    await api.doctorSelf.personalEvents.remove(made.id);
    expect(await api.doctorSelf.personalEvents.list(week)).toEqual([]);
    expect(await code(api.doctorSelf.personalEvents.remove(made.id))).toBe("404 no_encontrado");
  });

  it("el evento bloquea al doctor (no el consultorio), sin decir por que, y al borrarlo vuelve a ofrecerse", async () => {
    await asDoctor();
    const made = await api.doctorSelf.personalEvents.create(ev({ title: TITULO, notes: NOTAS })); // jueves 10:00 a 11:00
    await api.auth.logout();
    await login("staff");
    const err = await book({ scheduledAtUtc: at("2026-11-12", "10:30") }).then(() => null, (e: ApiError) => e);
    expect(err).toMatchObject({ status: 422, code: "doctor_no_disponible" });
    expect(`${err!.message} ${JSON.stringify(err!.body ?? {})}`).not.toMatch(/Quintana|Cirug|evento|personal/i);
    expect(await code(book({ scheduledAtUtc: at("2026-11-12", "10:00") }))).toBe("422 doctor_no_disponible");
    expect((await book({ scheduledAtUtc: at("2026-11-12", "11:00") })).status).toBe("agendada");       // al terminar el evento, si
    // el evento NO ocupa consultorio: otros dos doctores usan los DOS a esa misma hora
    expect((await book({ doctorId: D.bordas, scheduledAtUtc: at("2026-11-12", "10:00") })).room).not.toBeNull();
    expect((await book({ doctorId: D.torrealba, scheduledAtUtc: at("2026-11-12", "10:00") })).room).not.toBeNull();
    await asDoctor();
    await api.doctorSelf.personalEvents.remove(made.id);
    await api.auth.logout();
    await login("staff");
    expect((await book({ scheduledAtUtc: at("2026-11-12", "10:30") })).status).toBe("agendada");
  });

  it("el personal solo ve «ocupado» (doctor y horas): nunca el titulo ni las notas, por ninguna ruta", async () => {
    await asDoctor();
    await api.doctorSelf.personalEvents.create(ev({ title: TITULO, notes: NOTAS }));
    await api.auth.logout();
    await login("staff");
    const busy = await api.busyTimes.list(week);
    expect(busy).toEqual([{ id: expect.any(String), doctorId: "d1", startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "11:00") }]);
    for (const text of [JSON.stringify(busy), JSON.stringify(await api.appointments.list(week)), JSON.stringify(await api.absences.list(week)),
                        JSON.stringify(await api.doctors.list()), JSON.stringify(await api.attention.list("open"))]) {
      expect(text).not.toMatch(/Quintana|Cirug|hipertensi/i);
    }
    expect(await api.busyTimes.list({ from: at("2026-11-12", "11:00"), to: at("2026-11-13", "00:00") })).toEqual([]); // [from, to)
  });

  it("no cae sobre una cita agendada: 409 evento_con_cita, tambien al mover un evento", async () => {
    await book({ scheduledAtUtc: at("2026-11-12", "11:00") }); // cita 11:00 a 11:30 del doctor 1
    const cancelled = await book({ scheduledAtUtc: at("2026-11-12", "12:00") });
    await api.appointments.update(cancelled.id, { status: "cancelada" });
    await book({ doctorId: D.bordas, scheduledAtUtc: at("2026-11-12", "10:00") }); // la de OTRO doctor no estorba
    await asDoctor();
    expect(await code(api.doctorSelf.personalEvents.create(ev({ startUtc: at("2026-11-12", "10:30"), endUtc: at("2026-11-12", "11:30") })))).toBe("409 evento_con_cita");
    expect(await api.doctorSelf.personalEvents.list(week)).toEqual([]);                                  // no se creo nada
    const before = await api.doctorSelf.personalEvents.create(ev({ startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "11:00") })); // pegado antes: cabe
    await api.doctorSelf.personalEvents.create(ev({ startUtc: at("2026-11-12", "11:30"), endUtc: at("2026-11-12", "12:30") }));              // pegado despues (y sobre la cancelada): cabe
    await api.doctorSelf.personalEvents.create(ev({ startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "10:30") }));              // y se pueden encimar entre si
    expect(await code(api.doctorSelf.personalEvents.update(before.id, { endUtc: at("2026-11-12", "11:30") }))).toBe("409 evento_con_cita");
    expect((await api.doctorSelf.personalEvents.list(week)).find((x) => x.id === before.id)!.endUtc).toBe(at("2026-11-12", "11:00")); // intacto
    expect((await api.doctorSelf.personalEvents.update(before.id, { title: "Solo el texto" })).title).toBe("Solo el texto");      // el texto no se compara con las citas
  });

  it("valida titulo, notas, horario, 24 h y fechas absurdas (422 validacion)", async () => {
    await asDoctor();
    const post = (body: object) => lax.doctorSelf.personalEvents.create(body as never);
    const base = { startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "11:00") };
    for (const body of [
      {}, { ...base }, { ...base, title: "" }, { ...base, title: "   " }, { ...base, title: 5 }, { ...base, title: "x".repeat(121) },
      { ...base, title: "x", notes: "y".repeat(1001) }, { ...base, title: "x", notes: 5 },
      { title: "x", startUtc: "no-es-fecha", endUtc: "y" },
      { title: "x", startUtc: at("2026-11-12", "11:00"), endUtc: at("2026-11-12", "10:00") },
      { title: "x", startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-13", "10:30") },       // mas de 24 h
      { title: "x", startUtc: at("2028-11-12", "10:00"), endUtc: at("2028-11-12", "11:00") },       // dos anios adelante
    ]) {
      expect(await code(post(body)), JSON.stringify(body)).toBe("422 validacion");
    }
    expect((await post({ title: "x".repeat(120), notes: "y".repeat(1000), ...base })).title).toHaveLength(120);
    expect((await post({ title: "Todo el dia", startUtc: at("2026-11-13", "00:00"), endUtc: at("2026-11-14", "00:00") })).title).toBe("Todo el dia"); // 24 h justas
    const made = (await api.doctorSelf.personalEvents.list(week))[0]!;
    expect(await code(lax.doctorSelf.personalEvents.update(made.id, {}))).toBe("422 validacion");
    expect(await code(lax.doctorSelf.personalEvents.update(made.id, { title: "" }))).toBe("422 validacion");
    expect(await code(lax.doctorSelf.personalEvents.list({ from: at("2026-11-01", "00:00"), to: at("2027-03-01", "00:00") }))).toBe("422 rango_invalido");
  });

  it("un doctor no ve ni toca los eventos de otro (404, no 403)", async () => {
    mock.db.personalEvents.push({ id: "pe-ajeno", doctorId: D.bordas, title: TITULO, notes: NOTAS, startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "11:00") });
    await asDoctor();
    expect(await api.doctorSelf.personalEvents.list(week)).toEqual([]);
    expect(await code(api.doctorSelf.personalEvents.update("pe-ajeno", { title: "mio" }))).toBe("404 no_encontrado");
    expect(await code(api.doctorSelf.personalEvents.remove("pe-ajeno"))).toBe("404 no_encontrado");
    expect(await code(api.doctorSelf.personalEvents.remove("nadie"))).toBe("404 no_encontrado");
    expect(mock.db.personalEvents.map((x) => x.title)).toEqual([TITULO]);                                // sigue ahi, intacto
  });

  it("cada rol usa lo suyo: el personal no usa la API del doctor y el doctor no ve los «ocupado» de todos", async () => {
    expect(await code(lax.doctorSelf.personalEvents.list(week))).toBe("403 sin_permiso");
    expect(await code(lax.doctorSelf.personalEvents.create(ev()))).toBe("403 sin_permiso");
    await asDoctor();
    expect(await code(lax.busyTimes.list(week))).toBe("403 sin_permiso");
  });

  it("al eliminar un doctor se van sus eventos", async () => {
    await api.auth.logout();
    await login("admin");
    const doc = await api.doctors.create({ name: "Dr. Por Error", specialty: "Cardiología" });
    mock.db.personalEvents.push({ id: "pe-x", doctorId: doc.id, title: "Algo", notes: null, startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "11:00") });
    await api.doctors.remove(doc.id);
    expect(mock.db.personalEvents).toEqual([]);
  });
});

describe("marca de la clínica (nombre y logotipo)", () => {
  const png128 = png(128);
  const asAdmin = async () => {
    await api.auth.logout();
    await login("admin");
  };

  it("sin sesión ya se ve la marca por defecto (la usa el login); sin logotipo, el logotipo es 404", async () => {
    await api.auth.logout();
    expect(await api.branding.get()).toEqual({ name: "Clínica CUBAMEX", logoUrl: null });
    const res = await mock.fetch("/api/branding/logo");
    expect(res.status).toBe(404);
    expect(await api.branding.logo("/api/branding/logo")).toBeNull();
  });

  it("solo el administrador cambia el nombre y el logotipo (personal y doctor: 403; sin sesión: 401)", async () => {
    expect(await code(api.branding.setName("Hackeada"))).toBe("403 sin_permiso");                    // soy el personal
    expect(await code(api.branding.uploadLogo(png128, "image/png"))).toBe("403 sin_permiso");
    expect(await code(api.branding.removeLogo())).toBe("403 sin_permiso");
    await api.auth.logout();
    await login("doctor");
    expect(await code(api.branding.setName("Hackeada"))).toBe("403 sin_permiso");
    await api.auth.logout();
    expect(await code(lax.branding.setName("Hackeada"))).toBe("401 no_autenticado");
    expect((await api.branding.get()).name).toBe("Clínica CUBAMEX");                                   // nada cambió
  });

  it("el administrador cambia el nombre (espacios normalizados) y todos lo ven, incluso sin sesión", async () => {
    await asAdmin();
    expect(await api.branding.setName("  Clínica   Santa  María \n")).toEqual({ name: "Clínica Santa María", logoUrl: null });
    await api.auth.logout();
    expect((await api.branding.get()).name).toBe("Clínica Santa María");
  });

  it("nombre inválido: vacío, solo espacios, no texto o de más de 80 caracteres (422)", async () => {
    await asAdmin();
    for (const body of [{}, { name: "" }, { name: "   " }, { name: 5 }, { name: null }, { name: "x".repeat(81) }]) {
      expect(await code(lax.branding.setName((body as { name?: string }).name as string)), JSON.stringify(body)).toBe("422 validacion");
    }
    expect((await api.branding.setName("x".repeat(80))).name).toHaveLength(80);
  });

  it("sube un logotipo cuadrado: se sirve igual, con su tipo y su huella, y también se ve sin sesión", async () => {
    await asAdmin();
    const b = await api.branding.uploadLogo(png128, "image/png");
    expect(b.logoUrl).toMatch(/^\/api\/branding\/logo\?v=[0-9a-f]{8}$/);
    await api.auth.logout();
    const pub = await api.branding.get();
    expect(pub.logoUrl).toBe(b.logoUrl);
    const img = await api.branding.logo(pub.logoUrl!);
    expect(img!.contentType).toBe("image/png");
    expect([...img!.bytes]).toEqual([...png128]);
    // ETag: lo mismo = 304
    const res = await mock.fetch(pub.logoUrl!);
    const again = await mock.fetch(pub.logoUrl!, { headers: { "If-None-Match": res.headers.get("ETag")! } });
    expect(again.status).toBe(304);
  });

  it("acepta JPG y WebP, y el tipo sale de los bytes (no de lo que diga el cliente)", async () => {
    await asAdmin();
    for (const [bytes, tipo] of [[jpeg(300), "image/jpeg"], [webpLossless(300), "image/webp"], [webpLossy(300), "image/webp"], [webpExtended(300), "image/webp"]] as const) {
      await api.branding.uploadLogo(bytes, "image/png");                                             // dice PNG
      expect((await api.branding.logo((await api.branding.get()).logoUrl!))!.contentType).toBe(tipo);
    }
  });

  it("un logotipo nuevo cambia la dirección (otra huella) y reemplaza al anterior", async () => {
    await asAdmin();
    const a = (await api.branding.uploadLogo(png(128), "image/png")).logoUrl;
    const b = (await api.branding.uploadLogo(png(192), "image/png")).logoUrl;
    expect(a).not.toBe(b);
    expect((await api.branding.logo(b!))!.bytes).toHaveLength(png(192).length);
  });

  it("lo que no sirve es 422 con el motivo y no cambia nada: no cuadrada, chica, enorme, SVG, vacío, de más de 1 MB", async () => {
    await asAdmin();
    const bueno = await api.branding.uploadLogo(png128, "image/png");
    const motivo = async (bytes: Uint8Array) => {
      const e = await api.branding.uploadLogo(bytes, "image/png").then(() => null, (x: ApiError) => x);
      expect(e, "debía rechazarse").toBeInstanceOf(ApiError);
      expect(`${e!.status} ${e!.code}`).toBe("422 validacion");
      return e!.detail;
    };
    expect(await motivo(png(800, 600))).toBe("La imagen debe ser cuadrada (1:1); esta mide 800 × 600 px.");
    expect(await motivo(png(32))).toMatch(/muy pequeña/);
    expect(await motivo(png(4096))).toMatch(/muy grande/);
    expect(await motivo(svg())).toBe("Sube una imagen PNG, JPG o WebP.");
    expect(await motivo(gif())).toBe("Sube una imagen PNG, JPG o WebP.");
    expect(await motivo(new Uint8Array())).toBe("No llegó ningún archivo.");
    expect(await motivo(padTo(png(128), LOGO_MAX_BYTES + 1))).toBe("La imagen pesa más de 1 MB.");
    expect((await api.branding.get()).logoUrl).toBe(bueno.logoUrl);                                   // sigue el anterior
    await api.branding.uploadLogo(padTo(png(128), LOGO_MAX_BYTES), "image/png");                      // 1 MB justo, sí
  });

  it("quitar el logotipo vuelve al icono por defecto; repetirlo no falla; el nombre es independiente", async () => {
    await asAdmin();
    await api.branding.uploadLogo(png128, "image/png");
    await api.branding.setName("Otra Clínica");
    expect((await api.branding.get()).name).toBe("Otra Clínica");                                     // cambiar el nombre no quita el logotipo
    expect((await api.branding.get()).logoUrl).not.toBeNull();
    expect(await api.branding.removeLogo()).toEqual({ name: "Otra Clínica", logoUrl: null });          // quitar el logotipo no cambia el nombre
    expect((await api.branding.removeLogo()).logoUrl).toBeNull();
    expect((await mock.fetch("/api/branding/logo")).status).toBe(404);
  });
});

describe("entrada del doctor con su código", () => {
  const doctorAcc = () => DEMO_ACCOUNTS.find((a) => a.role === "doctor")!;

  beforeEach(async () => {
    await api.auth.logout(); // la lista y el login por código son para quien aún no tiene sesión
  });

  it("la lista es pública y trae solo código y nombre de quienes tienen cuenta activa, por código", async () => {
    expect(await api.auth.loginDoctors()).toEqual([{ code: "1001", name: "Dr. Cervantes Peláez" }]);
    // otro doctor con cuenta: aparece en su lugar; uno sin cuenta, no
    mock.db.users.push({ id: "u90", email: "bordas@clinica.test", name: "Dra. Bordas", role: "doctor", doctorId: "d3", active: true, password: "demo-bordas-2026" });
    mock.db.users.push({ id: "u91", email: "perez@clinica.test", name: "Dr. Perez", role: "doctor", doctorId: "d2", active: true, password: "demo-perez-2026" });
    const list = await api.auth.loginDoctors();
    expect(list.map((d) => d.code)).toEqual(["1001", "1002", "1003"]);
    expect(list.every((d) => Object.keys(d).sort().join() === "code,name")).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/@|demo-/); // nada de la cuenta
    // la baja de la cuenta la saca de la lista; un doctor con dos cuentas sale una sola vez
    mock.db.users.find((u) => u.id === "u91")!.active = false;
    mock.db.users.push({ id: "u92", email: "bordas2@clinica.test", name: "Otra cuenta", role: "doctor", doctorId: "d3", active: true, password: "demo-bordas-2026" });
    expect((await api.auth.loginDoctors()).map((d) => d.code)).toEqual(["1001", "1003"]);
  });

  it("entra con código y contraseña (sin correo): sesión de doctor, token CSRF y /me", async () => {
    const acc = doctorAcc();
    const info = await api.auth.loginDoctor(acc.doctorCode!, acc.password);
    expect(info.user).toMatchObject({ role: "doctor", doctorId: "d1", email: acc.email });
    expect(info.csrfToken).toBeTruthy();
    expect(api.csrfToken).toBe(info.csrfToken);
    expect((await api.auth.me()).user.id).toBe(info.user.id);
    expect((await api.doctorSelf.hours()).code).toBe("1001"); // y es SU agenda
  });

  it("un código que no existe, un doctor sin cuenta, un código mal formado y una contraseña mala son el mismo 401", async () => {
    const acc = doctorAcc();
    expect(await code(api.auth.loginDoctor("1001", "mal"))).toBe("401 credenciales_invalidas");
    expect(await code(api.auth.loginDoctor("9999", acc.password))).toBe("401 credenciales_invalidas");
    expect(await code(api.auth.loginDoctor("1005", acc.password))).toBe("401 credenciales_invalidas"); // doctor sin cuenta
    expect(await code(lax.auth.loginDoctor("abcd", acc.password))).toBe("401 credenciales_invalidas");
    expect(await code(api.auth.loginDoctor("1001", DEMO_ACCOUNTS.find((a) => a.role === "staff")!.password))).toBe("401 credenciales_invalidas"); // la del personal
  });

  it("la cuenta dada de baja no entra", async () => {
    mock.db.users.find((u) => u.role === "doctor")!.active = false;
    expect(await code(api.auth.loginDoctor("1001", doctorAcc().password))).toBe("401 credenciales_invalidas");
    expect(await api.auth.loginDoctors()).toEqual([]);
  });

  it("falta el código o la contraseña = 422; 5 contraseñas malas bloquean la cuenta (también para el correo)", async () => {
    expect(await code(lax.auth.loginDoctor("", "x"))).toBe("422 validacion");
    const acc = doctorAcc();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect(await code(api.auth.loginDoctor(acc.doctorCode!, "mal"))).toBe("401 credenciales_invalidas");
    expect(await code(api.auth.loginDoctor(acc.doctorCode!, acc.password))).toBe("429 demasiados_intentos"); // ni con la buena
    expect(await code(api.auth.login(acc.email, acc.password))).toBe("429 demasiados_intentos"); // el contador es de la cuenta
  });

  it("un doctor nuevo recibe el menor código libre y el código no se edita", async () => {
    await login("admin");
    const nuevo = await api.doctors.create({ name: "Dr. Nuevo", specialty: "Cardiología" });
    expect(nuevo.code).toBe("1008");
    const editado = await lax.doctors.update(nuevo.id, { specialty: "Cardiología clínica", code: "9999" } as never);
    expect(editado).toMatchObject({ code: "1008", specialty: "Cardiología clínica" });
    expect((await api.doctors.list()).map((d) => d.code)).toEqual(["1001", "1002", "1003", "1004", "1005", "1006", "1007", "1008"]);
  });
});

describe("cuenta del doctor y enlace para su contraseña", () => {
  const NEW = "mi-contrasena-nueva-1";
  const tokenOf = (url: string) => url.split("?t=")[1]!;
  const accountOf = (doctorId: string) => mock.db.users.filter((u) => u.doctorId === doctorId);

  it("al dar de alta un doctor se crea su cuenta SIN correo y SIN contraseña, y no puede entrar ni sale en la lista de la entrada", async () => {
    const d = await api.doctors.create({ name: "Dr. Nuevo", specialty: "Cardiología" });
    expect(accountOf(d.id).map((u) => ({ email: u.email, password: u.password, active: u.active, name: u.name, role: u.role }))).toEqual([
      { email: null, password: null, active: true, name: "Dr. Nuevo", role: "doctor" },
    ]);
    await login("admin");
    const listed = (await api.users.list()).find((u) => u.doctorId === d.id)!;
    expect(listed).toMatchObject({ email: null, role: "doctor", passwordSet: false });
    await api.auth.logout();
    for (let i = 0; i < LOGIN_MAX_FAILURES + 2; i++) expect(await code(api.auth.loginDoctor(d.code, `intento-numero-${i}`))).toBe("401 credenciales_invalidas"); // nunca 429
    expect((await api.auth.loginDoctors()).map((x) => x.code)).not.toContain(d.code);
  });

  it("renombrar al doctor renombra su cuenta", async () => {
    const d = await api.doctors.create({ name: "Dr. Viejo", specialty: "X" });
    await api.doctors.update(d.id, { name: "Dr. Renombrado" });
    expect(accountOf(d.id).map((u) => u.name)).toEqual(["Dr. Renombrado"]);
  });

  it("el personal genera el enlace; el doctor lo abre, ve de quién es y establece su contraseña: queda dentro y puede entrar con su código", async () => {
    const d = await api.doctors.create({ name: "Dra. Con Enlace", specialty: "Pediatría" });
    const link = await api.doctors.createPasswordLink(d.id);
    expect(link.url).toMatch(/^https:\/\/clinica\.test\/doctor\/#\/contrasena\?t=[A-Za-z0-9]{32}$/);
    expect(new Date(link.expiresAtUtc).getTime()).toBe(NOW.getTime() + 72 * 3600_000);
    const token = tokenOf(link.url);

    await api.auth.logout(); // ahora es el doctor, sin sesión
    expect(await api.auth.checkPasswordLink(token)).toEqual({ doctorCode: d.code, doctorName: "Dra. Con Enlace", expiresAtUtc: link.expiresAtUtc });
    expect(await api.auth.checkPasswordLink(token)).toBeTruthy(); // revisarlo no lo gasta
    const info = await api.auth.usePasswordLink(token, NEW);
    expect(info.user).toMatchObject({ role: "doctor", doctorId: d.id, email: null, passwordSet: true });
    expect(api.csrfToken).toBe(info.csrfToken);
    expect((await api.auth.me()).user.id).toBe(info.user.id);

    expect(await code(api.auth.checkPasswordLink(token))).toBe("404 enlace_invalido"); // un solo uso
    expect(await code(api.auth.usePasswordLink(token, "otra-contrasena-larga-2"))).toBe("404 enlace_invalido");
    await api.auth.logout();
    expect((await api.auth.loginDoctor(d.code, NEW)).user.doctorId).toBe(d.id); // entra con su código
    await api.auth.logout();
    expect((await api.auth.loginDoctors()).map((x) => x.code)).toContain(d.code);
  });

  it("una contraseña que no cumple es 422 y no gasta el enlace; un enlace nuevo reemplaza al anterior; uno desconocido es 404", async () => {
    const d = await api.doctors.create({ name: "Dr. Reemplazo", specialty: "X" });
    const t1 = tokenOf((await api.doctors.createPasswordLink(d.id)).url);
    const t2 = tokenOf((await api.doctors.createPasswordLink(d.id)).url);
    expect(t1).not.toBe(t2);
    await api.auth.logout();
    expect(await code(api.auth.checkPasswordLink(t1))).toBe("404 enlace_invalido");
    expect(await code(lax.auth.usePasswordLink(t2, "corta"))).toBe("422 validacion");
    expect(await code(lax.auth.usePasswordLink("", NEW))).toBe("422 validacion");
    expect(await code(api.auth.checkPasswordLink("x".repeat(32)))).toBe("404 enlace_invalido");
    expect((await api.auth.usePasswordLink(t2, NEW)).user.doctorId).toBe(d.id); // el enlace seguía vigente
  });

  it("el enlace vence a las 72 horas", async () => {
    const d = await api.doctors.create({ name: "Dr. Tarde", specialty: "X" });
    const token = tokenOf((await api.doctors.createPasswordLink(d.id)).url);
    await api.auth.logout();
    clock = new Date(NOW.getTime() + 72 * 3600_000 - 1000);
    expect((await api.auth.checkPasswordLink(token)).doctorCode).toBe(d.code);
    clock = new Date(NOW.getTime() + 72 * 3600_000 + 1000);
    expect(await code(api.auth.checkPasswordLink(token))).toBe("404 enlace_invalido");
    expect(await code(api.auth.usePasswordLink(token, NEW))).toBe("404 enlace_invalido");
  });

  it("recuperar una contraseña olvidada: el enlace pone otra, cierra la sesión anterior, quita el bloqueo y la vieja ya no sirve", async () => {
    const acc = DEMO_ACCOUNTS.find((a) => a.role === "doctor")!;
    const token = tokenOf((await api.doctors.createPasswordLink("d1")).url); // el doctor de ejemplo ya tenía cuenta y contraseña
    expect(accountOf("d1")).toHaveLength(1); // no se crea otra
    await api.auth.logout();
    await api.auth.loginDoctor(acc.doctorCode!, acc.password); // el doctor tiene una sesión abierta
    const sesionesAntes = [...mock.db.sessions.entries()].filter(([, s]) => s.userId === accountOf("d1")[0]!.id).map(([sid]) => sid);
    expect(sesionesAntes).toHaveLength(1);
    await api.auth.logout();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await code(api.auth.loginDoctor(acc.doctorCode!, "no-es")); // se le olvida: se bloquea
    expect(await code(api.auth.loginDoctor(acc.doctorCode!, acc.password))).toBe("429 demasiados_intentos");

    await api.auth.usePasswordLink(token, NEW);
    const sesionesDespues = [...mock.db.sessions.entries()].filter(([, s]) => s.userId === accountOf("d1")[0]!.id).map(([sid]) => sid);
    expect(sesionesDespues).toHaveLength(1);
    expect(sesionesDespues[0]).not.toBe(sesionesAntes[0]); // la sesión anterior se cerró y quedó solo la nueva
    await api.auth.logout();
    expect(await code(api.auth.loginDoctor(acc.doctorCode!, acc.password))).toBe("401 credenciales_invalidas"); // la vieja ya no sirve
    expect((await api.auth.loginDoctor(acc.doctorCode!, NEW)).user.doctorId).toBe("d1"); // y el bloqueo se quitó
  });

  it("un doctor anterior sin cuenta la recibe al generar el enlace; con la cuenta desactivada es 422; un doctor no genera enlaces", async () => {
    expect(accountOf("d5")).toHaveLength(0);
    await api.doctors.createPasswordLink("d5");
    expect(accountOf("d5").map((u) => [u.email, u.password])).toEqual([[null, null]]);
    accountOf("d5")[0]!.active = false;
    expect(await code(api.doctors.createPasswordLink("d5"))).toBe("422 validacion");
    expect(await code(api.doctors.createPasswordLink("d99"))).toBe("404 no_encontrado");
    await api.auth.logout();
    await api.auth.loginDoctor("1001", DEMO_ACCOUNTS.find((a) => a.role === "doctor")!.password);
    lax.csrfToken = api.csrfToken;
    expect(await code(lax.doctors.createPasswordLink("d1"))).toBe("403 sin_permiso");
  });

  it("eliminar un doctor: su cuenta recién creada (sin contraseña) se va con él; con contraseña ya no se deja", async () => {
    await login("admin");
    const d1 = await api.doctors.create({ name: "Dr. Por Error", specialty: "X" });
    await api.doctors.remove(d1.id);
    expect(accountOf(d1.id)).toHaveLength(0);
    expect(mock.db.doctors.some((x) => x.id === d1.id)).toBe(false);

    const d2 = await api.doctors.create({ name: "Dr. Con Clave", specialty: "X" });
    const token = tokenOf((await api.doctors.createPasswordLink(d2.id)).url);
    await api.auth.logout();
    await api.auth.usePasswordLink(token, NEW); // el doctor establece su contraseña
    await api.auth.logout();
    await login("admin");
    expect(await code(api.doctors.remove(d2.id))).toBe("409 doctor_con_usuario");
    expect(accountOf(d2.id)).toHaveLength(1);
  });
});

describe("horarios libres para mover una cita", () => {
  const ALL = Array.from({ length: 18 }, (_, i) => `${String(9 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`); // 09:00 .. 17:30
  const slotsOf = async (id: string, from: string, to: string, extra: { roomId?: string; allowShortNotice?: boolean } = {}) =>
    Object.fromEntries((await api.appointments.moveSlots(id, { from, to, ...extra })).days.map((d) => [d.date, d.slots]));
  const accepted = async (id: string, day: string, hhmm: string, extra: { roomId?: string; allowShortNotice?: boolean } = {}) => {
    try {
      await api.appointments.update(id, { scheduledAtUtc: at(day, hhmm), ...extra });
      return true;
    } catch (e) {
      if (e instanceof ApiError) return false;
      throw e;
    }
  };

  it("lista por día los horarios de la clínica; su propio horario cuenta como libre; hoy faltan 60 minutos de antelación; el domingo no sale", async () => {
    const b = await book({ scheduledAtUtc: at("2026-11-12", "11:00") });
    const d = await slotsOf(b.id, "2026-11-10", "2026-11-16");
    expect(d["2026-11-10"]).toEqual(ALL.filter((t) => t >= "11:00")); // ahora son las 10:00
    expect(d["2026-11-12"]).toEqual(ALL);
    expect(d["2026-11-14"]).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]); // sábado
    expect(d["2026-11-15"]).toBeUndefined(); // domingo
    const r = await api.appointments.moveSlots(b.id, { from: "2026-11-10", to: "2026-11-11" });
    expect(r).toMatchObject({ slotMinutes: 30, durationMinutes: 30 });
  });

  it("el doctor ocupado, los dos consultorios llenos, una ausencia y un evento personal quitan horarios; con roomId solo cuenta ese consultorio", async () => {
    const b = await book({ scheduledAtUtc: at("2026-11-12", "11:00") });
    await book({ patientName: "Beto Ruiz", scheduledAtUtc: at("2026-11-12", "12:00") }); // mismo doctor
    await book({ patientName: "Carla Mena", doctorId: D.bordas, scheduledAtUtc: at("2026-11-13", "10:00") }); // otro doctor: ocupa UN consultorio
    await api.doctors.absences.create(D.cervantes, { startUtc: at("2026-11-11", "14:00"), endUtc: at("2026-11-11", "16:00") });
    mock.db.personalEvents.push({ id: "pe-x", doctorId: D.cervantes, title: "Dentista", notes: null, startUtc: at("2026-11-11", "09:00"), endUtc: at("2026-11-11", "10:00") });
    let d = await slotsOf(b.id, "2026-11-11", "2026-11-14");
    expect(d["2026-11-12"]).not.toContain("12:00");
    expect(d["2026-11-12"]).toContain("11:30");
    expect(ALL.filter((t) => !d["2026-11-11"]!.includes(t))).toEqual(["09:00", "09:30", "14:00", "14:30", "15:00", "15:30"]); // evento personal + ausencia
    expect(d["2026-11-13"]).toContain("10:00"); // un consultorio libre basta
    await book({ patientName: "Diego Pardo", doctorId: D.torrealba, scheduledAtUtc: at("2026-11-13", "10:00") }); // y el segundo consultorio
    d = await slotsOf(b.id, "2026-11-11", "2026-11-14");
    expect(d["2026-11-13"]).not.toContain("10:00");
    const r1 = await slotsOf(b.id, "2026-11-13", "2026-11-14", { roomId: "r1" });
    const r2 = await slotsOf(b.id, "2026-11-13", "2026-11-14", { roomId: "r2" });
    expect(r1["2026-11-13"]).not.toContain("10:00");
    expect(r2["2026-11-13"]).not.toContain("10:00"); // los dos llenos a esa hora
    expect(r1["2026-11-13"]).toContain("09:30");
  });

  it("lo que se lista es exactamente lo que el movimiento acepta (cita normal, de mostrador y bloqueo de consultorio)", async () => {
    const b = await book({ scheduledAtUtc: at("2026-11-12", "11:00") });
    await book({ patientName: "Beto Ruiz", scheduledAtUtc: at("2026-11-13", "12:00") });
    await book({ patientName: "Carla Mena", doctorId: D.perez, scheduledAtUtc: at("2026-11-12", "10:00") }); // d2: martes y jueves de 10 a 14
    await book({ patientName: "Diego Pardo", doctorId: D.bordas, scheduledAtUtc: at("2026-11-12", "10:00") }); // los dos consultorios llenos
    await api.doctors.absences.create(D.cervantes, { startUtc: at("2026-11-13", "15:00"), endUtc: at("2026-11-13", "17:00") });
    const days = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"];
    const times = Array.from({ length: 26 }, (_, i) => `${String(7 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
    const check = async (id: string, extra: { roomId?: string; allowShortNotice?: boolean } = {}, only?: string[]) => {
      const listed = await slotsOf(id, days[0]!, "2026-11-17", extra);
      const wrong: string[] = [];
      for (const day of only ?? days) for (const t of times) if ((await accepted(id, day, t, extra)) !== (listed[day] ?? []).includes(t)) wrong.push(`${day} ${t}`);
      return wrong;
    };
    expect(await check(b.id)).toEqual([]);
    expect(await check(b.id, { roomId: "r2" }, days.slice(0, 4))).toEqual([]);
    expect(await check(b.id, { allowShortNotice: true }, ["2026-11-10"])).toEqual([]);
    const blk = await api.appointments.create({ kind: "block", roomId: "r1", scheduledAtUtc: at("2026-11-12", "13:00"), durationMinutes: 60 });
    const listedBlock = await slotsOf(blk.id, "2026-11-11", "2026-11-13");
    expect(listedBlock["2026-11-11"]![0]).toBe("07:00");
    expect(listedBlock["2026-11-11"]).toHaveLength(26);
    expect(await check(blk.id, {}, ["2026-11-11", "2026-11-12"])).toEqual([]);
  });

  it("errores: rango inválido, más de 42 días, consultorio inexistente, cita que no existe o ya cancelada", async () => {
    const b = await book({ scheduledAtUtc: at("2026-11-12", "11:00") });
    expect(await code(lax.appointments.moveSlots(b.id, { from: "2026-11-10", to: "2026-11-10" }))).toBe("422 rango_invalido");
    expect(await code(lax.appointments.moveSlots(b.id, { from: "2026-11-10", to: "2026-12-23" }))).toBe("422 rango_invalido"); // 43 días
    expect((await api.appointments.moveSlots(b.id, { from: "2026-11-10", to: "2026-12-22" })).days.length).toBeGreaterThan(0); // 42 justos
    expect(await code(lax.appointments.moveSlots(b.id, { from: "ayer", to: "hoy" }))).toBe("422 validacion");
    expect(await code(lax.appointments.moveSlots(b.id, { from: "2026-11-10", to: "2026-11-12", roomId: "r99" }))).toBe("422 validacion");
    expect(await code(api.appointments.moveSlots("b999", { from: "2026-11-10", to: "2026-11-12" }))).toBe("404 no_encontrado");
    await api.appointments.update(b.id, { status: "cancelada" });
    expect(await code(api.appointments.moveSlots(b.id, { from: "2026-11-10", to: "2026-11-12" }))).toBe("409 transicion_invalida");
  });

  it("el doctor no puede consultarlo", async () => {
    const b = await book({ scheduledAtUtc: at("2026-11-12", "11:00") });
    await api.auth.logout();
    const acc = DEMO_ACCOUNTS.find((a) => a.role === "doctor")!;
    await api.auth.loginDoctor(acc.doctorCode!, acc.password);
    lax.csrfToken = api.csrfToken;
    expect(await code(lax.appointments.moveSlots(b.id, { from: "2026-11-10", to: "2026-11-12" }))).toBe("403 sin_permiso");
  });
});

describe("horarios libres para una cita nueva", () => {
  const ALL = Array.from({ length: 18 }, (_, i) => `${String(9 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`); // 09:00 .. 17:30
  type Q = { doctorId?: string; roomId?: string; durationMinutes?: number; kind?: "session" | "block"; allowShortNotice?: boolean };
  const listed = async (from: string, to: string, q: Q = {}) =>
    Object.fromEntries((await api.appointments.availability({ from, to, ...q })).days.map((d) => [d.date, d.slots]));
  /** ¿La acepta `create`? Si la crea la cancela al instante (libera el hueco para la siguiente prueba). */
  const creates = async (day: string, hhmm: string, q: Q) => {
    try {
      const b = await api.appointments.create(
        q.kind === "block"
          ? { kind: "block", roomId: q.roomId, scheduledAtUtc: at(day, hhmm), durationMinutes: q.durationMinutes }
          : { patientName: "Zoe Prueba", doctorId: q.doctorId, scheduledAtUtc: at(day, hhmm), durationMinutes: q.durationMinutes, roomId: q.roomId, allowShortNotice: q.allowShortNotice }
      );
      await api.appointments.update(b.id, { status: "cancelada" });
      return true;
    } catch (e) {
      if (e instanceof ApiError) return false;
      throw e;
    }
  };

  it("lista por día los horarios del doctor; una cita que ya tiene ese horario NO cuenta como libre (es nueva); hoy faltan 60 minutos", async () => {
    await book({ scheduledAtUtc: at("2026-11-12", "10:00") });
    const d = await listed("2026-11-10", "2026-11-16", { doctorId: D.cervantes });
    expect(d["2026-11-10"]).toEqual(ALL.filter((t) => t >= "11:00")); // ahora son las 10:00
    expect(d["2026-11-12"]).toEqual(ALL.filter((t) => t !== "10:00"));
    expect(d["2026-11-15"]).toBeUndefined();
    const r = await api.appointments.availability({ from: "2026-11-12", to: "2026-11-13", doctorId: D.cervantes, durationMinutes: 60 });
    expect(r.durationMinutes).toBe(60);
    expect(r.days[0]!.slots).not.toContain("09:30");
    expect(r.days[0]!.slots).toContain("10:30");
  });

  it("lo que se lista es exactamente lo que crear acepta (cita de 30 y de 60 min, un consultorio, de mostrador y bloqueo)", async () => {
    await book({ scheduledAtUtc: at("2026-11-12", "10:00") });
    await book({ patientName: "Beto Ruiz", scheduledAtUtc: at("2026-11-13", "12:00") });
    await book({ patientName: "Carla Mena", doctorId: D.perez, scheduledAtUtc: at("2026-11-12", "12:00") });
    await book({ patientName: "Diego Pardo", doctorId: D.bordas, scheduledAtUtc: at("2026-11-12", "12:00") }); // los dos consultorios llenos
    await api.doctors.absences.create(D.cervantes, { startUtc: at("2026-11-13", "15:00"), endUtc: at("2026-11-13", "17:00") });
    const days = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
    const times = Array.from({ length: 26 }, (_, i) => `${String(7 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
    const mismatches = async (q: Q, only = days) => {
      const l = await listed(days[0]!, "2026-11-17", q);
      const wrong: string[] = [];
      for (const day of only) for (const t of times) if ((await creates(day, t, q)) !== (l[day] ?? []).includes(t)) wrong.push(`${day} ${t}`);
      return wrong;
    };
    expect(await mismatches({ doctorId: D.cervantes })).toEqual([]);
    expect(await mismatches({ doctorId: D.cervantes, durationMinutes: 60 })).toEqual([]);
    expect(await mismatches({ doctorId: D.cervantes, roomId: "r2" }, days.slice(0, 4))).toEqual([]);
    expect(await mismatches({ doctorId: D.cervantes, allowShortNotice: true }, ["2026-11-10"])).toEqual([]);
    await book({ patientName: "Elena Soto", doctorId: D.torrealba, scheduledAtUtc: at("2026-11-12", "15:00") }); // ocupa el consultorio 1
    const blockQ: Q = { kind: "block", roomId: "r1", durationMinutes: 60 };
    const lb = await listed("2026-11-11", "2026-11-13", blockQ);
    expect(lb["2026-11-12"]).not.toContain("15:00");
    expect(lb["2026-11-12"]![0]).toBe("07:00");
    expect(await mismatches(blockQ, ["2026-11-11", "2026-11-12"])).toEqual([]);
  });

  it("errores: sin doctor, doctor o consultorio que no existen, duración inválida, bloqueo sin consultorio o con doctor, rango", async () => {
    const q = (extra: Record<string, unknown>) => lax.appointments.availability({ from: "2026-11-10", to: "2026-11-12", ...extra } as never);
    expect(await code(q({}))).toBe("422 validacion");
    expect(await code(q({ doctorId: "d99" }))).toBe("422 validacion");
    expect(await code(q({ doctorId: D.cervantes, roomId: "r99" }))).toBe("422 validacion");
    expect(await code(q({ doctorId: D.cervantes, durationMinutes: 45 }))).toBe("422 validacion");
    expect(await code(q({ kind: "block" }))).toBe("422 validacion");
    expect(await code(q({ kind: "block", roomId: "r1", doctorId: D.cervantes }))).toBe("422 validacion");
    expect(await code(lax.appointments.availability({ from: "2026-11-10", to: "2026-11-10", doctorId: D.cervantes }))).toBe("422 rango_invalido");
    expect(await code(lax.appointments.availability({ from: "2026-11-10", to: "2026-12-23", doctorId: D.cervantes }))).toBe("422 rango_invalido");
  });

  it("el doctor no puede consultarlo", async () => {
    await api.auth.logout();
    const acc = DEMO_ACCOUNTS.find((a) => a.role === "doctor")!;
    await api.auth.loginDoctor(acc.doctorCode!, acc.password);
    lax.csrfToken = api.csrfToken;
    expect(await code(lax.appointments.availability({ from: "2026-11-10", to: "2026-11-12", doctorId: "d1" }))).toBe("403 sin_permiso");
  });
});

describe("canales de mensajeria (WhatsApp, Messenger e Instagram)", () => {
  const NUM = "529990000001"; // el MISMO numero, como telefono de WhatsApp y como id de Facebook / Instagram
  const IG = "17841400000000000";
  const CONTACT = "9981234567";

  it("el interruptor es por canal: la forma vieja solo toca WhatsApp y `active` siempre es el de WhatsApp", async () => {
    expect((await api.bot.get()).channels).toEqual({ whatsapp: true, facebook: false, instagram: false });
    let st = await api.bot.setChannel("facebook", true);
    expect(st.channels).toEqual({ whatsapp: true, facebook: true, instagram: false });
    expect(st.channelUpdates!.facebook).toEqual({ updatedAt: NOW.toISOString(), updatedBy: "Recepción Clínica" });
    expect(st.channelUpdates!.instagram).toEqual({ updatedAt: null, updatedBy: null });
    st = await api.bot.set(false); // la forma vieja: apagar WhatsApp NO apaga Messenger
    expect(st.channels).toEqual({ whatsapp: false, facebook: true, instagram: false });
    expect(st.active).toBe(false);
    st = await api.bot.setChannels({ instagram: true, whatsapp: true });
    expect(st.channels).toEqual({ whatsapp: true, facebook: true, instagram: true });
    expect(st.active).toBe(st.channels.whatsapp);
    expect(await api.bot.get()).toEqual(st);
    expect(mock.bot.status()).toEqual(st); // lo que lee el bot
  });

  it("lo invalido de las formas nuevas es 400; en la forma vieja sigue siendo 422", async () => {
    // el cuerpo tal cual (el cliente tipado no deja mandar formas invalidas), con el token CSRF de la sesion
    const put = async (body: unknown) => {
      const r = await mock.fetch("/api/settings/bot", { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-Token": api.csrfToken! }, body: JSON.stringify(body) });
      return `${r.status} ${((await r.json()) as { error: string }).error}`;
    };
    for (const body of [
      { channel: "telegram", active: true },
      { channel: "facebook", active: "si" },
      { channel: "facebook" },
      { channels: {} },
      { channels: { telegram: true } },
      { channels: { facebook: 1 } },
      { channels: { facebook: true }, active: true },
    ]) {
      expect(await put(body), JSON.stringify(body)).toBe("400 validacion");
    }
    for (const body of [{}, { active: "si" }, { active: null }]) expect(await put(body), JSON.stringify(body)).toBe("422 validacion");
    expect((await api.bot.get()).channels).toEqual({ whatsapp: true, facebook: false, instagram: false });
  });

  describe("modo manual o por horario de cada canal", () => {
    const NIGHT = { days: ["mon", "tue", "wed", "thu", "fri"] as const, start: "19:00", end: "08:00" };
    const OFFICE = { days: ["mon", "tue", "wed", "thu", "fri"] as const, start: "09:00", end: "18:00" };
    const put = async (body: unknown) => {
      const r = await mock.fetch("/api/settings/bot", { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-Token": api.csrfToken! }, body: JSON.stringify(body) });
      return `${r.status} ${((await r.json()) as { error?: string }).error ?? "ok"}`;
    };
    // la fecha de la prueba es martes 10 de noviembre de 2026; Cancun es UTC-5
    const at = (day: string, hhmm: string) => new Date(zonedWallClockToUtc(day, hhmm, "America/Cancun")!);

    it("todo nace manual y sin horario; el estado efectivo es el interruptor", async () => {
      const st = await api.bot.get();
      expect(st.modes).toEqual({ whatsapp: "manual", facebook: "manual", instagram: "manual" });
      expect(st.schedules).toEqual({ whatsapp: null, facebook: null, instagram: null });
      expect(st.channels).toEqual(st.manual);
    });

    it("en modo horario el canal se enciende y apaga solo con la hora de Cancun; el interruptor manual se conserva", async () => {
      await api.bot.setChannel("instagram", true);
      let st = await api.bot.configure("instagram", { mode: "schedule", schedule: NIGHT as never });
      expect(st).toMatchObject({ modes: { instagram: "schedule" }, manual: { instagram: true }, schedules: { instagram: NIGHT } });
      expect(st.channels.instagram).toBe(false); // martes 10:00: fuera del horario de noche
      const cases: [string, string, boolean][] = [
        ["2026-11-10", "18:59", false], ["2026-11-10", "19:00", true], ["2026-11-11", "07:59", true], ["2026-11-11", "08:00", false],
        ["2026-11-14", "01:00", true], // la noche del viernes llega al sabado de madrugada
        ["2026-11-14", "20:00", false], ["2026-11-15", "02:00", false], ["2026-11-16", "02:00", false],
      ];
      for (const [day, hhmm, expected] of cases) {
        clock = at(day, hhmm);
        expect((await api.bot.get()).channels.instagram, `${day} ${hhmm}`).toBe(expected);
      }
      clock = NOW;
      st = await api.bot.setMode("instagram", "manual"); // vuelve a mandar el interruptor (conservado) y el horario queda guardado
      expect(st.channels.instagram).toBe(true);
      expect(st.schedules?.instagram).toEqual(NIGHT);
      st = await api.bot.setMode("instagram", "schedule"); // se vuelve a usar sin redefinirlo
      expect(st.modes?.instagram).toBe("schedule");
    });

    it("el estado efectivo de WhatsApp es `active`, aunque este en modo horario; los otros canales no cambian", async () => {
      await api.bot.setChannel("facebook", true);
      const st = await api.bot.configure("whatsapp", { mode: "schedule", schedule: OFFICE as never });
      expect(st.channels).toEqual({ whatsapp: true, facebook: true, instagram: false }); // martes 10:00: en horario de oficina
      expect(st.active).toBe(true);
      clock = at("2026-11-10", "19:30");
      const later = await api.bot.get();
      expect(later.channels.whatsapp).toBe(false);
      expect(later.active).toBe(false);
      expect(later.channels.facebook).toBe(true);
      expect(mock.bot.status().channels.whatsapp).toBe(false); // lo que lee el bot
    });

    it("pasar a horario exige un horario valido; lo invalido es 400 y no cambia nada", async () => {
      for (const body of [
        { channel: "facebook", mode: "schedule" }, // sin horario guardado
        { channel: "facebook", mode: "automatico" },
        { channel: "facebook", schedule: { days: [], start: "19:00", end: "08:00" } },
        { channel: "facebook", schedule: { days: ["lunes"], start: "19:00", end: "08:00" } },
        { channel: "facebook", schedule: { days: ["mon", "mon"], start: "19:00", end: "08:00" } },
        { channel: "facebook", schedule: { days: ["mon"], start: "09:00", end: "09:00" } },
        { channel: "facebook", schedule: { days: ["mon"], start: "25:00", end: "09:00" } },
        { channel: "facebook", schedule: null },
        { channel: "facebook", active: true, mode: "schedule" }, // todo o nada
        { channel: "facebook", foo: 1, mode: "manual" },
        { channels: { facebook: true }, mode: "manual" },
        { channel: "facebook" },
      ]) {
        expect(await put(body), JSON.stringify(body)).toBe("400 validacion");
      }
      const st = await api.bot.get();
      expect(st.modes?.facebook).toBe("manual");
      expect(st.manual?.facebook).toBe(false);
      expect(st.schedules?.facebook).toBeNull();
    });

    it("sin sesion o como doctor no se puede cambiar el modo ni el horario", async () => {
      await api.auth.logout();
      expect(await code(lax.bot.setMode("facebook", "manual"))).toBe("401 no_autenticado");
      await login("doctor");
      expect(await code(lax.bot.setMode("facebook", "manual"))).toBe("403 sin_permiso");
    });
  });

  it("el mismo numero en dos canales son dos personas: cada identidad ve y cancela solo lo suyo", () => {
    const wa = mock.bot.book({ telefono: NUM }, { patientName: "Ana Lopez", doctorId: D.cervantes })!;
    const fb = mock.bot.book({ canal: "facebook", contacto_id: NUM }, { patientName: "Ana Lopez", doctorId: D.perez, contactPhone: CONTACT })!;
    expect([wa.channel, fb.channel]).toEqual(["whatsapp", "facebook"]);
    expect(wa.patient).toEqual({ id: NUM, name: "Ana Lopez", phone: NUM });
    expect(fb.patient).toEqual({ id: `facebook:${NUM}`, name: "Ana Lopez", phone: CONTACT }); // el id NO es el telefono de contacto
    expect(fb.contactPhone).toBe(CONTACT);

    expect(mock.bot.mine({ telefono: NUM }).map((b) => b.id)).toEqual([wa.id]);
    expect(mock.bot.mine({ canal: "facebook", contacto_id: NUM }).map((b) => b.id)).toEqual([fb.id]);
    expect(mock.bot.mine({ canal: "instagram", contacto_id: NUM })).toEqual([]); // instagram con el mismo id tampoco ve la de facebook
    expect(mock.bot.mine({ telefono: CONTACT })).toEqual([]); // y el telefono de contacto de Facebook no es una identidad de WhatsApp

    for (const [who, ajena] of [
      [{ telefono: NUM }, fb.id],
      [{ canal: "facebook", contacto_id: NUM }, wa.id],
      [{ canal: "instagram", contacto_id: NUM }, fb.id],
      [{ telefono: CONTACT }, fb.id],
    ] as const) {
      expect(() => mock.bot.cancel(who, ajena)).toThrowError(/No hay una cita/); // 404: no se distingue de "no existe"
    }
    expect(mock.bot.cancel({ canal: "facebook", contacto_id: NUM }, fb.id).status).toBe("cancelada");
    expect(mock.bot.mine({ canal: "facebook", contacto_id: NUM })).toEqual([]);
    expect(mock.bot.mine({ telefono: NUM }).map((b) => b.id)).toEqual([wa.id]);
  });

  it("identidad invalida: 400 (canal, id de Meta, telefono con otro canal); un telefono de WhatsApp mal formado sigue siendo 422", () => {
    const status = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as { status: number }).status;
      }
      return 0;
    };
    for (const who of [
      { canal: "telegram", contacto_id: IG },
      { canal: "facebook" },
      { canal: "facebook", contacto_id: "ab c!" },
      { canal: "instagram", contacto_id: "1234" },
      { canal: "instagram", contacto_id: "1".repeat(65) },
      { canal: "facebook", contacto_id: IG, telefono: NUM },
    ]) {
      expect(status(() => mock.bot.mine(who)), JSON.stringify(who)).toBe(400);
    }
    expect(status(() => mock.bot.mine({ telefono: "123" }))).toBe(422);
    expect(status(() => mock.bot.mine({}))).toBe(422);
  });

  it("fuera de WhatsApp agendar exige telefono_contacto de 8 a 15 digitos; en WhatsApp se ignora", () => {
    for (const contactPhone of [undefined, "", "123", "12345678901234567", "99812345ab"]) {
      expect(() => mock.bot.book({ canal: "instagram", contacto_id: IG }, { patientName: "Ana Lopez", doctorId: D.cervantes, contactPhone })).toThrowError(
        /telefono_contacto/
      );
    }
    expect(mock.bot.mine({ canal: "instagram", contacto_id: IG })).toEqual([]);
    const wa = mock.bot.book({ telefono: NUM }, { patientName: "Ana Lopez", doctorId: D.cervantes, contactPhone: "1112223334" })!;
    expect(wa.patient!.phone).toBe(NUM); // el de contacto NO sustituye al telefono de WhatsApp
  });

  it("el traspaso de Messenger / Instagram guarda canal e id sin telefono, aparece en Atencion y se filtra por canal", async () => {
    mock.bot.handoff({ conversationId: "conv-wa", reason: "pidio_persona", telefono: NUM });
    mock.bot.handoff({ conversationId: "conv-fb", reason: "otro", canal: "facebook", contacto_id: NUM });
    mock.bot.handoff({ conversationId: "conv-ig", reason: "otro", canal: "instagram", contacto_id: IG });
    expect(() => mock.bot.handoff({ conversationId: "c", reason: "otro", canal: "instagram", contacto_id: IG, telefono: NUM })).toThrowError(/solo aplica a whatsapp/);
    expect(() => mock.bot.handoff({ conversationId: "c", reason: "otro", canal: "instagram" })).toThrowError(/contacto_id/);
    const open = await api.attention.list("open");
    const byConv = Object.fromEntries(open.map((a) => [a.conversationId, a]));
    expect(byConv["conv-ig"]).toMatchObject({ channel: "instagram", contactId: IG, phone: null });
    expect(byConv["conv-wa"]).toMatchObject({ channel: "whatsapp", contactId: null, phone: NUM });
    expect((await api.attention.list("open", { channel: "facebook" })).map((a) => a.conversationId)).toEqual(["conv-fb"]);
    expect((await api.attention.page("open", { limit: 1, channel: "instagram" })).total).toBe(1);
    expect(await code(lax.attention.list("open", { channel: "telegram" as never }))).toBe("422 validacion");
  });

  it("el personal ve canal, id estable y telefono de contacto; el doctor NUNCA recibe telefono ni id de Meta", async () => {
    const fb = mock.bot.book({ canal: "facebook", contacto_id: NUM }, { patientName: "Ana Lopez", doctorId: D.cervantes, contactPhone: CONTACT })!;
    mock.bot.book({ canal: "instagram", contacto_id: IG }, { patientName: "Luis Gomez", doctorId: D.cervantes, contactPhone: CONTACT });
    mock.bot.book({ telefono: NUM }, { patientName: "Maria Perez", doctorId: D.cervantes });
    const range = { from: at("2026-11-09", "00:00"), to: at("2026-12-09", "00:00") };
    const listed = await api.appointments.list(range);
    if (listed.notModified) throw new Error("se esperaba la lista completa");
    const seen = listed.data.items.find((b) => b.id === fb.id)!;
    expect(seen).toMatchObject({ channel: "facebook", contactPhone: CONTACT, patient: { id: `facebook:${NUM}`, phone: CONTACT } });

    await api.auth.logout();
    await login("doctor");
    const asDoctor = await api.doctorSelf.appointments(range);
    if (asDoctor.notModified) throw new Error("se esperaba la lista completa");
    expect(asDoctor.data.items.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(asDoctor.data);
    for (const secret of [NUM, CONTACT, IG, "facebook:", "instagram:", "contactPhone", "contactId"]) expect(text).not.toContain(secret);
    for (const b of asDoctor.data.items) expect(b.patient?.id).toBe(b.id); // solo el id de la cita
    expect(new Set(asDoctor.data.items.map((b) => b.channel))).toEqual(new Set(["facebook", "instagram", "whatsapp"])); // el canal SI se ve
  });
});

describe("controles de desarrollo", () => {
  it("el bot simulado agenda una cita source 'ai' en un hueco que cumple las reglas, y cambia el ETag", async () => {
    const range = { from: at("2026-11-09", "00:00"), to: at("2026-12-09", "00:00") };
    const before = await api.appointments.list(range);
    const made = mock.simulateBotBooking({ doctorId: D.cervantes })!;
    expect(made).toMatchObject({ source: "ai", kind: "session", status: "agendada", doctor: { id: "d1" } });
    expect(Date.parse(made.scheduledAtUtc)).toBeGreaterThanOrEqual(NOW.getTime() + 60 * 60_000);
    const after = await api.appointments.list(range, { etag: before.etag });
    expect(after.notModified).toBe(false);
  });

  it("sin red y 5xx se ven como 'red' y 'desconocido'", async () => {
    mock.controls.setOffline(true);
    expect(await code(lax.rooms.list())).toBe("0 red");
    mock.controls.setOffline(false);
    mock.controls.failNext(1, 503);
    expect(await code(lax.rooms.list())).toBe("503 desconocido");
    expect(await lax.rooms.list()).toHaveLength(2);
  });

  it("recuerda la sesion entre recargas si se le da un almacenamiento", async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const first = createMockApi({ now: () => NOW, storage });
    const a = createApiClient({ fetch: first.fetch });
    const staff = DEMO_ACCOUNTS.find((x) => x.role === "staff")!;
    await a.auth.login(staff.email, staff.password);

    const reloaded = createMockApi({ now: () => NOW, storage }); // "recargar la pagina"
    const b = createApiClient({ fetch: reloaded.fetch });
    const info = await b.auth.me();
    expect(info.user.role).toBe("staff");
    await b.bot.set(false); // y ya puede escribir: me() dio un CSRF valido
    await b.auth.logout();
    expect(await code(createApiClient({ fetch: createMockApi({ now: () => NOW, storage }).fetch }).auth.me())).toBe("401 no_autenticado");
  });
});
