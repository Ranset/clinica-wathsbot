import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { PREFIX } from "../src/lib/storage";
import { account, bookingButton, freezeClock, localDay, makeServer, mountApp, pickBooking, storedKeys } from "./helpers";

beforeEach(freezeClock);

const heading = () => screen.findByRole("heading", { level: 1 });
const agendaRequests = (log: ReturnType<typeof makeServer>["log"]) => log.filter((r) => r.path === "/api/doctor/appointments");

describe("entrada", () => {
  it("sin sesión pide correo y contraseña; un doctor entra a Hoy con su nombre y SUS citas", async () => {
    const t = await mountApp({ as: null });
    await t.user.type(await screen.findByLabelText("Correo"), account("doctor").email);
    await t.user.type(screen.getByLabelText("Contraseña"), account("doctor").password);
    await t.user.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await heading()).toHaveTextContent("Martes, 10 de noviembre de 2026");
    expect(await screen.findByText("Dr. Cervantes Peláez")).toBeInTheDocument(); // el carril es MI agenda
    expect(screen.getByText("Proctología")).toBeInTheDocument();
    expect(await bookingButton(pickBooking(t.mock, "2026-11-10"))).toBeInTheDocument();
    expect(window.location.hash).toBe("#/hoy");
    expect(t.violations).toEqual([]);
  });

  it("una contraseña incorrecta se queda en el formulario con el aviso", async () => {
    const t = await mountApp({ as: null });
    await t.user.type(await screen.findByLabelText("Correo"), account("doctor").email);
    await t.user.type(screen.getByLabelText("Contraseña"), "no-es-la-clave");
    await t.user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("Correo o contraseña incorrectos.")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Secciones" })).toBeNull();
  });

  it("el personal (o el administrador) NO entra: ve un aviso, sin menú, y puede cerrar sesión", async () => {
    for (const role of ["staff", "admin"] as const) {
      const t = await mountApp({ as: role });
      expect(await screen.findByText("Esta app es para los doctores")).toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Secciones" })).toBeNull();
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
      // y nada de esta cuenta se guarda para abrir sin conexión
      expect(storedKeys().filter((k) => k.endsWith(":session"))).toEqual([]);
      await t.user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      expect(await screen.findByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
      t.unmount();
    }
  });

  it("con la sesión vencida (401) en pleno uso, vuelve al login con el aviso", async () => {
    const t = await mountApp();
    await heading();
    t.mock.controls.expireSession();
    window.dispatchEvent(new Event("focus")); // lo que hace volver a la pestaña: consulta de inmediato
    expect(await screen.findByText("Tu sesión terminó. Inicia sesión de nuevo.")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
  });
});

describe("Hoy", () => {
  it("muestra mis citas y solo las mías, y el detalle NO trae el teléfono del paciente", async () => {
    const t = await mountApp();
    const mine = pickBooking(t.mock, "2026-11-10");
    const phone = mine.patient!.phone!;
    expect(phone).toMatch(/^\d{10,}$/);
    await t.user.click(await bookingButton(mine));

    const dlg = await screen.findByRole("dialog", { name: mine.patient!.name });
    expect(within(dlg).getByText("Fecha y hora")).toBeInTheDocument();
    expect(within(dlg).getByText(/Por privacidad no ves el teléfono/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(phone);
    expect(document.body.textContent).not.toContain(phone.slice(-7));

    // y ninguna cita de otro doctor aparece (el servidor ya las filtra)
    const others = t.mock.db.bookings.filter((b) => b.kind === "session" && b.doctor?.id !== "d1" && localDay(b.scheduledAtUtc) === "2026-11-10");
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) expect(screen.queryByRole("button", { name: new RegExp(`^${o.patient!.name},`) })).toBeNull();
    expect(t.violations).toEqual([]);
  });

  it("el día se cambia con las flechas sin volver a pedir nada (la semana ya está) y «Hoy» regresa", async () => {
    const t = await mountApp();
    await heading();
    await screen.findByText("Dr. Cervantes Peláez");
    await waitFor(() => expect(agendaRequests(t.log)).toHaveLength(1));

    await t.user.click(screen.getByRole("button", { name: "Día siguiente" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Miércoles, 11 de noviembre de 2026"));
    expect(window.location.hash).toBe("#/hoy?dia=2026-11-11");
    expect(agendaRequests(t.log)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Hoy" })).toBeEnabled();

    await t.user.click(screen.getByRole("button", { name: "Hoy" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Martes, 10 de noviembre"));
    expect(window.location.hash).toBe("#/hoy");
    expect(screen.getByRole("button", { name: "Hoy" })).toBeDisabled();
  });

  it("avisa de mi ausencia registrada para ese día", async () => {
    const server = makeServer();
    server.mock.db.absences.push({ id: "a-prueba", doctorId: "d1", startUtc: "2026-11-10T05:00:00.000Z", endUtc: "2026-11-11T05:00:00.000Z", reason: "Congreso" });
    await mountApp({ server });
    expect(await screen.findByText(/Ausencia registrada: mar 10 nov \(todo el día\) — Congreso/)).toBeInTheDocument();
  });
});

describe("Semana", () => {
  it("pinta los 7 días con mis citas (con su contador) y tocar un día lleva a Hoy de ese día", async () => {
    const t = await mountApp({ hash: "#/semana" });
    expect(await heading()).toHaveTextContent("9 – 15 de nov de 2026");
    await screen.findByRole("button", { name: /^Ver el lun 9/ });
    expect(document.querySelectorAll("[data-day]")).toHaveLength(7);

    const esperadas = t.mock.db.bookings.filter(
      (b) => b.kind === "session" && b.status !== "cancelada" && b.doctor?.id === "d1" && b.scheduledAtUtc >= "2026-11-09T05:00:00.000Z" && b.scheduledAtUtc < "2026-11-16T05:00:00.000Z"
    ).length;
    expect(esperadas).toBeGreaterThan(5);
    await waitFor(() => expect(screen.getByTestId("booking-count")).toHaveTextContent(`${esperadas} citas`));

    await t.user.click(screen.getByRole("button", { name: /^Ver el jue 12/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/hoy?dia=2026-11-12"));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Jueves, 12 de noviembre");
  });

  it("la semana siguiente pide su propio rango; Hoy y Semana comparten la misma consulta", async () => {
    const t = await mountApp({ hash: "#/semana" });
    await heading();
    await waitFor(() => expect(agendaRequests(t.log)).toHaveLength(1));
    window.location.hash = "#/hoy";
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Martes"));
    expect(agendaRequests(t.log)).toHaveLength(1); // pasar de Semana a Hoy no vuelve a pedir

    window.location.hash = "#/semana";
    await t.user.click(await screen.findByRole("button", { name: "Semana siguiente" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("16 – 22 de nov de 2026"));
    await waitFor(() => expect(agendaRequests(t.log)).toHaveLength(2));
  });
});

describe("cuenta y cierre de sesión", () => {
  it("cerrar sesión borra lo guardado en el dispositivo y vuelve al login", async () => {
    const t = await mountApp({ hash: "#/cuenta" });
    expect(await screen.findByText("Mi cuenta")).toBeInTheDocument();
    await waitFor(() => expect(storedKeys().length).toBeGreaterThan(1)); // sesión + perfil (+ ausencias…)
    expect(storedKeys().some((k) => k.endsWith(":session"))).toBe(true);

    await t.user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(storedKeys()).toEqual([]);
    expect(t.log.some((r) => r.method === "POST" && r.path === "/api/auth/logout")).toBe(true);
  });

  it("otro doctor que entra en el mismo dispositivo no hereda (ni deja guardado) lo del anterior", async () => {
    const t = await mountApp({ as: null });
    // lo que quedó de otro usuario en este dispositivo
    window.localStorage.setItem(`${PREFIX}u99:agenda:x`, JSON.stringify({ savedAt: "2026-11-09T15:00:00.000Z", data: [] }));
    window.localStorage.setItem(`${PREFIX}u99:profile`, JSON.stringify({ savedAt: "2026-11-09T15:00:00.000Z", data: {} }));
    await t.user.type(await screen.findByLabelText("Correo"), account("doctor").email);
    await t.user.type(screen.getByLabelText("Contraseña"), account("doctor").password);
    await t.user.click(screen.getByRole("button", { name: "Entrar" }));
    await heading();
    expect(storedKeys().filter((k) => k.includes(":u99:"))).toEqual([]);
    expect(storedKeys().length).toBeGreaterThan(0);
  });

  it("una dirección desconocida lleva a Hoy", async () => {
    await mountApp({ hash: "#/algo-que-no-existe" });
    await heading();
    expect(window.location.hash).toBe("#/hoy");
  });
});
