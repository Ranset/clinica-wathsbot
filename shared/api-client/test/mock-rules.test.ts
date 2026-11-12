import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zonedWallClockToUtc } from "@clinica/calendar/src/lib/slots";
import { ApiError, createApiClient, type ApiClient, type Role } from "../src";
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
  mock = createMockApi({ now: () => NOW });
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

  it("valida correo, contrasena de 10+, duplicados y que un doctor lleve doctorId", async () => {
    const base = { email: "nueva@clinica.test", name: "Persona Nueva", role: "staff" as const, password: "contrasena-larga-1" };
    expect(await code(lax.users.create({ ...base, email: "no-es-correo" }))).toBe("422 validacion");
    expect(await code(lax.users.create({ ...base, password: "corta" }))).toBe("422 validacion");
    expect(await code(api.users.create({ ...base, role: "doctor" }))).toBe("422 validacion");
    expect(await code(api.users.create({ ...base, role: "doctor", doctorId: "d99" }))).toBe("422 validacion");
    expect(await code(api.users.create({ ...base, doctorId: "d1" }))).toBe("422 validacion");
    const u = await api.users.create(base);
    expect(u).toMatchObject({ email: "nueva@clinica.test", role: "staff", doctorId: null, active: true });
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
