import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { freezeClock, makeServer, mountApp, setBrowserOnline } from "./helpers";

beforeEach(freezeClock);

const FROM = "2026-11-12"; // jueves
const TO = "2026-11-13"; // viernes
const posts = (log: ReturnType<typeof makeServer>["log"]) => log.filter((r) => r.method === "POST" && r.path === "/api/doctor/absences");

async function fillDates(from = FROM, to = TO) {
  fireEvent.change(await screen.findByLabelText("Desde"), { target: { value: from } });
  fireEvent.change(screen.getByLabelText("Hasta (inclusive)"), { target: { value: to } });
}

describe("ausencias propias", () => {
  it("lista solo las próximas (las pasadas aparecen al pedirlas) y dice cuándo no hay", async () => {
    const server = makeServer();
    server.mock.db.absences.push(
      { id: "a-vieja", doctorId: "d1", startUtc: "2026-10-01T05:00:00.000Z", endUtc: "2026-10-02T05:00:00.000Z", reason: "Vacaciones pasadas" },
      { id: "a-ajena", doctorId: "d5", startUtc: "2026-11-20T05:00:00.000Z", endUtc: "2026-11-21T05:00:00.000Z", reason: "De otro doctor" }
    );
    const t = await mountApp({ hash: "#/ausencias", server });
    expect(await screen.findByText("No tienes ausencias registradas próximas.")).toBeInTheDocument();
    expect(screen.queryByText("Vacaciones pasadas")).toBeNull();
    expect(screen.queryByText("De otro doctor")).toBeNull(); // solo las MÍAS

    await t.user.click(screen.getByLabelText("Ver pasadas"));
    expect(await screen.findByText("Vacaciones pasadas")).toBeInTheDocument();
    expect(screen.getByText("jue 1 oct (todo el día)")).toBeInTheDocument();
  });

  it("crea una ausencia de varios días con motivo y avisa cuántas citas quedan afectadas (affectedCount)", async () => {
    const t = await mountApp({ hash: "#/ausencias" });
    await fillDates();
    await t.user.type(screen.getByLabelText("Motivo (opcional)"), "Congreso de medicina");
    const afectadas = t.mock.db.bookings.filter(
      (b) => b.kind === "session" && b.status === "agendada" && b.doctor?.id === "d1" && b.scheduledAtUtc >= "2026-11-12T05:00:00.000Z" && b.scheduledAtUtc < "2026-11-14T05:00:00.000Z"
    ).length;
    expect(afectadas).toBeGreaterThan(1);

    await t.user.click(screen.getByRole("button", { name: "Registrar ausencia" }));

    expect(await screen.findByText(new RegExp(`Tienes ${afectadas} citas agendadas en ese rango\\. No se cancelaron`))).toBeInTheDocument();
    // sale en la lista, con su motivo, y se mandó en UTC (00:00 de Cancún = 05:00Z; hasta el día siguiente al último)
    expect(await screen.findByText("jue 12 nov al vie 13 nov (todo el día)")).toBeInTheDocument();
    expect(screen.getByText("Congreso de medicina")).toBeInTheDocument();
    expect(posts(t.log)[0]!.body).toEqual({ startUtc: "2026-11-12T05:00:00.000Z", endUtc: "2026-11-14T05:00:00.000Z", reason: "Congreso de medicina" });
    // el personal recibe el aviso (lo hace el servidor)
    expect(t.mock.db.attention.some((a) => a.kind === "absence_affects_appointments" && a.status === "open")).toBe(true);
    expect(t.mock.db.absences.filter((a) => a.doctorId === "d1")).toHaveLength(1);
    expect(t.violations).toEqual([]);
  });

  it("sin citas en el rango lo dice, y una ausencia por horas se manda con esas horas (hora de Cancún)", async () => {
    const t = await mountApp({ hash: "#/ausencias" });
    // el sábado 21 de noviembre no hay citas de ejemplo todavía (el seed llega hasta ~10 días)
    await fillDates("2026-12-05", "2026-12-05");
    await t.user.click(screen.getByLabelText("Todo el día"));
    await t.user.selectOptions(screen.getByLabelText("Hora de inicio"), "10:00");
    await t.user.selectOptions(screen.getByLabelText("Hora final"), "12:30");
    await t.user.click(screen.getByRole("button", { name: "Registrar ausencia" }));

    expect(await screen.findByText("No tienes citas agendadas en ese rango.")).toBeInTheDocument();
    expect(await screen.findByText("sáb 5 dic · 10:00 → sáb 5 dic · 12:30")).toBeInTheDocument();
    expect(posts(t.log)[0]!.body).toEqual({ startUtc: "2026-12-05T15:00:00.000Z", endUtc: "2026-12-05T17:30:00.000Z" });
  });

  it("no manda nada si la ausencia termina antes de empezar o las fechas están al revés", async () => {
    const t = await mountApp({ hash: "#/ausencias" });
    await fillDates("2026-11-12", "2026-11-12");
    await t.user.click(screen.getByLabelText("Todo el día"));
    await t.user.selectOptions(screen.getByLabelText("Hora de inicio"), "18:00");
    await t.user.selectOptions(screen.getByLabelText("Hora final"), "09:00");
    await t.user.click(screen.getByRole("button", { name: "Registrar ausencia" }));
    expect(await screen.findByText("La ausencia debe terminar después de empezar.")).toBeInTheDocument();
    expect(posts(t.log)).toHaveLength(0);
  });

  it("quitar una ausencia pide confirmar; al confirmar desaparece y el servidor la borra", async () => {
    const server = makeServer();
    server.mock.db.absences.push({ id: "a-mia", doctorId: "d1", startUtc: "2026-11-16T05:00:00.000Z", endUtc: "2026-11-17T05:00:00.000Z", reason: "Trámite" });
    const t = await mountApp({ hash: "#/ausencias", server });
    await t.user.click(await screen.findByRole("button", { name: "Quitar la ausencia del lun 16 nov" }));

    const dlg = await screen.findByRole("dialog", { name: "¿Quitar esta ausencia?" });
    expect(within(dlg).getByText(/lun 16 nov \(todo el día\)/)).toBeInTheDocument();
    // cancelar no borra nada
    await t.user.click(within(dlg).getByRole("button", { name: "Cancelar" }));
    const mine = () => t.mock.db.absences.filter((a) => a.doctorId === "d1");
    expect(mine()).toHaveLength(1);

    await t.user.click(screen.getByRole("button", { name: "Quitar la ausencia del lun 16 nov" }));
    await t.user.click(await screen.findByRole("button", { name: "Quitar ausencia" }));
    await waitFor(() => expect(screen.queryByText("Trámite")).toBeNull());
    expect(mine()).toHaveLength(0);
    expect(t.mock.db.absences.some((a) => a.doctorId === "d5")).toBe(true); // las de otros doctores no se tocan
    expect(t.log.some((r) => r.method === "DELETE" && r.path === "/api/doctor/absences/a-mia")).toBe(true);
    expect(t.violations).toEqual([]);
  });
});

describe("ausencias sin conexión: solo lectura", () => {
  it("con el navegador sin red se ven las ausencias pero crear y quitar quedan deshabilitados, con el motivo; al volver, se habilitan", async () => {
    const server = makeServer();
    server.mock.db.absences.push({ id: "a-mia", doctorId: "d1", startUtc: "2026-11-16T05:00:00.000Z", endUtc: "2026-11-17T05:00:00.000Z", reason: "Trámite" });
    const t = await mountApp({ hash: "#/ausencias", server });
    await screen.findByText("Trámite");
    expect(screen.getByRole("button", { name: "Registrar ausencia" })).toBeEnabled();

    setBrowserOnline(false);
    expect(await screen.findByTestId("offline-pill")).toHaveTextContent("Sin conexión");
    expect(screen.getByRole("button", { name: "Registrar ausencia" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quitar la ausencia del lun 16 nov" })).toBeDisabled();
    expect(screen.getAllByText(/Sin conexión: esto necesita internet/).length).toBeGreaterThan(0);
    expect(screen.getByText("Trámite")).toBeInTheDocument(); // lo guardado sigue a la vista

    // aunque se fuerce el envío del formulario, no sale nada a la red
    fireEvent.submit(screen.getByRole("form", { name: "Registrar ausencia" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts(t.log)).toHaveLength(0);

    setBrowserOnline(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Registrar ausencia" })).toBeEnabled());
    expect(screen.queryByTestId("offline-pill")).toBeNull();
  });

  it("si el servidor deja de contestar, la app pasa sola a solo lectura y se recupera cuando vuelve", async () => {
    const t = await mountApp({ hash: "#/ausencias" });
    await screen.findByText("No tienes ausencias registradas próximas.");
    t.mock.controls.setOffline(true);
    window.dispatchEvent(new Event("focus")); // el siguiente refresco falla
    expect(await screen.findByTestId("offline-pill")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Registrar ausencia" })).toBeDisabled();
    expect(screen.getByText(/Última sincronización: hoy 10:00/)).toBeInTheDocument();

    t.mock.controls.setOffline(false);
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(screen.queryByTestId("offline-pill")).toBeNull());
    expect(screen.getByRole("button", { name: "Registrar ausencia" })).toBeEnabled();
  });

  it("una escritura que falla por red lo reporta y pasa a solo lectura (sin perder lo que escribió el doctor)", async () => {
    const t = await mountApp({ hash: "#/ausencias" });
    await fillDates();
    await t.user.type(screen.getByLabelText("Motivo (opcional)"), "Congreso");
    t.mock.controls.setOffline(true);
    await t.user.click(screen.getByRole("button", { name: "Registrar ausencia" }));
    expect(await screen.findAllByText(/No hay conexión con el servidor/)).not.toHaveLength(0);
    expect(await screen.findByTestId("offline-pill")).toBeInTheDocument();
    expect(screen.getByLabelText("Motivo (opcional)")).toHaveValue("Congreso");
    expect(screen.getByLabelText("Desde")).toHaveValue(FROM);
  });

  it("un fallo pasajero del servidor (5xx) al registrar deja la app en solo lectura SOLO hasta que la sonda confirma que vuelve; no hace falta esperar otro refresco", async () => {
    const t = await mountApp({ hash: "#/ausencias" });
    await fillDates();
    t.mock.controls.failNext(1, 503);
    await t.user.click(screen.getByRole("button", { name: "Registrar ausencia" }));
    expect(await screen.findByText(/El servidor tuvo un problema/)).toBeInTheDocument();
    expect(await screen.findByTestId("offline-pill")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Registrar ausencia" })).toBeDisabled();

    window.dispatchEvent(new Event("focus")); // volver a la app lanza la sonda (GET /api/health)
    await waitFor(() => expect(screen.queryByTestId("offline-pill")).toBeNull());
    expect(t.log.some((r) => r.path === "/api/health")).toBe(true);
    await t.user.click(screen.getByRole("button", { name: "Registrar ausencia" }));
    expect(await screen.findByText(/Tienes \d+ citas? agendadas? en ese rango/)).toBeInTheDocument();
  });
});
