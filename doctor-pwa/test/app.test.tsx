import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PREFIX } from "../src/lib/storage";
import { account, bookingButton, doctorCredentials, freezeClock, localDay, makeServer, mountApp, pickBooking, signIn, storedKeys } from "./helpers";

beforeEach(freezeClock);

const heading = () => screen.findByRole("heading", { level: 1 });
const agendaRequests = (log: ReturnType<typeof makeServer>["log"]) => log.filter((r) => r.path === "/api/doctor/appointments");

describe("entrada", () => {
  it("sin sesión pide usuario (código o nombre del doctor) y contraseña; un doctor entra a Hoy con su nombre y SUS citas", async () => {
    const t = await mountApp({ as: null });
    expect(await screen.findByRole("combobox", { name: "Usuario" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Correo")).toBeNull(); // ya no se pide correo
    await signIn(t.user);

    expect(await heading()).toHaveTextContent("Martes, 10 de noviembre de 2026");
    expect(await screen.findByText("Dr. Cervantes Peláez")).toBeInTheDocument(); // el carril es MI agenda
    expect(screen.getByText("Proctología")).toBeInTheDocument();
    expect(await bookingButton(pickBooking(t.mock, "2026-11-10"))).toBeInTheDocument();
    expect(window.location.hash).toBe("#/hoy");
    expect(t.violations).toEqual([]);
  });

  it("una contraseña incorrecta se queda en el formulario con el aviso", async () => {
    const t = await mountApp({ as: null });
    await signIn(t.user, { code: doctorCredentials().code, password: "no-es-la-clave" });
    expect(await screen.findByText("Usuario o contraseña incorrectos.")).toBeInTheDocument();
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

  describe("tocar la fecha abre el selector de día", () => {
    const pickerButton = () => screen.getByRole("button", { name: /Elegir otra fecha$/ });
    const pickerInput = () => document.querySelector<HTMLInputElement>('input[type="date"][aria-hidden="true"]')!;

    it("el título es un botón que dice «Elegir otra fecha» y pone el foco en el selector nativo (sin showPicker, como en jsdom)", async () => {
      const t = await mountApp();
      await heading();
      expect(pickerButton()).toHaveAccessibleName("Martes, 10 de noviembre de 2026. Elegir otra fecha");
      expect(pickerInput()).toHaveValue("2026-11-10");                          // el selector parte del día que se ve
      await t.user.click(pickerButton());
      expect(pickerInput()).toHaveFocus();
    });

    it("al elegir otro día de la misma semana salta a él sin volver a pedir la agenda; al elegir otra semana, pide esa semana", async () => {
      const t = await mountApp();
      await heading();
      await screen.findByText("Dr. Cervantes Peláez");
      await waitFor(() => expect(agendaRequests(t.log)).toHaveLength(1));

      fireEvent.change(pickerInput(), { target: { value: "2026-11-13" } });
      await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Viernes, 13 de noviembre de 2026"));
      expect(window.location.hash).toBe("#/hoy?dia=2026-11-13");
      expect(pickerInput()).toHaveValue("2026-11-13");
      expect(agendaRequests(t.log)).toHaveLength(1);                            // la semana ya estaba

      fireEvent.change(pickerInput(), { target: { value: "2026-11-24" } });
      await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Martes, 24 de noviembre de 2026"));
      await waitFor(() => expect(agendaRequests(t.log)).toHaveLength(2));       // otra semana: su propia consulta
      expect(screen.getByRole("button", { name: "Hoy" })).toBeEnabled();        // y «Hoy» regresa

      await t.user.click(screen.getByRole("button", { name: "Hoy" }));
      await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Martes, 10 de noviembre"));
    });

    it("borrar la fecha en el selector (valor vacío) no cambia nada", async () => {
      await mountApp();
      await heading();
      fireEvent.change(pickerInput(), { target: { value: "" } });
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Martes, 10 de noviembre de 2026");
      expect(window.location.hash).toBe("#/hoy");
    });

    it("en Semana el título es solo texto (el selector es de la vista Hoy)", async () => {
      await mountApp({ hash: "#/semana" });
      expect(await heading()).toHaveTextContent("9 – 15 de nov de 2026");
      expect(screen.queryByRole("button", { name: /Elegir otra fecha$/ })).toBeNull();
    });
  });

  it("avisa de mi ausencia registrada para ese día", async () => {
    const server = makeServer();
    server.mock.db.absences.push({ id: "a-prueba", doctorId: "d1", startUtc: "2026-11-10T05:00:00.000Z", endUtc: "2026-11-11T05:00:00.000Z", reason: "Congreso" });
    await mountApp({ server });
    expect(await screen.findByText(/Ausencia registrada: mar 10 nov \(todo el día\) — Congreso/)).toBeInTheDocument();
  });

  describe("mis ausencias se ven en la rejilla", () => {
    const bands = () => Array.from(document.querySelectorAll<HTMLElement>("[data-absence]"));
    const mia = (id: string, startUtc: string, endUtc: string, reason: string | null) => ({ id, doctorId: "d1", startUtc, endUtc, reason });

    it("una ausencia de todo el día pinta una franja rayada en la columna del día, con su motivo", async () => {
      const server = makeServer();
      server.mock.db.absences.push(mia("a-dia", "2026-11-10T05:00:00.000Z", "2026-11-11T05:00:00.000Z", "Congreso"));
      await mountApp({ server });
      await screen.findByText(/Ausencia registrada: mar 10 nov/);       // el aviso de arriba sigue
      await waitFor(() => expect(bands()).toHaveLength(1));
      expect(bands()[0]).toHaveAttribute("aria-label", "Ausencia · Congreso");
      expect(bands()[0]).toHaveClass("cal-absence");
      expect(bands()[0]).toHaveStyle({ top: "1px", height: `${24 * 48 - 1}px` });
      expect(bands()[0]!.closest("[data-lane]")).toHaveAttribute("data-lane", "d1");   // en MI carril
    });

    it("por horas: la franja va de la hora de inicio a la de fin (hora de Cancún) y las citas siguen visibles encima", async () => {
      const server = makeServer();
      // 10:00 a 12:00 de Cancún del martes 10 = 15:00 a 17:00 UTC
      server.mock.db.absences.push(mia("a-horas", "2026-11-10T15:00:00.000Z", "2026-11-10T17:00:00.000Z", null));
      const t = await mountApp({ server });
      await waitFor(() => expect(bands()).toHaveLength(1));
      expect(bands()[0]).toHaveAttribute("aria-label", "Ausencia");
      expect(bands()[0]).toHaveStyle({ top: `${10 * 48 + 1}px`, height: `${2 * 48 - 1}px` });
      expect(await bookingButton(pickBooking(t.mock, "2026-11-10"))).toBeInTheDocument();
    });

    it("en Semana: una franja en cada día que cubre la ausencia, y ninguna en los demás", async () => {
      const server = makeServer();
      // de miércoles 11 a viernes 13 completos (3 días)
      server.mock.db.absences.push(mia("a-sem", "2026-11-11T05:00:00.000Z", "2026-11-14T05:00:00.000Z", "Vacaciones"));
      await mountApp({ hash: "#/semana", server });
      await waitFor(() => expect(bands()).toHaveLength(3));
      const days = bands().map((b) => b.closest("[data-day]")!.getAttribute("data-day"));
      expect(days).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
    });

    it("una ausencia larga que empezó semanas antes se ve en la semana que estoy mirando", async () => {
      const server = makeServer();
      server.mock.db.absences.push(mia("a-larga", "2026-10-01T05:00:00.000Z", "2026-12-20T05:00:00.000Z", "Licencia"));
      await mountApp({ hash: "#/semana", server });
      await waitFor(() => expect(bands()).toHaveLength(7));
    });

    it("sin ausencias no hay franjas; las de otro doctor no llegan; y al registrar una nueva se pinta al actualizar", async () => {
      const server = makeServer();
      server.mock.db.absences.push({ id: "a-ajena", doctorId: "d5", startUtc: "2026-11-10T05:00:00.000Z", endUtc: "2026-11-11T05:00:00.000Z", reason: "De otro doctor" });
      await mountApp({ server });
      await screen.findByText("Dr. Cervantes Peláez");
      await new Promise((r) => setTimeout(r, 50));
      expect(bands()).toHaveLength(0);
      expect(screen.queryByText(/Ausencia registrada/)).toBeNull();

      server.mock.db.absences.push(mia("a-nueva", "2026-11-10T05:00:00.000Z", "2026-11-11T05:00:00.000Z", "Trámite"));
      window.dispatchEvent(new Event("focus"));
      await waitFor(() => expect(bands()).toHaveLength(1), { timeout: 3000 });
      expect(bands()[0]).toHaveAttribute("aria-label", "Ausencia · Trámite");
    });
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
    await signIn(t.user);
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
