import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { freezeClock, makeServer, mountApp, setBrowserOnline } from "./helpers";

beforeEach(freezeClock);

const posts = (log: ReturnType<typeof makeServer>["log"]) => log.filter((r) => r.method === "POST" && r.path === "/api/doctor/schedule-change-requests");
const open = async (t: Awaited<ReturnType<typeof mountApp>>) => {
  await t.user.click(await screen.findByRole("button", { name: "Solicitar cambio de horario" }));
  return screen.findByRole("dialog", { name: "Solicitar cambio de horario" });
};

describe("mi horario semanal", () => {
  it("muestra el horario vigente por día (L-V 09:00–18:00, sábado 09:00–13:00, domingo no) y que usa el de la clínica", async () => {
    await mountApp({ hash: "#/horario" });
    const list = await screen.findByRole("list", { name: "Mi horario semanal" });
    const row = (day: string) => within(list).getByText(day).closest("li")!;
    expect(row("Lunes")).toHaveTextContent("9:00 AM – 6:00 PM");
    expect(row("Viernes")).toHaveTextContent("9:00 AM – 6:00 PM");
    expect(row("Sábado")).toHaveTextContent("9:00 AM – 1:00 PM");
    expect(row("Domingo")).toHaveTextContent("No atiendo");
    expect(screen.getByText(/Usas el horario general de la clínica\./)).toBeInTheDocument();
  });

  it("con horario propio lo dice y lo pinta", async () => {
    const server = makeServer();
    server.mock.db.doctors.find((d) => d.id === "d1")!.ownHours = { tue: [{ start: "10:00", end: "14:00" }], thu: [{ start: "10:00", end: "14:00" }] };
    await mountApp({ hash: "#/horario", server });
    const list = await screen.findByRole("list", { name: "Mi horario semanal" });
    expect(screen.getByText(/Tienes un horario propio\./)).toBeInTheDocument();
    expect(within(list).getByText("Martes").closest("li")).toHaveTextContent("10:00 AM – 2:00 PM");
    expect(within(list).getByText("Lunes").closest("li")).toHaveTextContent("No atiendo");
  });
});

describe("solicitar un cambio permanente de horario", () => {
  it("envía la solicitud con el horario nuevo, la fecha y la nota, y queda «Pendiente» en mis solicitudes", async () => {
    const t = await mountApp({ hash: "#/horario" });
    expect(await screen.findByText("Todavía no has pedido cambios de horario.")).toBeInTheDocument();
    const dlg = await open(t);
    await t.user.selectOptions(within(dlg).getByLabelText("Lunes: hasta"), "17:00");
    await t.user.type(within(dlg).getByLabelText("Nota para el personal (opcional)"), "Salgo antes los lunes");
    await t.user.click(within(dlg).getByRole("button", { name: "Enviar solicitud" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [req] = posts(t.log);
    expect(req!.body).toMatchObject({ effectiveFrom: "2026-11-11", note: "Salgo antes los lunes" });
    const sent = (req!.body as { weeklyHours: Record<string, { start: string; end: string }[]> }).weeklyHours;
    expect(sent.mon).toEqual([{ start: "09:00", end: "17:00" }]);
    expect(sent.tue).toEqual([{ start: "09:00", end: "18:00" }]);
    expect(sent.sun).toBeUndefined(); // los días sin atención no se mandan

    // en el servidor queda pendiente, ligada a MI doctor, y en pantalla sale en la lista
    const stored = t.mock.db.requests.filter((r) => r.doctorId === "d1");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe("pending");
    const item = (await screen.findByText("Pendiente")).closest("li")!;
    expect(item).toHaveTextContent("Lun 9:00 AM–5:00 PM");
    expect(item).toHaveTextContent("Inicio pedido: mié 11 nov");
    expect(item).toHaveTextContent("Nota: Salgo antes los lunes");
    expect(screen.getByText("Solicitud enviada: el personal la revisará.")).toBeInTheDocument();
    expect(t.violations).toEqual([]);
  });

  it("muestra el estado de cada solicitud (pendiente, aprobada, rechazada), la más reciente primero, y se actualiza cuando el personal decide", async () => {
    const server = makeServer();
    const hours = { mon: [{ start: "10:00", end: "14:00" }] };
    server.mock.db.requests.push(
      { id: "s-vieja", doctorId: "d1", weeklyHours: hours, effectiveFrom: "2026-10-05", note: null, status: "rejected", createdAtUtc: "2026-10-01T15:00:00.000Z", decidedBy: "Recepción", decidedAtUtc: "2026-10-02T15:00:00.000Z" },
      { id: "s-ajena", doctorId: "d2", weeklyHours: hours, effectiveFrom: "2026-11-20", note: "De otra doctora", status: "pending", createdAtUtc: "2026-11-02T15:00:00.000Z", decidedBy: null, decidedAtUtc: null },
      { id: "s-nueva", doctorId: "d1", weeklyHours: hours, effectiveFrom: "2026-11-16", note: null, status: "pending", createdAtUtc: "2026-11-09T15:00:00.000Z", decidedBy: null, decidedAtUtc: null }
    );
    await mountApp({ hash: "#/horario", server });
    const section = (await screen.findByRole("region", { name: "Mis solicitudes" })) as HTMLElement;
    await within(section).findByText("Pendiente");
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(2); // la ajena no se ve
    expect(items[0]).toHaveTextContent("Pendiente");
    expect(items[1]).toHaveTextContent("Rechazada");
    expect(items[1]).toHaveTextContent(/Resuelta jue 1 oct|Resuelta vie 2 oct/);
    expect(within(section).queryByText("De otra doctora")).toBeNull();
    expect(screen.getByText(/Ya tienes una solicitud pendiente/)).toBeInTheDocument();

    // el personal la aprueba: al refrescar (volver a la app) cambia a «Aprobada»
    server.mock.db.requests.find((r) => r.id === "s-nueva")!.status = "approved";
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(within(section).getAllByRole("listitem")[0]).toHaveTextContent("Aprobada"), { timeout: 3000 });
  });

  it("no deja pedir lo que ya se tiene, ni horas fuera del horario de la clínica, ni un horario vacío; no manda nada", async () => {
    const t = await mountApp({ hash: "#/horario" });
    const dlg = await open(t);

    await t.user.click(within(dlg).getByRole("button", { name: "Enviar solicitud" }));
    expect(await within(dlg).findByText("Ese es el horario que ya tienes: haz algún cambio.")).toBeInTheDocument();

    await t.user.selectOptions(within(dlg).getByLabelText("Lunes: hasta"), "19:00");
    expect(await within(dlg).findByText(/Fuera del horario de la clínica \(9:00 AM–6:00 PM\)/)).toBeInTheDocument();
    await t.user.click(within(dlg).getByRole("button", { name: "Enviar solicitud" }));
    expect(await within(dlg).findByText("Revisa los horarios marcados en rojo.")).toBeInTheDocument();

    await t.user.selectOptions(within(dlg).getByLabelText("Lunes: hasta"), "18:00");
    for (const d of ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]) await t.user.click(within(dlg).getByLabelText(`${d}: atiende`));
    await t.user.click(within(dlg).getByRole("button", { name: "Enviar solicitud" }));
    expect(await within(dlg).findByText(/Elige al menos un día en que atiendas/)).toBeInTheDocument();
    expect(posts(t.log)).toHaveLength(0);
  });

  it("si el servidor falla (5xx) la solicitud no se da por enviada: el formulario sigue abierto con el aviso", async () => {
    const t = await mountApp({ hash: "#/horario" });
    const dlg = await open(t);
    await t.user.selectOptions(within(dlg).getByLabelText("Lunes: hasta"), "17:00");
    t.mock.controls.failNext(1, 503);
    await t.user.click(within(dlg).getByRole("button", { name: "Enviar solicitud" }));
    expect(await within(dlg).findByText(/El servidor tuvo un problema/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(t.mock.db.requests.filter((r) => r.doctorId === "d1")).toHaveLength(0);
  });

  it("sin conexión se ve el horario guardado pero no se puede pedir un cambio", async () => {
    const t = await mountApp({ hash: "#/horario" });
    await screen.findByRole("list", { name: "Mi horario semanal" });
    expect(await screen.findByRole("button", { name: "Solicitar cambio de horario" })).toBeEnabled();
    setBrowserOnline(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Solicitar cambio de horario" })).toBeDisabled());
    expect(screen.getByRole("list", { name: "Mi horario semanal" })).toBeInTheDocument();
    expect(screen.getAllByText(/Sin conexión: esto necesita internet/).length).toBeGreaterThan(0);
    expect(posts(t.log)).toHaveLength(0);
  });
});
