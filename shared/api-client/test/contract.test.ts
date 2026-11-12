import { afterEach, describe, expect, it } from "vitest";
import { OPERATIONS, createApiClient } from "../src";
import { DEMO_ACCOUNTS, createMockApi } from "../src/mock";
import { contractFetch, operations, spec } from "./spec";

/**
 * El cliente y el simulador contra `docs/openapi.yaml`. No se edita el contrato:
 * si algo no cuadra, estas pruebas lo dicen.
 */

const NOT_UI = (path: string) => path.startsWith("/api/bot/") || path.startsWith("/webhooks/");
const uiOps = operations.filter((o) => !NOT_UI(o.path));

describe("el cliente cubre el contrato", () => {
  it("cada operacion del cliente existe en el YAML con el mismo operationId, metodo y ruta", () => {
    for (const [id, [method, path]] of Object.entries(OPERATIONS)) {
      const found = operations.find((o) => o.operationId === id);
      expect(found, `operationId ${id} no esta en el contrato`).toBeDefined();
      expect([found!.method, found!.path], id).toEqual([method, path]);
    }
  });

  it("no falta ninguna operacion de la web ni de la PWA (todo menos /api/bot y el webhook)", () => {
    expect(uiOps.map((o) => o.operationId).sort()).toEqual(Object.keys(OPERATIONS).sort());
  });
});

describe("el simulador cubre el contrato", () => {
  const mock = createMockApi({ now: () => new Date("2026-11-10T15:00:00Z") });

  it("implementa exactamente las operaciones de la web y la PWA", () => {
    expect(mock.routes.map((r) => r.operationId).sort()).toEqual(uiOps.map((o) => o.operationId).sort());
  });

  it("cada ruta tiene los mismos roles (x-roles) y el mismo CSRF que el contrato", () => {
    for (const r of mock.routes) {
      const o = operations.find((x) => x.operationId === r.operationId)!;
      const roles: string[] | null = o.op["x-roles"] ?? null;
      expect(r.roles === null ? null : [...r.roles].sort(), `${r.operationId}: roles`).toEqual(roles === null ? null : [...roles].sort());
      const wantsCsrf = (o.op.security ?? spec.security ?? []).some((req: object) => "csrf" in req);
      expect(r.csrf, `${r.operationId}: csrf`).toBe(wantsCsrf);
    }
  });
});

describe("un recorrido completo por el cliente cumple el contrato en cada intercambio", () => {
  let violations: string[] = [];
  afterEach(() => expect(violations).toEqual([]));

  it("personal: calendario, citas, doctores, ausencias, bot, atencion", async () => {
    const mock = createMockApi({ now: () => new Date("2026-11-10T15:00:00Z") });
    const cf = contractFetch(mock.fetch);
    violations = cf.violations;
    const api = createApiClient({ fetch: cf.fetch });
    const staff = DEMO_ACCOUNTS.find((a) => a.role === "staff")!;

    await api.auth.login(staff.email, staff.password);
    await api.auth.me();
    const range = { from: "2026-11-09T05:00:00.000Z", to: "2026-11-16T05:00:00.000Z" };
    const first = await api.appointments.list(range);
    expect(first.notModified).toBe(false);
    const etag = first.etag!;
    expect(etag).toBeTruthy();
    expect(await api.appointments.list(range, { etag })).toMatchObject({ notModified: true });

    const doctors = await api.doctors.list();
    const rooms = await api.rooms.list();
    await api.clinicHours.get();
    const created = await api.appointments.create({
      patientName: "Paciente Prueba", phone: "529980009999", doctorId: doctors[0]!.id,
      scheduledAtUtc: "2026-11-12T16:00:00.000Z", notes: "Primera vez",
    });
    await api.appointments.get(created.id);
    await api.appointments.update(created.id, { status: "realizada" }).catch(() => {}); // futura: igual se permite
    const moved = await api.appointments.update(created.id, { scheduledAtUtc: "2026-11-12T17:00:00.000Z" }).catch(() => null);
    expect(moved === null || moved.id === created.id).toBe(true);
    await api.appointments.create({ kind: "block", roomId: rooms[1]!.id, scheduledAtUtc: "2026-11-13T18:00:00.000Z", durationMinutes: 60, notes: "Limpieza" });

    const set = await api.doctors.setWeeklyHours(doctors[1]!.id, { tue: [{ start: "10:00", end: "12:00" }] });
    expect(set.doctor.usesClinicHours).toBe(false);
    await api.doctors.setWeeklyHours(doctors[1]!.id, null);
    const abs = await api.doctors.absences.create(doctors[2]!.id, { startUtc: "2026-11-20T14:00:00.000Z", endUtc: "2026-11-20T23:00:00.000Z", reason: "Curso" });
    await api.doctors.absences.list(doctors[2]!.id);
    await api.doctors.absences.remove(doctors[2]!.id, abs.absence.id);
    const busy = await api.busyTimes.list(range);              // lo que el personal sabe de los eventos personales: solo «ocupado»
    expect(busy.length).toBeGreaterThan(0);
    expect(Object.keys(busy[0]!).sort()).toEqual(["doctorId", "endUtc", "id", "startUtc"]);

    const requests = await api.scheduleChanges.list("pending");
    await api.scheduleChanges.reject(requests[0]!.id, "No es posible por ahora");

    await api.bot.get();
    await api.bot.set(false);
    const open = await api.attention.list("open");
    const pagina = await api.attention.page("open", { limit: 2, offset: 0 });            // una pagina + su total, validado contra el contrato
    expect(pagina.items.length).toBeLessThanOrEqual(2);
    expect(pagina.total).toBe(open.length);
    await api.attention.resolve(open[0]!.id);
    await api.attention.list("resolved");

    // errores declarados
    await expect(api.appointments.create({ patientName: "Solo", doctorId: doctors[0]!.id, scheduledAtUtc: "2026-11-12T16:00:00.000Z" })).rejects.toMatchObject({ status: 422 });
    await expect(api.appointments.get("no-existe")).rejects.toMatchObject({ status: 404 });
    await api.auth.logout();
  });

  it("administrador: usuarios, doctores, horario de la clinica", async () => {
    const mock = createMockApi({ now: () => new Date("2026-11-10T15:00:00Z") });
    const cf = contractFetch(mock.fetch);
    violations = cf.violations;
    const api = createApiClient({ fetch: cf.fetch });
    const admin = DEMO_ACCOUNTS.find((a) => a.role === "admin")!;
    await api.auth.login(admin.email, admin.password);

    const users = await api.users.list();
    const created = await api.users.create({ email: "nuevo@clinica.test", name: "Nuevo Personal", role: "staff", password: "contrasena-larga-1" });
    await api.users.update(created.id, { active: false });
    expect(users.length).toBeGreaterThan(0);

    const doc = await api.doctors.create({ name: "Dra. Prueba Uno", specialty: "Pediatría", aliases: ["pediatra"] });
    await api.doctors.update(doc.id, { active: false });
    const hours = await api.clinicHours.get();
    await api.clinicHours.set(hours);

    await expect(api.users.create({ email: "nuevo@clinica.test", name: "Repetido", role: "staff", password: "contrasena-larga-1" })).rejects.toMatchObject({ status: 422 });
    await expect(api.users.update(users[0]!.id, { active: false })).rejects.toMatchObject({ status: 422 }); // a si mismo
  });

  it("doctor: su agenda, sus ausencias, su solicitud de horario", async () => {
    const mock = createMockApi({ now: () => new Date("2026-11-10T15:00:00Z") });
    const cf = contractFetch(mock.fetch);
    violations = cf.violations;
    const api = createApiClient({ fetch: cf.fetch });
    const doctor = DEMO_ACCOUNTS.find((a) => a.role === "doctor")!;
    await api.auth.login(doctor.email, doctor.password);

    const range = { from: "2026-11-09T05:00:00.000Z", to: "2026-11-16T05:00:00.000Z" };
    const mine = await api.doctorSelf.appointments(range);
    expect(mine.notModified).toBe(false);
    await api.doctorSelf.appointments(range, { etag: mine.etag });
    await api.doctorSelf.hours();
    const a = await api.doctorSelf.absences.create({ startUtc: "2026-11-24T14:00:00.000Z", endUtc: "2026-11-24T20:00:00.000Z", reason: "Personal" });
    await api.doctorSelf.absences.list();
    await api.doctorSelf.absences.remove(a.absence.id);
    const ev = await api.doctorSelf.personalEvents.create({ title: "Dentista", notes: "Llevar radiografía", startUtc: "2026-11-26T16:00:00.000Z", endUtc: "2026-11-26T17:00:00.000Z" });
    const evs = await api.doctorSelf.personalEvents.list({ from: "2026-11-23T05:00:00.000Z", to: "2026-11-30T05:00:00.000Z" });
    expect(evs.map((x) => x.id)).toEqual([ev.id]);
    const edited = await api.doctorSelf.personalEvents.update(ev.id, { title: "Dentista (cambio)", notes: null });
    expect(edited).toMatchObject({ title: "Dentista (cambio)", notes: null });
    await api.doctorSelf.personalEvents.remove(ev.id);
    await expect(api.doctorSelf.personalEvents.remove(ev.id)).rejects.toMatchObject({ status: 404 });
    const req = await api.doctorSelf.scheduleChanges.create({ weeklyHours: { mon: [{ start: "10:00", end: "14:00" }] }, effectiveFrom: "2026-12-01", note: "Cambio" });
    await api.doctorSelf.scheduleChanges.list();
    await api.doctorSelf.scheduleChanges.remove(req.id);
    await api.doctorSelf.push.subscribe({ endpoint: "https://push.example.test/abc", keys: { p256dh: "k", auth: "a" } });
    await api.doctorSelf.push.unsubscribe("https://push.example.test/abc");
  });
});

describe("el validador de contrato no es vacuo", () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("detecta cuerpos, estados, rutas y cabeceras fuera del contrato", async () => {
    const cf = contractFetch(async (url) => (String(url).includes("rooms") ? ok({ items: [{ id: 1 }] }) : ok({ error: "x" }, 418)));
    await cf.fetch("/api/rooms");
    await cf.fetch("/api/no-existe");
    await cf.fetch("/api/bot-settings-que-no-existe", { method: "POST" });
    await cf.fetch("/api/settings/bot", { method: "PUT", body: JSON.stringify({ active: "si" }) }); // sin CSRF, cuerpo malo, 418
    const text = cf.violations.join("\n");
    expect(text).toMatch(/GET \/api\/rooms -> 200: respuesta no cumple/);
    expect(text).toMatch(/GET \/api\/no-existe: la ruta no existe/);
    expect(text).toMatch(/PUT \/api\/settings\/bot: el contrato exige X-CSRF-Token/);
    expect(text).toMatch(/PUT \/api\/settings\/bot: peticion no cumple el contrato/);
    expect(text).toMatch(/responde 418, que el contrato no declara/);
    expect(cf.violations.length).toBeGreaterThanOrEqual(6);
  });
});
