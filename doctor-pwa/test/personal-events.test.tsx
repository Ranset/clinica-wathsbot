import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { freezeClock, makeServer, mountApp, pickBooking, setBrowserOnline, storedKeys } from "./helpers";

beforeEach(freezeClock);

/**
 * Eventos personales del doctor (hoy martes 10 nov). El simulador trae de ejemplo, para el Dr. Cervantes (d1):
 * «Comida con residentes» el miércoles 11 de 1:00 a 2:00 PM y «Dentista» el jueves 12 de 11:30 AM a 1:00 PM; y para
 * la Dra. Bordas (d3) «Junta de especialidad» el miércoles 11, que el Dr. Cervantes NUNCA debe ver.
 */
const COMIDA = "Comida con residentes";
const blocks = () => Array.from(document.querySelectorAll<HTMLElement>("[data-personal-event]"));
const eventsOf = (t: Awaited<ReturnType<typeof mountApp>>, path = "/api/doctor/personal-events") => t.log.filter((r) => r.path.startsWith(path) && r.method !== "GET");
const idOf = (t: Awaited<ReturnType<typeof mountApp>>, title: string) => t.mock.db.personalEvents.find((e) => e.title === title)!.id;
const hhmmOf = (utc: string) => new Date(Date.parse(utc) - 5 * 3600_000).toISOString().slice(11, 16); // Cancún = UTC-5

describe("mis eventos personales en la rejilla", () => {
  it("Hoy: se ven los míos del día, con su título y su hora, y no los de otro doctor", async () => {
    await mountApp({ hash: "#/hoy?dia=2026-11-11" });
    const b = await screen.findByRole("button", { name: /^Evento personal: Comida con residentes, 1:00\sPM a 2:00\sPM$/ });
    expect(b).toHaveClass("cal-personal");
    expect(b).toHaveAttribute("data-personal-event");
    expect(b.closest("[data-lane]")).toHaveAttribute("data-lane", "d1");          // en MI carril
    expect(blocks()).toHaveLength(1);
    expect(screen.queryByText("Junta de especialidad")).toBeNull();                // el de la Dra. Bordas no llega
  });

  it("Semana: cada evento en su día", async () => {
    await mountApp({ hash: "#/semana" });
    await waitFor(() => expect(blocks()).toHaveLength(2));
    const days = blocks().map((e) => e.closest("[data-day]")!.getAttribute("data-day"));
    expect(days).toEqual(["2026-11-11", "2026-11-12"]);
  });

  it("no es una cita: no cuenta en el contador de citas ni se pinta con el color del doctor", async () => {
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-11" });
    const b = await screen.findByRole("button", { name: /^Evento personal: Comida/ });
    expect(b.getAttribute("style") ?? "").not.toMatch(/background-color/);
    const citas = t.mock.db.bookings.filter((x) => x.kind === "session" && x.status !== "cancelada" && x.doctor?.id === "d1" && x.scheduledAtUtc.startsWith("2026-11-11")).length;
    expect(screen.getByTestId("booking-count")).toHaveTextContent(new RegExp(`^${citas} citas?$`));
  });

  it("se actualiza solo: un evento nuevo en el servidor aparece al volver a la app, y uno borrado desaparece", async () => {
    const server = makeServer();
    await mountApp({ hash: "#/hoy?dia=2026-11-11", server });
    await screen.findByRole("button", { name: /^Evento personal: Comida/ });
    server.mock.db.personalEvents.push({ id: "pe-x", doctorId: "d1", title: "Evento desde otro aparato", notes: null, startUtc: "2026-11-11T22:00:00.000Z", endUtc: "2026-11-11T23:00:00.000Z" });
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByRole("button", { name: /^Evento personal: Evento desde otro aparato/ }, { timeout: 3000 })).toBeInTheDocument();
    server.mock.db.personalEvents.splice(0, server.mock.db.personalEvents.length);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(blocks()).toHaveLength(0), { timeout: 3000 });
  });
});

describe("crear un evento personal", () => {
  it("con el botón «Evento»: el formulario aclara que NO es una cita de la clínica; se guarda y aparece en la rejilla", async () => {
    const t = await mountApp({ hash: "#/hoy" });                                    // hoy = mar 10 nov
    await t.user.click(await screen.findByRole("button", { name: "Nuevo evento personal" }));
    const dlg = await screen.findByRole("dialog", { name: "Nuevo evento personal" });
    // el aviso: no es una cita; no recibes citas pero el consultorio queda libre; para agendar a un paciente, al personal
    expect(within(dlg).getByText(/no una cita de la clínica/)).toBeInTheDocument();
    expect(within(dlg).getByText(/el consultorio queda libre para los demás doctores/)).toBeInTheDocument();
    expect(within(dlg).getByText(/pide al personal de la clínica que lo registre/)).toBeInTheDocument();
    // y NO hay un aviso de privacidad de datos de pacientes (se omitió a propósito)
    expect(within(dlg).queryByText(/privacidad|datos de (los )?pacientes/i)).toBeNull();

    await t.user.type(within(dlg).getByLabelText("Título"), "Dentista del lunes");
    await t.user.selectOptions(within(dlg).getByLabelText("Hora de inicio"), "08:00");
    await t.user.selectOptions(within(dlg).getByLabelText("Duración"), "90");
    await t.user.type(within(dlg).getByLabelText("Notas (opcional)"), "Llevar radiografías");
    await t.user.click(within(dlg).getByRole("button", { name: "Guardar" }));

    // 8:00 a 9:30 de Cancún = 13:00 a 14:30 UTC
    await waitFor(() => expect(eventsOf(t)).toHaveLength(1));
    expect(eventsOf(t)[0]).toMatchObject({ method: "POST", body: { title: "Dentista del lunes", notes: "Llevar radiografías", startUtc: "2026-11-10T13:00:00.000Z", endUtc: "2026-11-10T14:30:00.000Z" } });
    expect(await screen.findByRole("button", { name: /^Evento personal: Dentista del lunes, 8:00\sAM a 9:30\sAM$/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(t.mock.db.personalEvents.find((e) => e.title === "Dentista del lunes")?.doctorId).toBe("d1");
    expect(t.violations).toEqual([]);
  });

  it("tocar un hueco vacío de la rejilla abre el formulario con ESE día y hora", async () => {
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-13" });
    await screen.findByRole("heading", { level: 1 });
    const col = await waitFor(() => {
      const c = document.querySelector<HTMLElement>('[data-lane="d1"]');
      if (!c) throw new Error("sin columna");
      return c;
    });
    fireEvent.click(col, { clientY: 15 * 48 + 5 });                                  // 15:00 (48 px por hora)
    const dlg = await screen.findByRole("dialog", { name: "Nuevo evento personal" });
    expect(within(dlg).getByLabelText("Día")).toHaveValue("2026-11-13");
    expect(within(dlg).getByLabelText("Hora de inicio")).toHaveValue("15:00");
    await t.user.click(within(dlg).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(eventsOf(t)).toHaveLength(0);                                              // cancelar no manda nada
  });

  it("todo el día se manda de 00:00 a 00:00 del día siguiente (hora de Cancún)", async () => {
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-14" });
    await t.user.click(await screen.findByRole("button", { name: "Nuevo evento personal" }));
    const dlg = await screen.findByRole("dialog", { name: "Nuevo evento personal" });
    await t.user.type(within(dlg).getByLabelText("Título"), "Boda de mi hermana");
    await t.user.click(within(dlg).getByLabelText("Todo el día"));
    expect(within(dlg).queryByLabelText("Hora de inicio")).toBeNull();
    await t.user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(eventsOf(t)).toHaveLength(1));
    expect(eventsOf(t)[0]!.body).toEqual({ title: "Boda de mi hermana", startUtc: "2026-11-14T05:00:00.000Z", endUtc: "2026-11-15T05:00:00.000Z" });
  });

  it("sin título no manda nada", async () => {
    const t = await mountApp({ hash: "#/hoy" });
    await t.user.click(await screen.findByRole("button", { name: "Nuevo evento personal" }));
    const dlg = await screen.findByRole("dialog", { name: "Nuevo evento personal" });
    await t.user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    expect(await within(dlg).findByText("Escribe un título para el evento.")).toBeInTheDocument();
    expect(eventsOf(t)).toHaveLength(0);
  });

  it("sobre una cita ya agendada: el servidor rechaza, se dice cuál (solo el horario, sin el paciente) y no se crea nada", async () => {
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-10" });
    const cita = pickBooking(t.mock, "2026-11-10");
    await t.user.click(await screen.findByRole("button", { name: "Nuevo evento personal" }));
    const dlg = await screen.findByRole("dialog", { name: "Nuevo evento personal" });
    await t.user.type(within(dlg).getByLabelText("Título"), "Junta");
    await t.user.selectOptions(within(dlg).getByLabelText("Hora de inicio"), hhmmOf(cita.scheduledAtUtc));
    await t.user.click(within(dlg).getByRole("button", { name: "Guardar" }));

    const alert = await within(dlg).findByRole("alert");
    expect(alert).toHaveTextContent(/Ya tienes una cita agendada en ese horario \(.*(AM|PM).*\)\. Pide a recepción que la mueva/);
    expect(alert).not.toHaveTextContent(cita.patient!.name);
    expect(t.mock.db.personalEvents.filter((e) => e.title === "Junta")).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Nuevo evento personal" })).toBeInTheDocument();        // se queda abierto para corregir
    expect(t.violations).toEqual([]);
  });
});

describe("editar y eliminar un evento personal", () => {
  it("tocar el evento abre sus datos (sin el aviso de «nuevo»); cambiar el título manda SOLO el título", async () => {
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-11" });
    await t.user.click(await screen.findByRole("button", { name: /^Evento personal: Comida/ }));
    const dlg = await screen.findByRole("dialog", { name: "Evento personal" });
    expect(within(dlg).getByLabelText("Título")).toHaveValue(COMIDA);
    expect(within(dlg).getByLabelText("Día")).toHaveValue("2026-11-11");
    expect(within(dlg).getByLabelText("Hora de inicio")).toHaveValue("13:00");
    expect(within(dlg).getByLabelText("Duración")).toHaveValue("60");
    expect(within(dlg).queryByText(/no una cita de la clínica/)).toBeNull();

    const id = idOf(t, COMIDA);
    await t.user.clear(within(dlg).getByLabelText("Título"));
    await t.user.type(within(dlg).getByLabelText("Título"), "Comida con el director");
    await t.user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(eventsOf(t)).toHaveLength(1));
    expect(eventsOf(t)[0]).toMatchObject({ method: "PATCH", path: `/api/doctor/personal-events/${id}`, body: { title: "Comida con el director" } });
    expect(await screen.findByRole("button", { name: /^Evento personal: Comida con el director/ })).toBeInTheDocument();
    expect(t.violations).toEqual([]);
  });

  it("cambiar la hora y la duración manda el horario nuevo; borrar las notas manda null", async () => {
    const server = makeServer();
    server.mock.db.personalEvents.find((e) => e.title === COMIDA)!.notes = "Mesa para 6";
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-11", server });
    await t.user.click(await screen.findByRole("button", { name: /^Evento personal: Comida/ }));
    const dlg = await screen.findByRole("dialog", { name: "Evento personal" });
    expect(within(dlg).getByLabelText("Notas (opcional)")).toHaveValue("Mesa para 6");
    await t.user.clear(within(dlg).getByLabelText("Notas (opcional)"));
    await t.user.selectOptions(within(dlg).getByLabelText("Hora de inicio"), "14:00");
    await t.user.selectOptions(within(dlg).getByLabelText("Duración"), "120");
    await t.user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(eventsOf(t)).toHaveLength(1));
    // 14:00 a 16:00 de Cancún = 19:00 a 21:00 UTC
    expect(eventsOf(t)[0]!.body).toEqual({ notes: null, startUtc: "2026-11-11T19:00:00.000Z", endUtc: "2026-11-11T21:00:00.000Z" });
  });

  it("una duración que no está en la lista (80 min) se conserva al editar", async () => {
    const server = makeServer();
    const ev = server.mock.db.personalEvents.find((e) => e.title === COMIDA)!;
    ev.endUtc = new Date(Date.parse(ev.startUtc) + 80 * 60_000).toISOString();
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-11", server });
    await t.user.click(await screen.findByRole("button", { name: /^Evento personal: Comida/ }));
    const dlg = await screen.findByRole("dialog", { name: "Evento personal" });
    expect(within(dlg).getByLabelText("Duración")).toHaveValue("80");
    expect(within(within(dlg).getByLabelText("Duración")).getByRole("option", { name: "1 h 20 min" })).toBeInTheDocument();
    await t.user.click(within(dlg).getByRole("button", { name: "Guardar" }));                     // sin cambios: no manda nada
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(eventsOf(t)).toHaveLength(0);
  });

  it("eliminar pide confirmar; «No» no borra, «Sí, eliminar» lo borra y desaparece de la rejilla", async () => {
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-11" });
    const id = idOf(t, COMIDA);
    await t.user.click(await screen.findByRole("button", { name: /^Evento personal: Comida/ }));
    const dlg = await screen.findByRole("dialog", { name: "Evento personal" });
    await t.user.click(within(dlg).getByRole("button", { name: "Eliminar" }));
    expect(within(dlg).getByText("¿Eliminar este evento?")).toBeInTheDocument();
    await t.user.click(within(dlg).getByRole("button", { name: "No" }));
    expect(within(dlg).queryByText("¿Eliminar este evento?")).toBeNull();
    expect(eventsOf(t)).toHaveLength(0);

    await t.user.click(within(dlg).getByRole("button", { name: "Eliminar" }));
    await t.user.click(within(dlg).getByRole("button", { name: "Sí, eliminar" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Evento personal: Comida/ })).toBeNull());
    expect(eventsOf(t)).toHaveLength(1);
    expect(eventsOf(t)[0]).toMatchObject({ method: "DELETE", path: `/api/doctor/personal-events/${id}` });
    expect(t.mock.db.personalEvents.some((e) => e.title === COMIDA)).toBe(false);
    expect(t.mock.db.personalEvents.some((e) => e.title === "Junta de especialidad")).toBe(true);   // el de otro doctor no se toca
    expect(t.violations).toEqual([]);
  });

  it("si el evento ya no existe (se borró desde otro aparato) lo dice y la agenda lo quita", async () => {
    const server = makeServer();
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-11", server });
    await t.user.click(await screen.findByRole("button", { name: /^Evento personal: Comida/ }));
    const dlg = await screen.findByRole("dialog", { name: "Evento personal" });
    server.mock.db.personalEvents.splice(server.mock.db.personalEvents.findIndex((e) => e.title === COMIDA), 1);
    await t.user.clear(within(dlg).getByLabelText("Título"));
    await t.user.type(within(dlg).getByLabelText("Título"), "Otro título");
    await t.user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/no existe/i);   // el simulador dice «El evento no existe.»; el servidor real, solo el código (→ «Ya no existe…»)
    await waitFor(() => expect(blocks()).toHaveLength(0));
  });
});

describe("eventos personales sin conexión: solo lectura", () => {
  it("al abrir la app SIN servidor, los eventos de esa semana salen de la copia guardada en el dispositivo (y se borran al cerrar sesión)", async () => {
    const server = makeServer();
    const first = await mountApp({ hash: "#/hoy?dia=2026-11-11", server });
    await screen.findByRole("button", { name: /^Evento personal: Comida/ });
    await waitFor(() => expect(storedKeys().some((k) => k.includes(":agenda:events:"))).toBe(true));
    first.unmount();

    server.mock.controls.setOffline(true);                                      // «se abre la app en un túnel»
    const second = await mountApp({ hash: "#/hoy?dia=2026-11-11", server, as: null });
    expect(await screen.findByRole("button", { name: /^Evento personal: Comida con residentes, 1:00\sPM a 2:00\sPM$/ })).toBeInTheDocument();
    expect(await screen.findByTestId("offline-pill")).toHaveTextContent("Sin conexión");
    expect(screen.getByRole("button", { name: "Nuevo evento personal" })).toBeDisabled();
    second.unmount();
  });

  it("cerrar sesión borra del dispositivo los eventos guardados", async () => {
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-11" });
    await screen.findByRole("button", { name: /^Evento personal: Comida/ });
    await waitFor(() => expect(storedKeys().some((k) => k.includes(":agenda:events:"))).toBe(true));
    window.location.hash = "#/cuenta";
    await t.user.click(await screen.findByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(storedKeys()).toEqual([]);                                           // ni sesión, ni agenda, ni eventos personales
  });

  it("se siguen viendo; «Evento» y tocar un hueco quedan sin efecto, con el motivo", async () => {
    const t = await mountApp({ hash: "#/hoy?dia=2026-11-11" });
    await screen.findByRole("button", { name: /^Evento personal: Comida/ });
    setBrowserOnline(false);
    expect(await screen.findByTestId("offline-pill")).toHaveTextContent("Sin conexión");
    const nuevo = screen.getByRole("button", { name: "Nuevo evento personal" });
    expect(nuevo).toBeDisabled();
    expect(nuevo).toHaveAttribute("title", expect.stringMatching(/Sin conexión/));
    fireEvent.click(document.querySelector<HTMLElement>('[data-lane="d1"]')!, { clientY: 10 * 48 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /^Evento personal: Comida/ })).toBeInTheDocument();    // lo guardado sigue a la vista

    // abrir uno que ya está: se puede leer, pero guardar y eliminar quedan deshabilitados
    await t.user.click(screen.getByRole("button", { name: /^Evento personal: Comida/ }));
    const dlg = await screen.findByRole("dialog", { name: "Evento personal" });
    expect(within(dlg).getByRole("button", { name: "Guardar" })).toBeDisabled();
    expect(within(dlg).getByRole("button", { name: "Eliminar" })).toBeDisabled();
    expect(within(dlg).getByText(/Sin conexión: esto necesita internet/)).toBeInTheDocument();
    expect(eventsOf(t)).toHaveLength(0);
  });
});
