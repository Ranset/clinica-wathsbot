import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { doctorColor } from "@clinica/calendar";
import type { MockApi } from "@clinica/api-client/mock";
import { features } from "../src/features";
import { NOW, account, bookingButton, freezeClock, localDay, mountApp, pickBooking } from "./helpers";

beforeEach(freezeClock);

/** Las funciones apagadas por defecto (`src/features.ts`): cada prueba que enciende una la deja como estaba. */
const FEATURE_DEFAULTS = { ...features };
afterEach(() => {
  Object.assign(features, FEATURE_DEFAULTS);
});

/** Cada prueba cierra comprobando que ninguna peticion/respuesta salio del contrato. */
let violations: string[] = [];
afterEach(() => {
  expect(violations).toEqual([]);
  violations = [];
});

const cell = (laneName: RegExp) => document.querySelector<HTMLElement>(`[data-lane="${laneId(laneName)}"]`)!;
const laneId = (name: RegExp) => ({ cervantes: "d1", perez: "d2", bordas: "d3", torrealba: "d4", molina: "d5", geydi: "d6", arguelles: "d7" })[name.source.toLowerCase() as "cervantes"];

async function ready() {
  // El calendario cargo: ya hay citas pintadas.
  await screen.findAllByRole("button", { name: /\d{1,2}:\d{2}\s[AP]M a \d{1,2}:\d{2}\s[AP]M$/ });
}

describe("sesion", () => {
  it("sin sesion muestra el login; credenciales malas dan un mensaje claro y las buenas entran", async () => {
    const { user, violations: v } = await mountApp({ as: null });
    violations = v;
    await screen.findByRole("form", { name: "Iniciar sesión" });

    await user.type(screen.getByLabelText("Correo"), account("staff").email);
    await user.type(screen.getByLabelText("Contraseña"), "no-es-la-clave");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Correo o contraseña incorrectos.");

    await user.clear(screen.getByLabelText("Contraseña"));
    await user.type(screen.getByLabelText("Contraseña"), account("staff").password);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("heading", { name: "Citas" })).toBeInTheDocument();
  });

  it("cerrar sesion regresa al login", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    await screen.findByRole("heading", { name: "Citas" });
    await user.click(screen.getByRole("button", { name: /Cuenta de Recepción Clínica/ }));
    await user.click(screen.getByRole("menuitem", { name: "Cerrar sesión" }));
    await screen.findByRole("form", { name: "Iniciar sesión" });
  });

  it("si la sesion vence en pleno uso, regresa al login con un aviso", async () => {
    const { user, mock, violations: v } = await mountApp({ hash: "#/atencion" });
    violations = v;
    await screen.findByRole("heading", { name: "Atención" });
    mock.controls.expireSession();
    await user.click(screen.getByRole("link", { name: /Doctores/ }));
    expect(await screen.findByText("Tu sesión terminó. Inicia sesión de nuevo.")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
    // el 401 del bot/atencion que estaba en vuelo no es una violacion del contrato (lo declara)
    violations = violations.filter((x) => !x.includes("responde 401"));
  });

  it("un doctor no usa esta web: se le manda a la app del doctor", async () => {
    const { violations: v } = await mountApp({ as: "doctor" });
    violations = v;
    expect(await screen.findByText("Esta página es para el personal de la clínica")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});

describe("permisos en la interfaz", () => {
  it("el personal ve Calendario, Doctores y Atencion, pero no Usuarios; y no entra a #/usuarios", async () => {
    const { violations: v } = await mountApp({ as: "staff", hash: "#/usuarios" });
    violations = v;
    await screen.findByText("Esta sección no está disponible para tu rol");
    const nav = screen.getByRole("navigation", { name: "Secciones" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent?.replace(/\d+$/, ""))).toEqual(["Calendario", "Doctores", "Atención"]);
  });

  it("el administrador ve ademas Usuarios", async () => {
    const { violations: v } = await mountApp({ as: "admin", hash: "#/usuarios" });
    violations = v;
    await screen.findByRole("heading", { name: "Usuarios" });
    const nav = screen.getByRole("navigation", { name: "Secciones" });
    expect(within(nav).getByRole("link", { name: "Usuarios" })).toBeInTheDocument();
  });

  it("el personal y el administrador dan de alta doctores y cambian el horario de la clinica; Usuarios es solo del administrador", async () => {
    const staff = await mountApp({ as: "staff", hash: "#/doctores" });
    violations = staff.violations;
    await screen.findByRole("heading", { name: "Doctores" });
    expect(screen.getByRole("button", { name: "Nuevo doctor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cambiar" })).toBeInTheDocument();   // horario de la clinica
    expect(screen.queryByRole("link", { name: "Usuarios" })).not.toBeInTheDocument();
    staff.unmount();

    const admin = await mountApp({ as: "admin", hash: "#/doctores" });
    violations = [...violations, ...admin.violations];
    expect(await screen.findByRole("button", { name: "Nuevo doctor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cambiar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Usuarios" })).toBeInTheDocument();
  });
});

describe("calendario", () => {
  it("dia por carriles: una columna por doctor, con el horario de cada uno sombreado", async () => {
    const { violations: v } = await mountApp();
    violations = v;
    await ready();
    expect(document.querySelectorAll("[data-lane]")).toHaveLength(7);
    for (const name of ["Dr. Cervantes Peláez", "Dr. Pérez Lago", "Dra. Geydi", "Dra. Ana del Carmen Argüelles"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    // Perez Lago solo atiende martes y jueves 10-14: hoy es martes, asi que hay sombra antes (00-10) y despues (14-24).
    expect(cell(/perez/).querySelectorAll(".cal-off")).toHaveLength(2);
    // Geydi solo los sabados: hoy (martes) su columna esta sombreada completa.
    expect(cell(/geydi/).querySelectorAll(".cal-off")).toHaveLength(1);
    expect(cell(/cervantes/).querySelectorAll(".cal-off")).toHaveLength(2);
  });

  it("columnas por consultorio y filtro por doctor", async () => {
    const { user, mock, violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-11" });
    violations = v;
    const cervantes = pickBooking(mock, "2026-11-11", { doctorId: "d1" });
    const other = pickBooking(mock, "2026-11-11", { doctorId: "d4" });
    await ready();
    await user.click(screen.getByRole("button", { name: "Consultorio" }));
    await waitFor(() => expect(document.querySelectorAll("[data-lane]")).toHaveLength(2));
    expect(window.location.hash).toContain("carriles=consultorio");

    await user.click(screen.getByRole("button", { name: "Doctor" }));
    await user.selectOptions(screen.getByLabelText("Filtrar por doctor"), "d1");
    await waitFor(() => expect(document.querySelectorAll("[data-lane]")).toHaveLength(1));
    expect(await bookingButton(cervantes)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(`^${other.patient!.name},`) })).not.toBeInTheDocument();
  });

  it("cada doctor tiene su color: citas y encabezados de columna; la leyenda de colores esta apagada por defecto", async () => {
    const { user, mock, violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-11" });
    violations = v;
    const c1 = pickBooking(mock, "2026-11-11", { doctorId: "d1" });
    const c4 = pickBooking(mock, "2026-11-11", { doctorId: "d4" });
    await ready();

    // dia por doctor: la cita se rellena con el color de su doctor y cada columna lleva su franja
    expect(await bookingButton(c1)).toHaveStyle({ backgroundColor: doctorColor("d1")! });
    expect(await bookingButton(c4)).toHaveStyle({ backgroundColor: doctorColor("d4")! });
    expect(doctorColor("d1")).not.toBe(doctorColor("d4"));
    for (const id of ["d1", "d2", "d3", "d4", "d5", "d6", "d7"]) {
      expect(document.querySelector(`[data-lane-head="${id}"]`)).toHaveStyle({ borderTopColor: doctorColor(id)! });
    }

    // semana: los colores se ven igual, pero SIN leyenda (apagada: `features.doctorLegend`); el filtro de la barra sigue ahi
    await user.click(screen.getByRole("button", { name: "Semana" }));
    expect(await bookingButton(c4)).toHaveStyle({ backgroundColor: doctorColor("d4")! });
    expect(screen.queryByRole("list", { name: "Colores por doctor" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Filtrar por doctor")).toBeInTheDocument();
  });

  it("la leyenda de colores (apagada por defecto) vuelve al encenderla con features.doctorLegend: lista a los doctores y filtra al hacer clic", async () => {
    features.doctorLegend = true;
    const { user, mock, violations: v } = await mountApp({ hash: "#/calendario?vista=semana&dia=2026-11-11" });
    violations = v;
    const c1 = pickBooking(mock, "2026-11-11", { doctorId: "d1" });
    const c4 = pickBooking(mock, "2026-11-11", { doctorId: "d4" });
    const legend = await screen.findByRole("list", { name: "Colores por doctor" });
    expect(within(legend).getAllByRole("button")).toHaveLength(7);
    const chip = within(legend).getByRole("button", { name: /Dr\. Gustavo Torrealba/ });
    expect(chip.querySelector("span")).toHaveStyle({ backgroundColor: doctorColor("d4")! });
    expect(await bookingButton(c4)).toHaveStyle({ backgroundColor: doctorColor("d4")! });

    // en «Día» por doctor sobra (los encabezados ya llevan el color y el nombre)
    await user.click(screen.getByRole("button", { name: "Día" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Colores por doctor" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Semana" }));
    const again = await screen.findByRole("list", { name: "Colores por doctor" });

    // un clic en un doctor de la leyenda filtra por el; otro clic vuelve a mostrar a todos
    await user.click(within(again).getByRole("button", { name: /Dr\. Gustavo Torrealba/ }));
    await waitFor(() => expect(window.location.hash).toContain("doctor=d4"));
    expect(within(again).getByRole("button", { name: /Dr\. Gustavo Torrealba/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Filtrar por doctor")).toHaveValue("d4");
    await waitFor(() => expect(screen.queryByRole("button", { name: new RegExp(`^${c1.patient!.name},`) })).not.toBeInTheDocument());
    await user.click(within(again).getByRole("button", { name: /Dr\. Gustavo Torrealba/ }));
    await waitFor(() => expect(window.location.hash).not.toContain("doctor="));
    expect(await bookingButton(c1)).toBeInTheDocument();
  });

  it("los bloqueos de consultorio tienen su propia columna, para que no se pierdan", async () => {
    const { user, violations: v } = await mountApp({ hash: `#/calendario?dia=2026-11-12` });
    violations = v;
    await screen.findByRole("button", { name: /Mantenimiento/ });
    expect(screen.getByText("Bloqueos")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-lane]")).toHaveLength(8);
    await user.click(screen.getByRole("button", { name: /Mantenimiento/ }));
    expect(await screen.findByRole("dialog", { name: "Mantenimiento" })).toHaveTextContent("Bloqueo de consultorio");
  });

  it("cambia de vista: semana, mes y lista muestran las citas", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    await ready();
    await user.click(screen.getByRole("button", { name: "Semana" }));
    await waitFor(() => expect(document.querySelectorAll("[data-day]")).toHaveLength(7));
    await user.click(screen.getByRole("button", { name: "Mes" }));
    await screen.findByText("Noviembre de 2026");
    await user.click(screen.getByRole("button", { name: "Lista" }));
    expect(await screen.findAllByRole("button", { name: /Dr\. /i })).not.toHaveLength(0);
    expect(window.location.hash).toContain("vista=lista");
  });

  describe("al pasar el puntero por una cita se dice el doctor, su especialidad y el consultorio", () => {
    const hover = (b: { doctor: { name: string; specialty: string } | null; room: { name: string } | null }) =>
      `${b.doctor!.name} · ${b.doctor!.specialty} · ${b.room!.name}`;

    it("día por doctor: el bloque lo dice aunque la columna ya sea del doctor", async () => {
      const m = await mountApp({ hash: "#/calendario?dia=2026-11-12" });
      violations = m.violations;
      const b = pickBooking(m.mock, "2026-11-12", { doctorId: "d1" });
      expect(await bookingButton(b)).toHaveAttribute("title", hover(b));
      expect(hover(b)).toMatch(/^Dr\. Cervantes Peláez · Proctología · Consultorio \d$/);
    });

    it("semana (filtrada por doctor): cada cita lleva su doctor y su consultorio", async () => {
      const m = await mountApp({ hash: "#/calendario?vista=semana&dia=2026-11-12" });
      violations = m.violations;
      const b = pickBooking(m.mock, "2026-11-12", { doctorId: "d1" });
      expect(await bookingButton(b)).toHaveAttribute("title", hover(b));
    });

    it("mes: cada cita del día lleva el aviso de SU doctor y SU consultorio", async () => {
      const m = await mountApp({ hash: "#/calendario?vista=mes&dia=2026-11-12" });
      violations = m.violations;
      await screen.findByText("Noviembre de 2026");
      const chips = await waitFor(() => {
        const c = Array.from(document.querySelectorAll<HTMLElement>("button[title]")).filter((el) => / · Consultorio \d$/.test(el.getAttribute("title")!));
        if (c.length === 0) throw new Error("sin citas en el mes");
        return c;
      });
      for (const chip of chips) {
        const patient = m.mock.db.bookings.find((b) => b.patient && chip.textContent?.includes(b.patient.name));
        expect(patient, chip.textContent ?? "").toBeDefined();
        expect(chip).toHaveAttribute("title", hover(patient!));
      }
    });

    it("un bloqueo de consultorio dice solo el consultorio", async () => {
      const m = await mountApp({ hash: "#/calendario?dia=2026-11-12" });
      violations = m.violations;
      await ready();
      const bloqueo = m.mock.db.bookings.find((b) => b.kind === "block" && localDay(b.scheduledAtUtc) === "2026-11-12");
      expect(bloqueo, "el simulador trae un bloqueo ese día").toBeDefined();
      expect(await screen.findByTitle(bloqueo!.room!.name)).toHaveTextContent(bloqueo!.notes!);
    });
  });

  it("clic en un hueco vacio abre 'Nueva cita' con doctor, dia y hora ya puestos", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    await ready();
    // 14:00 en la columna de Cervantes (48 px por hora; jsdom da top = 0).
    fireEvent.click(cell(/cervantes/), { clientY: 48 * 14 });
    const dialog = await screen.findByRole("dialog", { name: "Nueva cita" });
    expect(within(dialog).getByLabelText("Doctor")).toHaveValue("d1");
    expect(within(dialog).getByLabelText("Hora")).toHaveValue("14:00");
    expect(within(dialog).getByLabelText("Fecha")).toHaveValue("2026-11-10");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("agenda una cita: valida el nombre, la crea y aparece en la rejilla", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    await ready();
    await user.click(screen.getByRole("button", { name: "Nueva cita" }));
    const dialog = await screen.findByRole("dialog", { name: "Nueva cita" });

    await user.type(within(dialog).getByLabelText("Paciente"), "Solonombre");
    await user.click(within(dialog).getByRole("button", { name: "Agendar cita" }));
    expect(await within(dialog).findByText("Escribe el nombre y el apellido del paciente.")).toBeInTheDocument();
    expect(mock.db.bookings.some((b) => b.patient?.name === "Solonombre")).toBe(false);

    await user.clear(within(dialog).getByLabelText("Paciente"));
    await user.type(within(dialog).getByLabelText("Paciente"), "Paciente Nuevo");
    await user.type(within(dialog).getByLabelText(/Teléfono/), "52 998 000 5555");
    await user.selectOptions(within(dialog).getByLabelText("Doctor"), "d1");
    fireEvent.change(within(dialog).getByLabelText("Fecha"), { target: { value: "2026-11-10" } });
    await user.selectOptions(within(dialog).getByLabelText("Hora"), "15:00");
    await user.click(within(dialog).getByRole("button", { name: "Agendar cita" }));

    expect(await screen.findByText("Cita agendada.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const saved = mock.db.bookings.find((b) => b.patient?.name === "Paciente Nuevo")!;
    expect(saved).toMatchObject({ source: "manual", status: "agendada", patient: { phone: "529980005555" }, doctor: { id: "d1" } });
    expect(await screen.findByRole("button", { name: /Paciente Nuevo/ })).toBeInTheDocument();
  });

  it("si el hueco ya no esta libre (409) lo dice, no cierra el formulario y refresca la agenda", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    await ready();
    await user.click(screen.getByRole("button", { name: "Nueva cita" }));
    const dialog = await screen.findByRole("dialog", { name: "Nueva cita" });
    await user.type(within(dialog).getByLabelText("Paciente"), "Paciente Choque");
    await user.selectOptions(within(dialog).getByLabelText("Doctor"), "d1");
    fireEvent.change(within(dialog).getByLabelText("Fecha"), { target: { value: "2026-11-11" } });
    await user.selectOptions(within(dialog).getByLabelText("Hora"), "09:00"); // Cervantes ya tiene cita a esa hora (datos de ejemplo)
    await user.click(within(dialog).getByRole("button", { name: "Agendar cita" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("ya tiene una cita en ese horario");
    expect(alert).toHaveTextContent("Elige otro horario.");
    expect(screen.getByRole("dialog", { name: "Nueva cita" })).toBeInTheDocument();
    expect(mock.db.bookings.some((b) => b.patient?.name === "Paciente Choque")).toBe(false);
  });

  it("avisa de una regla de agenda (422) con el texto del servidor: antelacion minima", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    await ready();
    await user.click(screen.getByRole("button", { name: "Nueva cita" }));
    const dialog = await screen.findByRole("dialog", { name: "Nueva cita" });
    await user.type(within(dialog).getByLabelText("Paciente"), "Paciente Urgente");
    await user.selectOptions(within(dialog).getByLabelText("Doctor"), "d1");
    await user.selectOptions(within(dialog).getByLabelText("Hora"), "10:30"); // hoy, faltan 30 min
    // El formulario ya advierte antes de enviar...
    expect(within(dialog).getByText(/Faltan menos de 60 minutos/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Agendar cita" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("60 minutos de antelación");

    // ...y con «cita de mostrador» el personal sí puede.
    await user.click(within(dialog).getByRole("checkbox", { name: /Cita de mostrador/ }));
    await user.click(within(dialog).getByRole("button", { name: "Agendar cita" }));
    expect(await screen.findByText("Cita agendada.")).toBeInTheDocument();
  });

  it("si el doctor elegido no atiende a esa hora sale el aviso y «Agendar cita» queda deshabilitado; al corregirlo se habilita", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    await ready();
    await user.click(screen.getByRole("button", { name: "Nueva cita" }));
    const dialog = await screen.findByRole("dialog", { name: "Nueva cita" });
    const agendar = () => within(dialog).getByRole("button", { name: "Agendar cita" });
    const aviso = () => within(dialog).queryByText(/Dr\. Pérez Lago no atiende/);
    await user.type(within(dialog).getByLabelText("Paciente"), "Paciente Fuera");
    expect(agendar()).toBeEnabled();                                                    // sin doctor elegido no hay aviso

    // el Dr. Pérez Lago tiene horario propio: martes y jueves de 10:00 AM a 2:00 PM
    await user.selectOptions(within(dialog).getByLabelText("Doctor"), "d2");
    fireEvent.change(within(dialog).getByLabelText("Fecha"), { target: { value: "2026-11-12" } });      // jueves
    await user.selectOptions(within(dialog).getByLabelText("Hora"), "09:00");                          // antes de que empiece
    expect(aviso()).toBeInTheDocument();
    expect(agendar()).toBeDisabled();
    expect(agendar()).toHaveAttribute("title", expect.stringMatching(/no atiende en ese horario/));

    // «cita de mostrador» solo omite la antelación: no hace que atienda
    await user.click(within(dialog).getByRole("checkbox", { name: /Cita de mostrador/ }));
    expect(agendar()).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /Cita de mostrador/ }));

    // aunque se fuerce el envío (Enter en un campo), no sale nada: ni petición ni cita
    const antes = mock.db.bookings.length;
    fireEvent.submit(within(dialog).getByRole("textbox", { name: "Paciente" }).closest("form")!);
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.db.bookings).toHaveLength(antes);
    expect(within(dialog).queryByRole("alert")).toBeNull();

    // dentro de su horario: el aviso se va y el botón se habilita
    await user.selectOptions(within(dialog).getByLabelText("Hora"), "10:00");
    expect(aviso()).toBeNull();
    expect(agendar()).toBeEnabled();
    expect(agendar()).not.toHaveAttribute("title");

    // la duración cuenta: 1:30 PM + 60 min termina a las 2:30 PM, fuera de su horario
    await user.selectOptions(within(dialog).getByLabelText("Hora"), "13:30");
    expect(agendar()).toBeEnabled();                                                    // 30 min: cabe (termina 2:00 PM)
    await user.selectOptions(within(dialog).getByLabelText("Duración"), "60");
    expect(aviso()).toBeInTheDocument();
    expect(agendar()).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Duración"), "30");
    expect(agendar()).toBeEnabled();

    // otro día en que no atiende (miércoles) también bloquea; con otro doctor que sí atiende, se habilita
    fireEvent.change(within(dialog).getByLabelText("Fecha"), { target: { value: "2026-11-11" } });
    expect(agendar()).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Doctor"), "d1");
    expect(within(dialog).queryByText(/no atiende/)).toBeNull();
    expect(agendar()).toBeEnabled();
  });

  it("los otros avisos (ya pasó, menos de 60 minutos) siguen sin bloquear el botón: el servidor decide", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    await ready();
    await user.click(screen.getByRole("button", { name: "Nueva cita" }));
    const dialog = await screen.findByRole("dialog", { name: "Nueva cita" });
    await user.selectOptions(within(dialog).getByLabelText("Doctor"), "d1");
    await user.selectOptions(within(dialog).getByLabelText("Hora"), "10:30");           // hoy, faltan 30 min
    expect(within(dialog).getByText(/Faltan menos de 60 minutos/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Agendar cita" })).toBeEnabled();
  });

  it("bloquear horario crea un bloqueo de consultorio", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    await ready();
    await user.click(screen.getByRole("button", { name: "Bloquear horario" }));
    const dialog = await screen.findByRole("dialog", { name: "Bloquear horario" });
    expect(within(dialog).queryByLabelText("Paciente")).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Consultorio"), "r1");
    fireEvent.change(within(dialog).getByLabelText("Fecha"), { target: { value: "2026-11-13" } });
    await user.selectOptions(within(dialog).getByLabelText("Hora"), "13:00");
    await user.type(within(dialog).getByLabelText("Motivo"), "Limpieza profunda");
    await user.click(within(dialog).getByRole("button", { name: "Bloquear" }));
    expect(await screen.findByText("Horario bloqueado.")).toBeInTheDocument();
    expect(mock.db.bookings.find((b) => b.notes === "Limpieza profunda")).toMatchObject({ kind: "block", room: { id: "r1" }, doctor: null });
  });
});

describe("ausencias de los doctores en la rejilla", () => {
  const bands = (root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLElement>("[data-absence]"));
  const lane = (id: string) => document.querySelector<HTMLElement>(`[data-lane="${id}"]`)!;
  const ausencia = (id: string, doctorId: string, startUtc: string, endUtc: string, reason: string | null) => ({ id, doctorId, startUtc, endUtc, reason });
  /** Lo que hace la pantalla al volver a la pestaña: consultar de nuevo (el servidor no tiene WebSockets). */
  const refrescar = () => document.dispatchEvent(new Event("visibilitychange"));

  it("día por doctor: cada ausencia va SOLO en la columna de su doctor, con su motivo y su horario (hora de Cancún)", async () => {
    const { mock, violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-12" });
    violations = v;
    await ready();
    // el Dr. Torrealba (d4) todo el día con motivo; el Dr. Cervantes (d1) de 10:00 a 12:00 sin motivo
    mock.db.absences.push(
      ausencia("a-d4", "d4", "2026-11-12T05:00:00.000Z", "2026-11-13T05:00:00.000Z", "Congreso"),
      ausencia("a-d1", "d1", "2026-11-12T15:00:00.000Z", "2026-11-12T17:00:00.000Z", null)
    );
    refrescar();
    await waitFor(() => expect(bands()).toHaveLength(2));

    expect(bands(lane("d4"))).toHaveLength(1);
    expect(bands(lane("d4"))[0]).toHaveAttribute("aria-label", "Ausencia · Congreso");
    expect(bands(lane("d4"))[0]).toHaveStyle({ top: "1px", height: `${24 * 48 - 1}px` });
    expect(bands(lane("d1"))).toHaveLength(1);
    expect(bands(lane("d1"))[0]).toHaveAttribute("aria-label", "Ausencia");
    expect(bands(lane("d1"))[0]).toHaveStyle({ top: `${10 * 48 + 1}px`, height: `${2 * 48 - 1}px` });
    for (const id of ["d2", "d3", "d5", "d6", "d7"]) expect(bands(lane(id)), id).toHaveLength(0);
  });

  it("la ausencia que ya trae la agenda de ejemplo (Dr. Molina, dos días) se ve en su carril y en su día", async () => {
    const { violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-14" });
    violations = v;
    await waitFor(() => expect(bands(lane("d5"))).toHaveLength(1));
    expect(bands(lane("d5"))[0]).toHaveAttribute("aria-label", "Ausencia · Congreso médico");
    expect(bands()).toHaveLength(1);                                                                // y de nadie más
    // el día siguiente (segundo día de esa ausencia): también, y el anterior no
    window.location.hash = "#/calendario?dia=2026-11-15";
    await waitFor(() => expect(bands(lane("d5"))).toHaveLength(1));
    window.location.hash = "#/calendario?dia=2026-11-13";
    await waitFor(() => expect(lane("d5")).toBeInTheDocument());
    await waitFor(() => expect(bands()).toHaveLength(0));
  });

  it("semana: sin filtro no se pintan (mezclarian a todos los doctores); con un doctor filtrado, solo las de ese doctor", async () => {
    const { mock, violations: v } = await mountApp({ hash: "#/calendario?vista=semana&dia=2026-11-12" });
    violations = v;
    await waitFor(() => expect(document.querySelectorAll("[data-day]")).toHaveLength(7));
    mock.db.absences.push(
      ausencia("a-d4", "d4", "2026-11-11T05:00:00.000Z", "2026-11-14T05:00:00.000Z", "Vacaciones"),   // mié, jue y vie
      ausencia("a-d1", "d1", "2026-11-12T05:00:00.000Z", "2026-11-13T05:00:00.000Z", "Otra")
    );
    refrescar();
    await new Promise((r) => setTimeout(r, 80));
    expect(bands()).toHaveLength(0);                                                               // sin filtro: nada

    window.location.hash = "#/calendario?vista=semana&dia=2026-11-12&doctor=d4";
    await waitFor(() => expect(bands()).toHaveLength(3));
    expect(bands().map((b) => b.closest("[data-day]")!.getAttribute("data-day"))).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(bands().every((b) => b.getAttribute("aria-label") === "Ausencia · Vacaciones")).toBe(true);   // las de d4, no la de d1
  });

  it("por consultorio, en mes y en lista no se pintan franjas (ahi no se sabe de quién es cada columna)", async () => {
    const { user, violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-14" });
    violations = v;
    await waitFor(() => expect(bands()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Consultorio" }));
    await waitFor(() => expect(document.querySelectorAll("[data-lane]")).toHaveLength(2));
    expect(bands()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Doctor" }));
    await waitFor(() => expect(bands()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Mes" }));
    await screen.findByText("Noviembre de 2026");
    expect(bands()).toHaveLength(0);
  });

  it("una ausencia nueva (que registró el doctor desde su app) aparece al actualizar, y si se quita desaparece", async () => {
    const { mock, violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-12" });
    violations = v;
    await ready();
    expect(bands()).toHaveLength(0);
    mock.db.absences.push(ausencia("a-nueva", "d3", "2026-11-12T05:00:00.000Z", "2026-11-13T05:00:00.000Z", "Trámite"));
    refrescar();
    await waitFor(() => expect(bands(lane("d3"))).toHaveLength(1));
    mock.db.absences.splice(mock.db.absences.findIndex((a) => a.id === "a-nueva"), 1);
    refrescar();
    await waitFor(() => expect(bands()).toHaveLength(0));
  });
});

describe("«No disponible»: doctores ocupados por un evento personal (privado) en la rejilla", () => {
  const busy = (root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLElement>("[data-busy]"));
  const absences = () => Array.from(document.querySelectorAll<HTMLElement>("[data-absence]"));
  const lane = (id: string) => document.querySelector<HTMLElement>(`[data-lane="${id}"]`)!;
  const refrescar = () => document.dispatchEvent(new Event("visibilitychange"));
  /** El simulador trae, de ejemplo, a d1 el miércoles 11 (1:00–2:00 PM) y el jueves 12 (11:30 AM–1:00 PM), y a d3 el miércoles 11 (12:30–1:30 PM). */
  const TEXTOS = ["Comida con residentes", "Reservación a nombre", "Dentista", "Junta de especialidad"];
  const sinTexto = () => {
    const body = document.body.textContent ?? "";
    for (const t of TEXTOS) expect(body, t).not.toContain(t);
  };

  it("día por doctor: franja gris «No disponible» SOLO en la columna de su doctor, en su horario (hora de Cancún), sin título ni notas", async () => {
    const { violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-11" });
    violations = v;
    await waitFor(() => expect(busy()).toHaveLength(2));
    expect(busy(lane("d1"))).toHaveLength(1);
    expect(busy(lane("d1"))[0]).toHaveAttribute("aria-label", "No disponible");
    expect(busy(lane("d1"))[0]).toHaveClass("cal-busy");
    expect(busy(lane("d1"))[0]).toHaveStyle({ top: `${13 * 48 + 1}px`, height: `${48 - 1}px` });
    expect(busy(lane("d3"))).toHaveLength(1);
    expect(busy(lane("d3"))[0]).toHaveStyle({ top: `${12.5 * 48 + 1}px`, height: `${48 - 1}px` });
    for (const id of ["d2", "d4", "d5", "d6", "d7"]) expect(busy(lane(id)), id).toHaveLength(0);
    expect(absences()).toHaveLength(0);                                   // no se confunde con una ausencia
    sinTexto();                                                            // y el detalle privado no llega a la pantalla
  });

  it("convive con una ausencia del mismo doctor: cada una con su estilo", async () => {
    const { mock, violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-11" });
    violations = v;
    await waitFor(() => expect(busy()).toHaveLength(2));
    mock.db.absences.push({ id: "a-d1", doctorId: "d1", startUtc: "2026-11-11T15:00:00.000Z", endUtc: "2026-11-11T17:00:00.000Z", reason: "Trámite" });
    refrescar();
    await waitFor(() => expect(absences()).toHaveLength(1));
    expect(absences()[0]).toHaveAttribute("aria-label", "Ausencia · Trámite");
    expect(busy(lane("d1"))).toHaveLength(1);
    expect(busy()).toHaveLength(2);
  });

  it("semana: sin filtro no se pintan; con un doctor filtrado, una franja por cada día con un evento de ese doctor", async () => {
    const { violations: v } = await mountApp({ hash: "#/calendario?vista=semana&dia=2026-11-12" });
    violations = v;
    await waitFor(() => expect(document.querySelectorAll("[data-day]")).toHaveLength(7));
    await new Promise((r) => setTimeout(r, 80));
    expect(busy()).toHaveLength(0);                                       // sin filtro: mezclarian a todos los doctores

    window.location.hash = "#/calendario?vista=semana&dia=2026-11-12&doctor=d1";
    await waitFor(() => expect(busy()).toHaveLength(2));
    expect(busy().map((b) => b.closest("[data-day]")!.getAttribute("data-day"))).toEqual(["2026-11-11", "2026-11-12"]);
    sinTexto();
  });

  it("por consultorio, en mes y en lista no se pintan", async () => {
    const { user, violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-11" });
    violations = v;
    await waitFor(() => expect(busy()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Consultorio" }));
    await waitFor(() => expect(document.querySelectorAll("[data-lane]")).toHaveLength(2));
    expect(busy()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Doctor" }));
    await waitFor(() => expect(busy()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Mes" }));
    await screen.findByText("Noviembre de 2026");
    expect(busy()).toHaveLength(0);
    sinTexto();
  });

  it("un evento nuevo del doctor aparece al actualizar, y si lo borra desaparece (sin que el personal vea jamás de qué se trata)", async () => {
    const { mock, violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-13" });
    violations = v;
    await ready();
    expect(busy()).toHaveLength(0);
    mock.db.personalEvents.push({ id: "pe-nuevo", doctorId: "d4", title: "Cirugía de la Sra. Quintana", notes: "hipertensión", startUtc: "2026-11-13T15:00:00.000Z", endUtc: "2026-11-13T16:00:00.000Z" });
    refrescar();
    await waitFor(() => expect(busy(lane("d4"))).toHaveLength(1));
    expect(busy(lane("d4"))[0]).toHaveStyle({ top: `${10 * 48 + 1}px`, height: `${48 - 1}px` });
    expect(document.body.textContent).not.toMatch(/Quintana|Cirug|hipertensi/);
    mock.db.personalEvents.splice(mock.db.personalEvents.findIndex((e) => e.id === "pe-nuevo"), 1);
    refrescar();
    await waitFor(() => expect(busy()).toHaveLength(0));
  });
});

describe("detalle de una cita", () => {
  const DAY = "2026-11-12";
  const openBooking = async (mount: Awaited<ReturnType<typeof mountApp>>, b = pickBooking(mount.mock, DAY, { doctorId: "d1" })) => {
    await mount.user.click(await bookingButton(b));
    return { b, dialog: await screen.findByRole("dialog", { name: b.patient!.name }) };
  };

  it("muestra paciente, doctor, consultorio, telefono y origen", async () => {
    const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
    violations = m.violations;
    const { b, dialog } = await openBooking(m);
    expect(dialog).toHaveTextContent("Dr. Cervantes Peláez");
    expect(dialog).toHaveTextContent("Proctología");
    expect(dialog).toHaveTextContent(b.room!.name);
    expect(dialog).toHaveTextContent(/\+52 998 000/);
    expect(dialog).toHaveTextContent("Agendada");
    expect(dialog).toHaveTextContent(b.source === "ai" ? "Agendó el bot de WhatsApp" : "Personal de la clínica");
  });

  it("las opciones de marcar la cita como realizada o no asistio estan apagadas por defecto (features.attendanceStatus); lo demas sigue", async () => {
    const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
    violations = m.violations;
    const { b, dialog } = await openBooking(m);
    expect(within(dialog).getByRole("button", { name: "Mover a otro horario" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancelar la cita" })).toBeInTheDocument();
    for (const name of [/Marcar como realizada/, /No asistió/, /Corregir/]) expect(within(dialog).queryByRole("button", { name })).not.toBeInTheDocument();
    expect(m.mock.db.bookings.find((x) => x.id === b.id)!.status).toBe("agendada");           // nada cambio
  });

  it("una cita que YA esta realizada o no asistio sigue mostrando su estado, pero no se ofrece cambiarlo (features.attendanceStatus apagado)", async () => {
    const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
    violations = m.violations;
    const hecha = pickBooking(m.mock, DAY, { doctorId: "d1" });
    m.mock.db.bookings.find((x) => x.id === hecha.id)!.status = "realizada";
    const { dialog } = await openBooking(m, { ...hecha, status: "realizada" });
    expect(dialog).toHaveTextContent("Realizada");
    expect(within(dialog).queryByRole("button", { name: /Corregir/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "Corregir estado" })).not.toBeInTheDocument();
  });

  it("encendiendo features.attendanceStatus vuelve a marcar la cita como realizada y como no asistio, y permite corregir", async () => {
    features.attendanceStatus = true;
    const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
    violations = m.violations;
    const { b, dialog } = await openBooking(m);
    const status = () => m.mock.db.bookings.find((x) => x.id === b.id)!.status;

    await m.user.click(within(dialog).getByRole("button", { name: "Marcar como realizada" }));
    expect(await screen.findByText("Cita marcada como realizada.")).toBeInTheDocument();
    expect(status()).toBe("realizada");

    await m.user.click(await within(screen.getByRole("dialog")).findByRole("button", { name: "Corregir: no asistió" }));
    await waitFor(() => expect(status()).toBe("no_show"));
    await m.user.click(await within(screen.getByRole("dialog")).findByRole("button", { name: "Corregir: sí asistió" }));
    await waitFor(() => expect(status()).toBe("realizada"));
  });

  it("cancelar pide confirmacion, libera el hueco y la cita deja de verse (salvo 'Mostrar canceladas')", async () => {
    const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
    violations = m.violations;
    const { b, dialog } = await openBooking(m);
    const name = b.patient!.name;
    const status = () => m.mock.db.bookings.find((x) => x.id === b.id)!.status;

    await m.user.click(within(dialog).getByRole("button", { name: "Cancelar la cita" }));
    expect(within(dialog).getByText(`¿Cancelar la cita de ${name}?`)).toBeInTheDocument();
    expect(status()).toBe("agendada"); // aun no
    await m.user.click(within(dialog).getByRole("button", { name: "No, volver" }));
    expect(status()).toBe("agendada");

    await m.user.click(within(dialog).getByRole("button", { name: "Cancelar la cita" }));
    await m.user.click(within(dialog).getByRole("button", { name: "Sí, cancelar la cita" }));
    expect(await screen.findByText("Cita cancelada.")).toBeInTheDocument();
    expect(status()).toBe("cancelada");
    expect(within(screen.getByRole("dialog")).getByText("Esta cita está cancelada y ya no ocupa el horario.")).toBeInTheDocument();
    await m.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("button", { name: new RegExp(`^${name},`) })).not.toBeInTheDocument());

    await m.user.click(screen.getByRole("checkbox", { name: "Mostrar canceladas" }));
    expect(await bookingButton(b)).toBeInTheDocument();
    // y el hueco quedo libre: se puede volver a agendar al doctor a esa hora
    const again = await m.api.appointments.create({ patientName: "Paciente Nuevo", doctorId: "d1", scheduledAtUtc: b.scheduledAtUtc });
    expect(again.status).toBe("agendada");
  });

  it("mover: a un hueco ocupado falla y la cita sigue donde estaba; a uno libre, se mueve", async () => {
    const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
    violations = m.violations;
    const booking = pickBooking(m.mock, DAY, { doctorId: "d1", nth: 0 }); // 09:00
    const busy = pickBooking(m.mock, DAY, { doctorId: "d1", nth: 1 }); // 16:00: otra cita del MISMO doctor
    const { dialog } = await openBooking(m, booking);
    const original = booking.scheduledAtUtc;
    expect(busy.scheduledAtUtc).toBe("2026-11-12T21:00:00.000Z");

    await m.user.click(within(dialog).getByRole("button", { name: "Mover a otro horario" }));
    const form = within(dialog).getByRole("form", { name: "Mover" });
    await m.user.selectOptions(within(form).getByLabelText("Nueva hora"), "16:00");
    await m.user.click(within(form).getByRole("button", { name: "Mover" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("La cita sigue en su horario original.");
    expect(m.mock.db.bookings.find((b) => b.id === booking.id)!.scheduledAtUtc).toBe(original);

    await m.user.selectOptions(within(form).getByLabelText("Nueva hora"), "13:30");
    await m.user.click(within(form).getByRole("button", { name: "Mover" }));
    expect(await screen.findByText("Cita movida.")).toBeInTheDocument();
    expect(m.mock.db.bookings.find((b) => b.id === booking.id)!.scheduledAtUtc).toBe("2026-11-12T18:30:00.000Z");
  });

  describe("mover: calendario emergente con los horarios libres", () => {
    const openMove = async (m: Awaited<ReturnType<typeof mountApp>>, b = pickBooking(m.mock, DAY, { doctorId: "d1", nth: 0 })) => {
      const { dialog } = await openBooking(m, b);
      await m.user.click(within(dialog).getByRole("button", { name: "Mover a otro horario" }));
      return { b, dialog, form: within(within(dialog).getByRole("form", { name: "Mover" })) };
    };
    const openPicker = async (m: Awaited<ReturnType<typeof mountApp>>, form: ReturnType<typeof within>) => {
      await m.user.click(form.getByRole("button", { name: /Elegir en el calendario/ }));
      return within(await screen.findByRole("dialog", { name: "Elegir fecha y hora" }));
    };
    const dayButton = (picker: ReturnType<typeof within>, label: RegExp) => picker.findByRole("button", { name: label });

    it("muestra el mes con los días que tienen horarios libres; el 16:00 ocupado del mismo doctor no sale; al elegir uno llena fecha y hora y la cita se mueve", async () => {
      const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
      violations = m.violations;
      const { b, form } = await openMove(m);
      const picker = await openPicker(m, form);
      expect(picker.getByRole("heading", { name: "Elegir fecha y hora" })).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Elegir fecha y hora" })).toHaveTextContent("Dr. Cervantes Peláez · Cualquier consultorio libre · dura 30 min");
      expect(picker.getByText("Noviembre de 2026")).toBeInTheDocument();

      // viene elegido el día de la cita (jueves 12), con SU horario marcado; el 16:00 (otra cita del mismo doctor) no se ofrece; el domingo no tiene horarios
      const times = await picker.findByRole("region", { name: "Horarios libres" });
      expect(within(times).getByText(/Horarios libres · jueves, 12 de noviembre/)).toBeInTheDocument();
      expect(within(times).getByRole("button", { name: /9:00\sAM/ })).toHaveTextContent("Horario actual");
      expect(within(times).queryByRole("button", { name: /^4:00\sPM/ })).toBeNull();
      expect(within(times).getByRole("button", { name: /^4:30\sPM/ })).toBeInTheDocument();
      expect(await dayButton(picker, /domingo, 15 de noviembre, sin horarios libres/)).toBeDisabled();
      expect(await dayButton(picker, /^jueves, 12 de noviembre/)).toHaveAttribute("aria-pressed", "true");

      // otro día y otra hora: se cierra y el formulario queda llenado
      await m.user.click(await dayButton(picker, /^viernes, 13 de noviembre/));
      const friday = await picker.findByRole("region", { name: "Horarios libres" });
      expect(within(friday).getByText(/Horarios libres · viernes, 13 de noviembre/)).toBeInTheDocument();
      expect(within(friday).queryByText("Horario actual")).toBeNull(); // el horario actual es de otro día
      await m.user.click(within(friday).getByRole("button", { name: /10:30\sAM/ }));
      expect(screen.queryByRole("dialog", { name: "Elegir fecha y hora" })).toBeNull();
      expect(form.getByLabelText("Nueva fecha")).toHaveValue("2026-11-13");
      expect(form.getByLabelText("Nueva hora")).toHaveValue("10:30");
      await m.user.click(form.getByRole("button", { name: "Mover" }));
      expect(await screen.findByText("Cita movida.")).toBeInTheDocument();
      expect(m.mock.db.bookings.find((x) => x.id === b.id)!.scheduledAtUtc).toBe("2026-11-13T15:30:00.000Z");
    });

    it("cambia de mes sin pasar de hoy ni de los 60 días; Esc cierra solo el calendario y el detalle de la cita sigue abierto", async () => {
      const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
      violations = m.violations;
      const { dialog, form } = await openMove(m);
      const picker = await openPicker(m, form);
      expect(picker.getByRole("button", { name: "Mes anterior" })).toBeDisabled(); // no hay nada antes de hoy
      await m.user.click(picker.getByRole("button", { name: "Mes siguiente" }));
      expect(picker.getByText("Diciembre de 2026")).toBeInTheDocument();
      expect(await dayButton(picker, /^miércoles, 2 de diciembre/)).toBeEnabled();
      await m.user.click(picker.getByRole("button", { name: "Mes siguiente" }));
      expect(picker.getByText("Enero de 2027")).toBeInTheDocument();
      expect(await dayButton(picker, /^viernes, 8 de enero, \d+ horarios libres/)).toBeEnabled();
      expect(await dayButton(picker, /^lunes, 11 de enero, sin horarios libres/)).toBeDisabled(); // más allá de los 60 días
      expect(picker.getByRole("button", { name: "Mes siguiente" })).toBeDisabled();
      await m.user.click(picker.getByRole("button", { name: "Mes anterior" }));
      expect(picker.getByText("Diciembre de 2026")).toBeInTheDocument();

      await m.user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Elegir fecha y hora" })).toBeNull();
      expect(dialog).toBeInTheDocument();
      expect(within(dialog).getByRole("form", { name: "Mover" })).toBeInTheDocument(); // el formulario sigue ahí
    });

    it("el consultorio elegido y «Cita de mostrador» cambian lo que se ofrece: con mostrador hoy hay horarios desde antes de la antelación de 60 min", async () => {
      const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
      violations = m.violations;
      const { form } = await openMove(m);
      await m.user.selectOptions(form.getByLabelText("Consultorio"), "r2");
      let picker = await openPicker(m, form);
      expect(screen.getByRole("dialog", { name: "Elegir fecha y hora" })).toHaveTextContent("Dr. Cervantes Peláez · Consultorio 2 · dura 30 min");
      const countToday = async (p: ReturnType<typeof within>) => Number(/(\d+) horarios libres/.exec((await dayButton(p, /^martes, 10 de noviembre/)).getAttribute("aria-label")!)![1]);
      const without = await countToday(picker);
      await m.user.keyboard("{Escape}");
      await m.user.click(form.getByRole("checkbox", { name: /Cita de mostrador/ }));
      picker = await openPicker(m, form);
      expect(await countToday(picker)).toBeGreaterThan(without); // hoy ya cuentan los horarios de menos de 60 minutos
    });

    it("un bloqueo de consultorio: ofrece los horarios en que su consultorio está libre, de 7:00 a 19:30", async () => {
      const m = await mountApp({ hash: "#/calendario?dia=2026-11-12" });
      violations = m.violations;
      const bloqueo = m.mock.db.bookings.find((b) => b.kind === "block" && localDay(b.scheduledAtUtc) === "2026-11-12")!;
      await m.user.click(await screen.findByTitle(bloqueo.room!.name));
      const dialog = await screen.findByRole("dialog");
      await m.user.click(within(dialog).getByRole("button", { name: "Mover el bloqueo" }));
      const form = within(within(dialog).getByRole("form", { name: "Mover" }));
      const picker = await openPicker(m, form);
      expect(screen.getByRole("dialog", { name: "Elegir fecha y hora" })).toHaveTextContent(`${bloqueo.room!.name} · dura ${bloqueo.durationMinutes} min`);
      const times = await picker.findByRole("region", { name: "Horarios libres" });
      expect(within(times).getByRole("button", { name: /^7:00\sAM/ })).toBeInTheDocument();
      expect(within(times).getByRole("button", { name: /^7:30\sPM/ })).toBeInTheDocument();
      expect(within(times).getByRole("button", { name: /^2:00\sPM/ })).toHaveTextContent("Horario actual");
      // el bloqueo no sigue las reglas de pacientes: el domingo SÍ se puede (su consultorio está libre)
      expect(await dayButton(picker, /^domingo, 15 de noviembre, \d+ horarios libres/)).toBeEnabled();
    });

    it("con el teclado: flechas entre los días con horarios (saltan los vacíos), RePág/AvPág cambian de mes", async () => {
      const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
      violations = m.violations;
      const { form } = await openMove(m);
      const picker = await openPicker(m, form);
      const thursday = await dayButton(picker, /^jueves, 12 de noviembre/);
      thursday.focus();
      await m.user.keyboard("{ArrowRight}");
      expect(document.activeElement).toBe(await dayButton(picker, /^viernes, 13 de noviembre/));
      await m.user.keyboard("{ArrowRight}");
      expect(document.activeElement).toBe(await dayButton(picker, /^sábado, 14 de noviembre/));
      await m.user.keyboard("{ArrowRight}"); // el domingo no tiene horarios: salta al lunes
      expect(document.activeElement).toBe(await dayButton(picker, /^lunes, 16 de noviembre/));
      await m.user.keyboard("{ArrowUp}"); // una semana atrás sería el lunes 9, que ya pasó: no se puede, y el foco se queda donde estaba
      expect(document.activeElement).toBe(await dayButton(picker, /^lunes, 16 de noviembre/));
      await m.user.keyboard("{PageDown}");
      expect(picker.getByText("Diciembre de 2026")).toBeInTheDocument();
      await m.user.keyboard("{PageUp}");
      expect(picker.getByText("Noviembre de 2026")).toBeInTheDocument();
    });

    it("sin conexión avisa y «Reintentar» vuelve a buscar los horarios", async () => {
      const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
      violations = m.violations;
      const { form } = await openMove(m);
      m.mock.controls.setOffline(true);
      const picker = await openPicker(m, form);
      expect(await picker.findByText(/No se pudieron cargar los horarios libres/)).toBeInTheDocument();
      expect(picker.queryByRole("region", { name: "Horarios libres" })).toBeNull();
      m.mock.controls.setOffline(false);
      await m.user.click(picker.getByRole("button", { name: "Reintentar" }));
      expect(await picker.findByRole("region", { name: "Horarios libres" })).toBeInTheDocument();
      expect(picker.queryByText(/No se pudieron cargar/)).toBeNull();
    });
  });

  it("edita las notas", async () => {
    const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
    violations = m.violations;
    const { b, dialog } = await openBooking(m);
    await m.user.type(within(dialog).getByLabelText("Notas"), "Trae estudios previos");
    await m.user.click(within(dialog).getByRole("button", { name: "Guardar notas" }));
    expect(await screen.findByText("Notas guardadas.")).toBeInTheDocument();
    expect(m.mock.db.bookings.find((x) => x.id === b.id)!.notes).toBe("Trae estudios previos");
  });

  it("un bloqueo se quita desde su detalle", async () => {
    const m = await mountApp({ hash: `#/calendario?dia=${DAY}` });
    violations = m.violations;
    await m.user.click(await screen.findByRole("button", { name: /Mantenimiento/ }));
    const dialog = await screen.findByRole("dialog", { name: "Mantenimiento" });
    expect(within(dialog).queryByRole("button", { name: "Marcar como realizada" })).not.toBeInTheDocument();
    await m.user.click(within(dialog).getByRole("button", { name: "Quitar el bloqueo" }));
    await m.user.click(within(dialog).getByRole("button", { name: "Sí, quitar" }));
    expect(await screen.findByText("Bloqueo quitado.")).toBeInTheDocument();
    expect(m.mock.db.bookings.find((b) => b.notes === "Mantenimiento")!.status).toBe("cancelada");
  });
});

describe("refresco automatico", () => {
  it("una cita nueva del bot aparece sola y sin conexion se avisa, sin perder lo que ya se veia", async () => {
    const { mock, violations: v } = await mountApp();
    violations = v;
    await ready();

    const made = mock.simulateBotBooking({ doctorId: "d4", patientName: "Paciente Del Bot" })!;
    expect(made.source).toBe("ai");
    expect(localDay(made.scheduledAtUtc)).toBe("2026-11-10"); // hoy quedan huecos libres
    // Volver a la pestana dispara un refresco (se junta con los demas en una sola consulta).
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByRole("button", { name: /Paciente Del Bot/ })).toBeInTheDocument();

    mock.controls.setOffline(true);
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText(/Sin conexión: se muestra lo último que llegó/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Paciente Del Bot/ })).toBeInTheDocument();

    mock.controls.setOffline(false);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(screen.queryByText(/Sin conexión/)).not.toBeInTheDocument());
  });
});

describe("boton del bot", () => {
  it("muestra el estado, pide confirmacion para apagarlo y se vuelve a encender de una", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    const toggle = await screen.findByRole("switch", { name: "Bot de WhatsApp" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(toggle).toHaveTextContent("Bot activo");

    await user.click(toggle);
    const confirm = await screen.findByRole("dialog", { name: "¿Apagar el bot?" });
    expect(mock.db.bot.active).toBe(true); // todavia no
    await user.click(within(confirm).getByRole("button", { name: "Cancelar" }));
    expect(mock.db.bot.active).toBe(true);

    await user.click(toggle);
    await user.click(within(await screen.findByRole("dialog", { name: "¿Apagar el bot?" })).getByRole("button", { name: "Sí, apagar el bot" }));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(toggle).toHaveTextContent("Bot apagado");
    expect(mock.db.bot).toMatchObject({ active: false, updatedBy: "Recepción Clínica" });
    expect(toggle).toHaveAttribute("title", expect.stringContaining("Recepción Clínica"));

    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(mock.db.bot.active).toBe(true);
  });

  it("si otra persona lo apaga, aqui se ve (consulta periodica)", async () => {
    const { mock, violations: v } = await mountApp();
    violations = v;
    const toggle = await screen.findByRole("switch", { name: "Bot de WhatsApp" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    mock.db.bot = { active: false, updatedAt: NOW.toISOString(), updatedBy: "Otra Persona" };
    // La pestana vuelve a estar visible: se consulta de inmediato.
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });
});

describe("doctores", () => {
  it("el personal aprueba una solicitud de cambio de horario y el doctor cambia de horario", async () => {
    const { user, mock, violations: v } = await mountApp({ hash: "#/doctores" });
    violations = v;
    const section = (await screen.findByRole("heading", { name: /Solicitudes de cambio de horario \(1\)/ })).closest("section")!;
    expect(section).toHaveTextContent("Dra. Bordas Rodríguez");
    expect(section).toHaveTextContent("Lun, Mié, Vie 10:00 AM–4:00 PM");
    await user.click(within(section).getByRole("button", { name: "Aprobar" }));
    expect(await screen.findByText(/Solicitud aprobada/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Solicitudes de cambio/ })).not.toBeInTheDocument());
    expect(mock.db.doctors.find((d) => d.id === "d3")!.ownHours).toEqual({
      mon: [{ start: "10:00", end: "16:00" }], wed: [{ start: "10:00", end: "16:00" }], fri: [{ start: "10:00", end: "16:00" }],
    });
    const card = screen.getByRole("button", { name: "Horario y ausencias de Dra. Bordas Rodríguez" }).closest("li")!;
    await waitFor(() => expect(card).toHaveTextContent("Horario propio: Lun, Mié, Vie 10:00 AM–4:00 PM"));
  });

  it("al aprobar una solicitud avisa de las citas agendadas que quedaron fuera del nuevo horario", async () => {
    const { user, mock, violations: v } = await mountApp({ hash: "#/doctores" });
    violations = v;
    // un horario tan corto que casi todas las citas futuras de esa doctora quedan fuera (el servidor no las cancela)
    const pending = mock.db.requests.find((r) => r.status === "pending")!;
    pending.weeklyHours = { mon: [{ start: "09:00", end: "09:30" }] };
    const section = (await screen.findByRole("heading", { name: /Solicitudes de cambio de horario \(1\)/ })).closest("section")!;
    await user.click(within(section).getByRole("button", { name: "Aprobar" }));
    expect(await screen.findByText(/quedan afectadas|queda afectada/)).toBeInTheDocument();
    expect(screen.getByText(/No se cancelaron: avisa a los pacientes/)).toBeInTheDocument();
    expect(await screen.findByText(/fuera del nuevo horario: avisa a los pacientes/)).toBeInTheDocument();    // y el aviso de la pantalla
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Solicitudes de cambio/ })).not.toBeInTheDocument());
    expect(screen.getByText(/quedan afectadas|queda afectada/)).toBeInTheDocument();                       // el aviso sigue aunque la solicitud ya no
  });

  it("recepcion (personal) cambia el horario de la clinica: lo guarda y se ve; un horario que deja a un doctor fuera se rechaza", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "staff", hash: "#/doctores" });
    violations = v;
    const card = await screen.findByRole("region", { name: "Horario de la clínica" });
    expect(card).toHaveTextContent("Lun–Vie 9:00 AM–6:00 PM · Sáb 9:00 AM–1:00 PM");
    await user.click(within(card).getByRole("button", { name: "Cambiar" }));

    await user.selectOptions(within(card).getByLabelText("Lunes: hasta"), "17:00");
    await user.click(within(card).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Horario de la clínica guardado.")).toBeInTheDocument();
    expect(mock.db.clinicHours.mon).toEqual([{ start: "09:00", end: "17:00" }]);
    await waitFor(() => expect(screen.getByRole("region", { name: "Horario de la clínica" })).toHaveTextContent("Lun 9:00 AM–5:00 PM"));

    // el servidor manda: Dra. Perez (horario propio los martes 10-14) no puede quedar fuera del de la clinica
    const again = screen.getByRole("region", { name: "Horario de la clínica" });
    await user.click(within(again).getByRole("button", { name: "Cambiar" }));
    await user.selectOptions(within(again).getByLabelText("Martes: hasta"), "12:00");
    await user.click(within(again).getByRole("button", { name: "Guardar" }));
    expect(await within(again).findByText(/quedaría fuera del de la clínica/)).toBeInTheDocument();
    expect(mock.db.clinicHours.tue).toEqual([{ start: "09:00", end: "18:00" }]);                  // sin cambios
  });

  it("horario propio de un doctor: valida contra el de la clinica y avisa de las citas que quedan fuera", async () => {
    const { user, mock, violations: v } = await mountApp({ hash: "#/doctores" });
    violations = v;
    await user.click(await screen.findByRole("button", { name: "Horario y ausencias de Dr. Cervantes Peláez" }));
    const dialog = await screen.findByRole("dialog", { name: "Dr. Cervantes Peláez" });

    await user.click(within(dialog).getByRole("radio", { name: /Un horario propio/ }));
    // Sabado 09:00-13:00 de la clinica: pedir hasta las 15:00 queda fuera.
    await user.selectOptions(within(dialog).getByLabelText("Sábado: hasta"), "15:00");
    expect(await within(dialog).findByText(/Fuera del horario de la clínica \(9:00 AM–1:00 PM\)/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Guardar horario" })).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Sábado: hasta"), "12:00");

    // Cervantes tiene citas a las 16:00 (datos de ejemplo): quitarle la tarde las deja fuera.
    for (const d of ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"]) await user.selectOptions(within(dialog).getByLabelText(`${d}: hasta`), "13:00");
    await user.click(within(dialog).getByRole("button", { name: "Guardar horario" }));
    expect(await screen.findByText(/Horario de Dr\. Cervantes Peláez guardado/)).toBeInTheDocument();
    const notice = await within(dialog).findByText(/quedan afectadas|queda afectada/);
    expect(notice).toHaveTextContent("No se cancelaron");
    expect(mock.db.doctors.find((d) => d.id === "d1")!.ownHours!.sat).toEqual([{ start: "09:00", end: "12:00" }]);
    expect(mock.db.bookings.filter((b) => b.doctor?.id === "d1" && b.status === "agendada").length).toBeGreaterThan(0); // nada se cancelo
  });

  it("registra una ausencia: avisa de las citas afectadas y el doctor deja de ofrecerse", async () => {
    const { user, mock, violations: v } = await mountApp({ hash: "#/doctores" });
    violations = v;
    await user.click(await screen.findByRole("button", { name: "Horario y ausencias de Dr. Gustavo Torrealba" }));
    const dialog = await screen.findByRole("dialog", { name: "Dr. Gustavo Torrealba" });
    await user.click(within(dialog).getByRole("tab", { name: "Ausencias" }));
    expect(await within(dialog).findByText(/No hay ausencias registradas próximas/)).toBeInTheDocument();

    const form = within(dialog).getByRole("form", { name: "Registrar ausencia" });
    fireEvent.change(within(form).getByLabelText("Desde"), { target: { value: "2026-11-11" } });
    fireEvent.change(within(form).getByLabelText("Hasta (inclusive)"), { target: { value: "2026-11-12" } });
    await user.type(within(form).getByLabelText("Motivo (opcional)"), "Congreso");
    await user.click(within(form).getByRole("button", { name: "Registrar ausencia" }));

    expect(await screen.findByText(/deja de ofrecerse en esas fechas/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/quedan afectadas|queda afectada/)).toBeInTheDocument();
    expect(mock.db.absences.some((a) => a.doctorId === "d4" && a.reason === "Congreso")).toBe(true);
    expect(await within(dialog).findByText(/mié 11 nov al jue 12 nov \(todo el día\)/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /Quitar la ausencia/ }));
    await waitFor(() => expect(mock.db.absences.some((a) => a.doctorId === "d4")).toBe(false));
  });

  it("cada card de doctor lleva una franja con el color que lo identifica en el calendario (el automático por su número)", async () => {
    const { violations: v } = await mountApp({ hash: "#/doctores" });
    violations = v;
    await screen.findByRole("heading", { name: "Doctores" });
    const cards = Array.from(document.querySelectorAll<HTMLElement>("ul[aria-label='Doctores'] > li"));
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      const id = ({ "Dr. Cervantes Peláez": "d1", "Dr. Pérez Lago": "d2", "Dra. Bordas Rodríguez": "d3", "Dr. Gustavo Torrealba": "d4", "Dr. Molina López": "d5", "Dra. Geydi": "d6", "Dra. Ana del Carmen Argüelles": "d7" } as Record<string, string>)[card.querySelector("p")!.textContent!];
      expect(id, card.textContent ?? "").toBeDefined();
      expect(card).toHaveAttribute("data-doctor-color", doctorColor(id)!);
      expect(card).toHaveStyle({ borderLeftColor: doctorColor(id)!, borderLeftWidth: "6px" });
    }
    // son siete colores distintos: de un vistazo se distingue un doctor de otro
    expect(new Set(cards.map((c) => c.getAttribute("data-doctor-color"))).size).toBe(7);
  });

  it("se elige el color de un doctor (paleta, otro color, automático); se ve de inmediato en el calendario y se avisa si es muy claro o ya lo usa otro", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "staff", hash: "#/doctores" });
    violations = v;
    const colorOfD1 = () => mock.db.doctors.find((d) => d.id === "d1")!.color ?? null;
    await user.click(await screen.findByRole("button", { name: "Horario y ausencias de Dr. Cervantes Peláez" }));
    const dialog = await screen.findByRole("dialog", { name: "Dr. Cervantes Peláez" });
    await user.click(within(dialog).getByRole("tab", { name: "Datos" }));
    const form = within(dialog).getByRole("form", { name: "Datos del doctor" });
    const group = within(form).getByRole("radiogroup", { name: "Color en el calendario" });
    const save = () => user.click(within(form).getByRole("button", { name: "Guardar datos" }));

    // sin color elegido: «Automático» está marcado y la vista previa lleva el color automático de ese doctor
    expect(within(group).getByRole("radio", { name: "Automático" })).toBeChecked();
    expect(within(form).getByTestId("color-preview")).toHaveStyle({ backgroundColor: doctorColor("d1")! });
    expect(within(group).getAllByRole("radio")).toHaveLength(11);                      // automático + los 10 de la paleta

    // la paleta: «rojo» no lo usa ningún doctor (los 7 primeros colores ya son de los 7 doctores); «naranja» es el automático del Dr. Pérez (d2): solo se avisa
    await user.click(within(group).getByRole("radio", { name: "naranja" }));
    expect(within(group).getByRole("radio", { name: "naranja" })).toBeChecked();
    expect(within(form).getByTestId("color-preview")).toHaveStyle({ backgroundColor: "#c2410c" });
    expect(within(form).getByText(/Ese color ya lo usa Dr\. Pérez Lago/)).toBeInTheDocument();
    await user.click(within(group).getByRole("radio", { name: "rojo" }));
    expect(within(form).queryByText(/ya lo usa/)).not.toBeInTheDocument();
    await save();
    await waitFor(() => expect(colorOfD1()).toBe("#b91c1c"));

    // «Otro color»: uno legible se acepta (y ningún círculo de la paleta queda marcado); uno muy claro se rechaza y no cambia nada
    const other = within(group).getByLabelText("Otro color");
    fireEvent.change(other, { target: { value: "#ffff00" } });
    expect(await within(form).findByText(/Ese color es muy claro/)).toBeInTheDocument();
    expect(within(form).getByTestId("color-preview")).toHaveStyle({ backgroundColor: "#b91c1c" });      // seguía el anterior
    fireEvent.change(other, { target: { value: "#047857" } });
    expect(within(form).queryByText(/Ese color es muy claro/)).not.toBeInTheDocument();
    expect(within(form).getByTestId("color-preview")).toHaveStyle({ backgroundColor: "#047857" });
    expect(within(group).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(0);
    await save();
    await waitFor(() => expect(colorOfD1()).toBe("#047857"));
    // la franja de su card en la lista de doctores también cambia al guardar
    const cardD1 = () => Array.from(document.querySelectorAll<HTMLElement>("ul[aria-label='Doctores'] > li")).find((li) => li.textContent?.includes("Dr. Cervantes Peláez"))!;
    await waitFor(() => expect(cardD1()).toHaveAttribute("data-doctor-color", "#047857"));
    expect(cardD1()).toHaveStyle({ borderLeftColor: "#047857" });
    // y la cita ya agendada de ese doctor lleva el color nuevo (el servidor la copia)
    expect(mock.db.bookings.filter((b) => b.doctor?.id === "d1").every((b) => b.doctor?.color === "#047857")).toBe(true);

    // en el calendario el doctor se ve con ese color: la columna del día, la cita agendada y la leyenda en la semana
    await user.click(within(dialog).getByRole("button", { name: /Cerrar|Close/i }));
    await user.click(screen.getByRole("link", { name: "Calendario" }));
    window.location.hash = "#/calendario?dia=2026-11-11";
    await ready();
    expect(document.querySelector('[data-lane-head="d1"]')).toHaveStyle({ borderTopColor: "#047857" });
    const c1 = pickBooking(mock, "2026-11-11", { doctorId: "d1" });
    expect(await bookingButton(c1)).toHaveStyle({ backgroundColor: "#047857" });
    expect(document.querySelector('[data-lane-head="d2"]')).toHaveStyle({ borderTopColor: doctorColor("d2")! });   // los demás, igual
  });

  it("«Automático» devuelve el color de la paleta y un doctor nuevo puede nacer con color", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "admin", hash: "#/doctores" });
    violations = v;
    // alta con color elegido
    await user.click(await screen.findByRole("button", { name: "Nuevo doctor" }));
    const alta = await screen.findByRole("dialog", { name: "Nuevo doctor" });
    await user.type(within(alta).getByLabelText("Nombre"), "Dra. Con Color");
    await user.type(within(alta).getByLabelText("Especialidad"), "Pediatría");
    await user.click(within(alta).getByRole("radio", { name: "morado" }));
    await user.click(within(alta).getByRole("button", { name: "Dar de alta" }));
    await waitFor(() => expect(mock.db.doctors.find((d) => d.name === "Dra. Con Color")?.color).toBe("#7e22ce"));

    // se abre su ficha: el color elegido está marcado; «Automático» lo quita
    const dialog = await screen.findByRole("dialog", { name: "Dra. Con Color" });
    await user.click(within(dialog).getByRole("tab", { name: "Datos" }));
    const form = within(dialog).getByRole("form", { name: "Datos del doctor" });
    expect(within(form).getByRole("radio", { name: "morado" })).toBeChecked();
    await user.click(within(form).getByRole("radio", { name: "Automático" }));
    await user.click(within(form).getByRole("button", { name: "Guardar datos" }));
    await waitFor(() => expect(mock.db.doctors.find((d) => d.name === "Dra. Con Color")?.color).toBeNull());
  });

  it("recepcion (personal) da de alta un doctor, edita sus datos y lo da de baja", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "staff", hash: "#/doctores" });
    violations = v;
    await user.click(await screen.findByRole("button", { name: "Nuevo doctor" }));
    const alta = await screen.findByRole("dialog", { name: "Nuevo doctor" });
    await user.type(within(alta).getByLabelText("Nombre"), "Dra. Alta Recepción");
    await user.type(within(alta).getByLabelText("Especialidad"), "Pediatría");
    await user.type(within(alta).getByLabelText("Sinónimos"), "pediatra");
    await user.click(within(alta).getByRole("button", { name: "Dar de alta" }));
    await waitFor(() => expect(mock.db.doctors.some((d) => d.name === "Dra. Alta Recepción")).toBe(true));

    // sus datos se editan desde «Horario y ausencias» -> pestaña «Datos»
    await user.click(await screen.findByRole("button", { name: "Horario y ausencias de Dra. Alta Recepción" }));
    const dialog = await screen.findByRole("dialog", { name: "Dra. Alta Recepción" });
    await user.click(within(dialog).getByRole("tab", { name: "Datos" }));
    const form = within(dialog).getByRole("form", { name: "Datos del doctor" });
    const specialty = within(form).getByLabelText("Especialidad");
    await user.clear(specialty);
    await user.type(specialty, "Pediatría general");
    await user.click(within(form).getByRole("button", { name: "Guardar datos" }));
    await waitFor(() => expect(mock.db.doctors.find((d) => d.name === "Dra. Alta Recepción")!.specialty).toBe("Pediatría general"));

    await user.click(within(form).getByRole("checkbox", { name: /Activo/ }));
    await user.click(within(form).getByRole("button", { name: "Guardar datos" }));
    await waitFor(() => expect(mock.db.doctors.find((d) => d.name === "Dra. Alta Recepción")!.active).toBe(false));
  });

  describe("enlace para que el doctor establezca su contraseña", () => {
    // OJO: `userEvent.setup()` (dentro de `mountApp`) instala su propio portapapeles: estos dobles se ponen DESPUÉS de montar.
    const stubClipboard = (writeText = vi.fn().mockResolvedValue(undefined)) => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      return writeText;
    };
    afterEach(() => {
      Reflect.deleteProperty(navigator, "clipboard");
    });
    const openDatos = async (user: ReturnType<typeof import("@testing-library/user-event").default.setup>, name: string) => {
      await user.click(await screen.findByRole("button", { name: `Horario y ausencias de ${name}` }));
      const dialog = await screen.findByRole("dialog", { name });
      await user.click(within(dialog).getByRole("tab", { name: "Datos" }));
      return dialog;
    };

    it("dar de alta a un doctor crea su cuenta sin correo ni contraseña, y el aviso dice dónde generar su enlace; el formulario sigue igual (sin correo)", async () => {
      const { user, mock, violations: v } = await mountApp({ as: "staff", hash: "#/doctores" });
      violations = v;
      await user.click(await screen.findByRole("button", { name: "Nuevo doctor" }));
      const alta = await screen.findByRole("dialog", { name: "Nuevo doctor" });
      // el mismo formulario de antes: nombre, especialidad, sinónimos, color y activo (nada de correo ni contraseña)
      expect(within(alta).queryByLabelText(/correo/i)).toBeNull();
      expect(within(alta).queryByLabelText(/contraseña/i)).toBeNull();
      await user.type(within(alta).getByLabelText("Nombre"), "Dr. Con Cuenta");
      await user.type(within(alta).getByLabelText("Especialidad"), "Cardiología");
      await user.click(within(alta).getByRole("button", { name: "Dar de alta" }));
      expect(await screen.findByText(/Su cuenta ya existe: genera su enlace de contraseña en «Datos»/)).toBeInTheDocument();
      const doctor = mock.db.doctors.find((d) => d.name === "Dr. Con Cuenta")!;
      expect(mock.db.users.filter((u) => u.doctorId === doctor.id).map((u) => [u.role, u.email, u.password, u.active])).toEqual([["doctor", null, null, true]]);
    });

    it("«Generar enlace y copiar» copia un mensaje corto con el nombre, el código y el enlace, y lo deja a la vista; otro enlace reemplaza al anterior", async () => {
      const { user, mock, violations: v } = await mountApp({ as: "staff", hash: "#/doctores" });
      violations = v;
      const writeText = stubClipboard();
      const dialog = await openDatos(user, "Dr. Cervantes Peláez");
      const section = within(dialog).getByRole("region", { name: "Acceso del doctor a su app" });
      await user.click(within(section).getByRole("button", { name: "Generar enlace y copiar" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const text = writeText.mock.calls[0]![0] as string;
      const lines = text.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("Dr. Cervantes Peláez · Código 1001");
      expect(lines[1]).toBe("Crea o cambia tu contraseña aquí (vale 3 días):");
      expect(lines[2]).toMatch(/^https:\/\/clinica\.test\/doctor\/#\/contrasena\?t=[A-Za-z0-9]{32}$/);
      expect(text.length).toBeLessThan(220); // cabe en un mensaje de WhatsApp
      expect(await within(section).findByText("Copiado al portapapeles. Pégalo en el mensaje.")).toBeInTheDocument();
      expect(within(section).getByLabelText("Mensaje para el doctor")).toHaveValue(text);
      expect(await screen.findByText("Mensaje copiado. Pégalo en WhatsApp o donde prefieras.")).toBeInTheDocument();
      const token1 = lines[2]!.split("?t=")[1]!;
      expect(mock.db.users.find((u) => u.doctorId === "d1")!.setup?.token).toBe(token1);

      await user.click(within(section).getByRole("button", { name: "Generar enlace y copiar" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
      const token2 = (writeText.mock.calls[1]![0] as string).split("?t=")[1]!;
      expect(token2).not.toBe(token1);
      expect(mock.db.users.find((u) => u.doctorId === "d1")!.setup?.token).toBe(token2); // el anterior ya no sirve
    });

    it("un doctor anterior sin cuenta la recibe al generar el enlace; sin permiso de copiar el texto queda para copiarlo a mano", async () => {
      const { user, mock, violations: v } = await mountApp({ as: "admin", hash: "#/doctores" });
      violations = v;
      stubClipboard(vi.fn().mockRejectedValue(new Error("permiso negado"))); // el navegador no deja copiar (p. ej. página sin HTTPS)
      expect(mock.db.users.some((u) => u.doctorId === "d5")).toBe(false);
      const dialog = await openDatos(user, "Dr. Molina López");
      await user.click(within(dialog).getByRole("button", { name: "Generar enlace y copiar" }));
      expect(await within(dialog).findByText("No se pudo copiar solo: selecciona el texto de abajo y cópialo.")).toBeInTheDocument();
      expect((within(dialog).getByLabelText("Mensaje para el doctor") as HTMLTextAreaElement).value).toContain("Dr. Molina López · Código 1005");
      expect(await screen.findByText("Enlace generado. No se pudo copiar solo: cópialo del recuadro.")).toBeInTheDocument();
      expect(mock.db.users.filter((u) => u.doctorId === "d5").map((u) => [u.email, u.password])).toEqual([[null, null]]);
    });

    it("con la cuenta desactivada avisa con el motivo y no deja nada copiado", async () => {
      const { user, violations: v } = await mountApp({
        as: "staff",
        hash: "#/doctores",
        prepare: (m) => m.db.users.push({ id: "u91", email: null, name: "Dra. Geydi", role: "doctor", doctorId: "d6", active: false, password: null }),
      });
      violations = v;
      const writeText = stubClipboard();
      const dialog = await openDatos(user, "Dra. Geydi");
      await user.click(within(dialog).getByRole("button", { name: "Generar enlace y copiar" }));
      expect(await within(dialog).findByText(/La cuenta de este doctor está desactivada: un administrador debe reactivarla en Usuarios/)).toBeInTheDocument();
      expect(writeText).not.toHaveBeenCalled();
      expect(within(dialog).queryByLabelText("Mensaje para el doctor")).toBeNull();
    });
  });

  it("cada doctor muestra su código de acceso de 4 dígitos; el alta lo asigna solo y en «Datos» se ve sin poder editarlo", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "staff", hash: "#/doctores" });
    violations = v;
    const cards = () => Array.from(document.querySelectorAll<HTMLElement>("ul[aria-label='Doctores'] > li"));
    const card = (name: string) => cards().find((c) => c.textContent?.includes(name))!;
    await screen.findByRole("heading", { name: "Doctores" });
    expect(card("Dr. Cervantes Peláez")).toHaveTextContent("Código de acceso: 1001");
    expect(card("Dra. Ana del Carmen Argüelles")).toHaveTextContent("Código de acceso: 1007");

    // el alta avisa que se asignará, y el doctor nuevo recibe el siguiente código libre
    await user.click(screen.getByRole("button", { name: "Nuevo doctor" }));
    const alta = await screen.findByRole("dialog", { name: "Nuevo doctor" });
    expect(within(alta).getByText(/el sistema le asigna un código de 4 dígitos/)).toBeInTheDocument();
    expect(within(alta).queryByLabelText("Código de acceso del doctor")).toBeNull();
    await user.type(within(alta).getByLabelText("Nombre"), "Dr. Con Código");
    await user.type(within(alta).getByLabelText("Especialidad"), "Cardiología");
    await user.click(within(alta).getByRole("button", { name: "Dar de alta" }));
    await waitFor(() => expect(mock.db.doctors.find((d) => d.name === "Dr. Con Código")?.code).toBe("1008"));
    await waitFor(() => expect(card("Dr. Con Código")).toHaveTextContent("Código de acceso: 1008"));

    // en «Datos» el código se ve, pero no es un campo que se pueda editar
    await user.click(screen.getByRole("button", { name: "Horario y ausencias de Dr. Con Código" }));
    const dialog = await screen.findByRole("dialog", { name: "Dr. Con Código" });
    await user.click(within(dialog).getByRole("tab", { name: "Datos" }));
    expect(within(dialog).getByLabelText("Código de acceso del doctor")).toHaveTextContent("1008");
    expect(within(dialog).queryByRole("textbox", { name: /Código/ })).toBeNull();
  });

  it("los doctores de baja no salen por defecto; el check «Mostrar doctores inactivos» los muestra (y viaja en la dirección)", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "staff", hash: "#/doctores" });
    violations = v;
    const cards = () => Array.from(document.querySelectorAll<HTMLElement>("ul[aria-label='Doctores'] > li"));
    const geydi = () => cards().find((c) => c.textContent?.includes("Dra. Geydi"));
    await screen.findByRole("heading", { name: "Doctores" });
    expect(cards()).toHaveLength(7);
    expect(screen.getByRole("checkbox", { name: "Mostrar doctores inactivos (0)" })).not.toBeChecked();

    // se da de baja a la Dra. Geydi desde «Datos»: al cerrar, su card ya no está
    await user.click(screen.getByRole("button", { name: "Horario y ausencias de Dra. Geydi" }));
    const dialog = await screen.findByRole("dialog", { name: "Dra. Geydi" });
    await user.click(within(dialog).getByRole("tab", { name: "Datos" }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Activo/ }));
    await user.click(within(dialog).getByRole("button", { name: "Guardar datos" }));
    await waitFor(() => expect(mock.db.doctors.find((d) => d.id === "d6")!.active).toBe(false));
    await user.click(within(dialog).getByRole("button", { name: /Cerrar/ }));
    await waitFor(() => expect(geydi()).toBeUndefined());
    expect(cards()).toHaveLength(6);
    expect(screen.getByRole("checkbox", { name: "Mostrar doctores inactivos (1)" })).not.toBeChecked();

    // con el check aparece, marcada «De baja», y la dirección lo recuerda
    await user.click(screen.getByRole("checkbox", { name: "Mostrar doctores inactivos (1)" }));
    await waitFor(() => expect(cards()).toHaveLength(7));
    expect(geydi()).toHaveTextContent("De baja");
    expect(window.location.hash).toBe("#/doctores?inactivos=1");

    // quitar el check los vuelve a esconder
    await user.click(screen.getByRole("checkbox", { name: "Mostrar doctores inactivos (1)" }));
    await waitFor(() => expect(geydi()).toBeUndefined());
    expect(window.location.hash).toBe("#/doctores");

    // un enlace con `?inactivos=1` abre ya con el check puesto
    window.location.hash = "#/doctores?inactivos=1";
    await waitFor(() => expect(geydi()).toBeDefined());
    expect(screen.getByRole("checkbox", { name: "Mostrar doctores inactivos (1)" })).toBeChecked();

    // dar de alta otra vez desde su card: vuelve a salir sin el check
    await user.click(screen.getByRole("button", { name: "Horario y ausencias de Dra. Geydi" }));
    const again = await screen.findByRole("dialog", { name: "Dra. Geydi" });
    await user.click(within(again).getByRole("tab", { name: "Datos" }));
    await user.click(within(again).getByRole("checkbox", { name: /Activo/ }));
    await user.click(within(again).getByRole("button", { name: "Guardar datos" }));
    await waitFor(() => expect(mock.db.doctors.find((d) => d.id === "d6")!.active).toBe(true));
    await user.click(within(again).getByRole("button", { name: /Cerrar/ }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Mostrar doctores inactivos (0)" })).toBeInTheDocument());
    expect(geydi()).toBeDefined();
  });

  it("si todos están de baja y el check no está puesto, lo dice en vez de dejar la lista vacía", async () => {
    const { user, violations: v } = await mountApp({ as: "staff", hash: "#/doctores", prepare: (mock) => mock.db.doctors.forEach((d) => (d.active = false)) });
    violations = v;
    await screen.findByRole("heading", { name: "Doctores" });
    const cards = () => Array.from(document.querySelectorAll<HTMLElement>("ul[aria-label='Doctores'] > li"));
    expect(cards()).toHaveLength(0);
    expect(screen.getByText(/No hay doctores activos\. Marca «Mostrar doctores inactivos» para verlos\./)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Mostrar doctores inactivos (7)" }));
    await waitFor(() => expect(cards()).toHaveLength(7));
    expect(screen.queryByText(/No hay doctores activos/)).toBeNull();
    expect(cards().every((c) => c.textContent?.includes("De baja"))).toBe(true);
  });

  it("el administrador elimina un doctor dado de alta por error (con confirmación); con citas o cuenta no se deja", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "admin", hash: "#/doctores" });
    violations = v;
    await user.click(await screen.findByRole("button", { name: "Nuevo doctor" }));
    const alta = await screen.findByRole("dialog", { name: "Nuevo doctor" });
    await user.type(within(alta).getByLabelText("Nombre"), "Dr. Por Error");
    await user.type(within(alta).getByLabelText("Especialidad"), "Cardiología");
    await user.click(within(alta).getByRole("button", { name: "Dar de alta" }));
    await waitFor(() => expect(mock.db.doctors.some((d) => d.name === "Dr. Por Error")).toBe(true));

    const openData = async (name: string) => {
      await user.click(await screen.findByRole("button", { name: `Horario y ausencias de ${name}` }));
      const dlg = await screen.findByRole("dialog", { name });
      await user.click(within(dlg).getByRole("tab", { name: "Datos" }));
      return dlg;
    };

    // el doctor sin historial: pide confirmación (Cancelar no borra nada) y luego se elimina
    let dialog = await openData("Dr. Por Error");
    await user.click(within(dialog).getByRole("button", { name: "Eliminar doctor…" }));
    expect(within(dialog).getByText(/¿Eliminar definitivamente a Dr\. Por Error\?/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(mock.db.doctors.some((d) => d.name === "Dr. Por Error")).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Eliminar doctor…" }));
    await user.click(within(dialog).getByRole("button", { name: "Sí, eliminar" }));
    await waitFor(() => expect(mock.db.doctors.some((d) => d.name === "Dr. Por Error")).toBe(false));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Dr. Por Error" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Horario y ausencias de Dr. Por Error" })).not.toBeInTheDocument();

    // un doctor con citas (y con cuenta): el servidor se niega, dice por qué y no se pierde nada
    dialog = await openData("Dr. Cervantes Peláez");
    await user.click(within(dialog).getByRole("button", { name: "Eliminar doctor…" }));
    await user.click(within(dialog).getByRole("button", { name: "Sí, eliminar" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/citas en el historial.*baja/);
    expect(mock.db.doctors.some((d) => d.id === "d1")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Sí, eliminar" })).toBeEnabled();      // se puede cancelar o reintentar
  });

  it("recepcion no ve «Eliminar doctor»: solo da de baja", async () => {
    const { user, violations: v } = await mountApp({ as: "staff", hash: "#/doctores" });
    violations = v;
    await user.click(await screen.findByRole("button", { name: "Horario y ausencias de Dr. Cervantes Peláez" }));
    const dialog = await screen.findByRole("dialog", { name: "Dr. Cervantes Peláez" });
    await user.click(within(dialog).getByRole("tab", { name: "Datos" }));
    expect(within(dialog).getByRole("checkbox", { name: /Activo/ })).toBeInTheDocument();    // la baja sí
    expect(within(dialog).queryByRole("button", { name: /Eliminar doctor/ })).not.toBeInTheDocument();
  });

  it("el administrador da de alta un doctor", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "admin", hash: "#/doctores" });
    violations = v;
    await user.click(await screen.findByRole("button", { name: "Nuevo doctor" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo doctor" });
    await user.type(within(dialog).getByLabelText("Nombre"), "Dra. Prueba Nueva");
    await user.type(within(dialog).getByLabelText("Especialidad"), "Pediatría");
    await user.type(within(dialog).getByLabelText("Sinónimos"), "pediatra, niños");
    await user.click(within(dialog).getByRole("button", { name: "Dar de alta" }));
    await waitFor(() => expect(mock.db.doctors.some((d) => d.name === "Dra. Prueba Nueva")).toBe(true));
    expect(mock.db.doctors.at(-1)).toMatchObject({ specialty: "Pediatría", aliases: ["pediatra", "niños"], active: true, ownHours: null });
  });
});

describe("usuarios (administrador)", () => {
  /** Los renglones de la lista (solo el nombre, sin el «(tú)»). */
  const names = () =>
    within(screen.getByRole("list", { name: "Usuarios" }))
      .queryAllByRole("listitem")
      .map((li) => li.querySelector("p")!.textContent!.replace("(tú)", "").trim());
  const roleCounts = () => within(screen.getByRole("group", { name: "Filtrar por rol" })).getAllByRole("button").map((b) => b.textContent);
  const showInactive = () => screen.getByRole("checkbox", { name: /Mostrar usuarios sin acceso/ });

  it("lista, valida y crea un usuario; no deja quitarse el acceso a uno mismo", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "admin", hash: "#/usuarios" });
    violations = v;
    const list = await screen.findByRole("list", { name: "Usuarios" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);        // la baja no sale por defecto
    expect(within(list).getByText("(tú)")).toBeInTheDocument();
    expect(within(list).queryByText("Sin acceso")).not.toBeInTheDocument();
    await user.click(showInactive());
    expect(within(screen.getByRole("list", { name: "Usuarios" })).getByText("Sin acceso")).toBeInTheDocument();
    expect(names()).toHaveLength(4);
    await user.click(showInactive());

    await user.click(screen.getByRole("button", { name: "Nuevo usuario" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo usuario" });
    await user.type(within(dialog).getByLabelText("Nombre"), "Persona Nueva");
    await user.type(within(dialog).getByLabelText("Correo"), "nueva@clinica.test");
    await user.type(within(dialog).getByLabelText("Contraseña"), "corta");
    await user.click(within(dialog).getByRole("button", { name: "Crear usuario" }));
    expect(await within(dialog).findByText("La contraseña debe tener al menos 10 caracteres.")).toBeInTheDocument();

    // aquí solo se crean usuarios de personal y administrador: los doctores nacen con el doctor, en Doctores
    const rol = within(dialog).getByLabelText("Rol");
    expect(within(rol).getAllByRole("option").map((o) => o.textContent)).toEqual(["Personal de la clínica", "Administrador técnico"]);
    expect(within(dialog).queryByLabelText("Doctor")).toBeNull();
    expect(within(dialog).getByText(/Los doctores no se crean aquí/)).toBeInTheDocument();
    await user.selectOptions(rol, "admin");
    await user.clear(within(dialog).getByLabelText("Contraseña"));
    await user.type(within(dialog).getByLabelText("Contraseña"), "una-clave-larga-1");
    await user.click(within(dialog).getByRole("button", { name: "Crear usuario" }));
    expect(await screen.findByText("Usuario Persona Nueva creado.")).toBeInTheDocument();
    expect(mock.db.users.at(-1)).toMatchObject({ email: "nueva@clinica.test", role: "admin", doctorId: null, active: true });
    await waitFor(() => expect(names()).toHaveLength(4));

    await user.click(screen.getByRole("button", { name: `Editar a ${account("admin").name}` }));
    const edit = await screen.findByRole("dialog", { name: `Editar a ${account("admin").name}` });
    expect(within(edit).getByLabelText("Rol")).toBeDisabled();
    expect(within(edit).getByRole("checkbox", { name: /Activo/ })).toBeDisabled();
  });

  it("un usuario doctor muestra el código de su doctor; el de uno recién dado de alta, sin correo y «Sin contraseña»; y su formulario no deja cambiar el rol ni el doctor", async () => {
    const { user, mock, violations: v } = await mountApp({
      as: "admin",
      hash: "#/usuarios",
      // la cuenta que nace sola al dar de alta a un doctor: sin correo y sin contraseña
      prepare: (m) => m.db.users.push({ id: "u90", email: null, name: "Dra. Bordas Rodríguez", role: "doctor", doctorId: "d3", active: true, password: null }),
    });
    violations = v;
    const list = await screen.findByRole("list", { name: "Usuarios" });
    expect(within(list).getByText(/Dr\. Cervantes Peláez · código/)).toHaveTextContent("código 1001");
    const nueva = within(list).getByText("Sin correo: entra con su código").closest("li")!;
    expect(within(nueva).getByText(/Dra\. Bordas Rodríguez · código/)).toHaveTextContent("código 1003");
    expect(within(nueva).getByText("Sin contraseña")).toBeInTheDocument();
    expect(within(list).getAllByText("Sin contraseña")).toHaveLength(1); // los demás ya la tienen

    await user.click(within(nueva).getByRole("button", { name: "Editar a Dra. Bordas Rodríguez" }));
    const dialog = await screen.findByRole("dialog", { name: "Editar a Dra. Bordas Rodríguez" });
    const rol = within(dialog).getByLabelText("Rol");
    expect(rol).toBeDisabled();
    expect(within(rol).getAllByRole("option").map((o) => o.textContent)).toEqual(["Doctor"]);
    expect(within(dialog).getByLabelText("Doctor")).toHaveValue("1003 · Dra. Bordas Rodríguez · Ortopedia y Traumatología");
    expect(within(dialog).getByLabelText("Correo")).toBeDisabled();
    expect(within(dialog).getByText(/genera su enlace en Doctores/)).toBeInTheDocument();
    // renombrar la cuenta: solo viaja el nombre (no el rol ni el doctor)
    await user.clear(within(dialog).getByLabelText("Nombre"));
    await user.type(within(dialog).getByLabelText("Nombre"), "Dra. Bordas R.");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(mock.db.users.find((u) => u.id === "u90")!.name).toBe("Dra. Bordas R."));
    expect(mock.db.users.find((u) => u.id === "u90")).toMatchObject({ role: "doctor", doctorId: "d3", password: null });
  });

  it("filtra por rol: «Todos» y un botón por rol, con su cuenta; el filtro viaja en la dirección y se puede quitar", async () => {
    const { user, violations: v } = await mountApp({ as: "admin", hash: "#/usuarios" });
    violations = v;
    const group = await screen.findByRole("group", { name: "Filtrar por rol" });

    // sin filtro: los que tienen acceso (la baja está oculta); los botones llevan cuántos hay de cada rol
    expect(roleCounts()).toEqual(["Todos3", "Administradores1", "Personal1", "Doctores1"]);
    expect(within(group).getByRole("button", { name: /^Todos/ })).toHaveAttribute("aria-pressed", "true");
    expect(names()).toHaveLength(3);

    await user.click(within(group).getByRole("button", { name: /^Personal/ }));
    expect(names()).toEqual([account("staff").name]);
    expect(window.location.hash).toBe("#/usuarios?rol=staff");
    expect(within(group).getByRole("button", { name: /^Personal/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: /^Todos/ })).toHaveAttribute("aria-pressed", "false");

    await user.click(within(group).getByRole("button", { name: /^Doctores/ }));
    expect(names()).toEqual([account("doctor").name]);
    expect(window.location.hash).toBe("#/usuarios?rol=doctor");

    await user.click(within(group).getByRole("button", { name: /^Administradores/ }));
    expect(names()).toEqual([account("admin").name]);
    expect(within(screen.getByRole("list", { name: "Usuarios" })).getByText("(tú)")).toBeInTheDocument();

    await user.click(within(group).getByRole("button", { name: /^Todos/ }));
    expect(names()).toHaveLength(3);
    expect(window.location.hash).toBe("#/usuarios");
  });

  it("los usuarios sin acceso (dados de baja) no salen por defecto; el check los muestra, con su cuenta, y viaja en la dirección", async () => {
    const { user, violations: v } = await mountApp({ as: "admin", hash: "#/usuarios" });
    violations = v;
    await screen.findByRole("list", { name: "Usuarios" });
    expect(showInactive()).not.toBeChecked();
    expect(screen.getByText("Mostrar usuarios sin acceso (1)")).toBeInTheDocument();
    expect(names()).toEqual([account("admin").name, account("staff").name, account("doctor").name]);

    await user.click(showInactive());
    expect(showInactive()).toBeChecked();
    expect(window.location.hash).toBe("#/usuarios?bajas=1");
    expect(names()).toEqual([account("admin").name, account("staff").name, account("doctor").name, "Ex Recepción"]);
    expect(within(screen.getByRole("list", { name: "Usuarios" })).getByText("Sin acceso")).toBeInTheDocument();
    // los botones de rol cuentan lo que se ve: con las bajas, «Personal» pasa de 1 a 2
    expect(roleCounts()).toEqual(["Todos4", "Administradores1", "Personal2", "Doctores1"]);

    await user.click(showInactive());
    expect(window.location.hash).toBe("#/usuarios");
    expect(names()).toHaveLength(3);
  });

  it("el rol y las bajas se combinan; vienen de la dirección y un rol que no existe equivale a «Todos»", async () => {
    const first = await mountApp({ as: "admin", hash: "#/usuarios?rol=staff&bajas=1" });
    violations = first.violations;
    await screen.findByRole("list", { name: "Usuarios" });
    expect(showInactive()).toBeChecked();
    expect(within(screen.getByRole("group", { name: "Filtrar por rol" })).getByRole("button", { name: /^Personal/ })).toHaveAttribute("aria-pressed", "true");
    expect(names()).toEqual([account("staff").name, "Ex Recepción"]);

    // el número del check es el de bajas DEL ROL elegido
    await first.user.click(within(screen.getByRole("group", { name: "Filtrar por rol" })).getByRole("button", { name: /^Doctores/ }));
    expect(names()).toEqual([account("doctor").name]);
    expect(screen.getByText("Mostrar usuarios sin acceso (0)")).toBeInTheDocument();
    first.unmount();

    const second = await mountApp({ as: "admin", hash: "#/usuarios?rol=no-existe&bajas=2" });
    violations = [...violations, ...second.violations];
    await screen.findByRole("list", { name: "Usuarios" });
    expect(within(screen.getByRole("group", { name: "Filtrar por rol" })).getByRole("button", { name: /^Todos/ })).toHaveAttribute("aria-pressed", "true");
    expect(showInactive()).not.toBeChecked();                                                 // solo «bajas=1» las muestra
    expect(names()).toHaveLength(3);
  });

  it("el filtro por rol viene de la dirección y los datos nuevos lo respetan", async () => {
    const first = await mountApp({ as: "admin", hash: "#/usuarios?rol=doctor" });
    violations = first.violations;
    const group = await screen.findByRole("group", { name: "Filtrar por rol" });
    expect(within(group).getByRole("button", { name: /^Doctores/ })).toHaveAttribute("aria-pressed", "true");
    expect(names()).toHaveLength(1);

    // con el filtro puesto, un usuario nuevo de otro rol se crea pero no se ve hasta quitar el filtro; la cuenta sí sube
    await first.user.click(screen.getByRole("button", { name: "Nuevo usuario" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo usuario" });
    await first.user.type(within(dialog).getByLabelText("Nombre"), "Otra Recepción");
    await first.user.type(within(dialog).getByLabelText("Correo"), "otra@clinica.test");
    await first.user.type(within(dialog).getByLabelText("Contraseña"), "una-clave-larga-1");
    await first.user.click(within(dialog).getByRole("button", { name: "Crear usuario" }));
    await screen.findByText("Usuario Otra Recepción creado.");
    await waitFor(() => expect(within(group).getByRole("button", { name: /^Personal/ })).toHaveTextContent("Personal2"));
    expect(names()).toHaveLength(1);
    expect(screen.queryByText("Otra Recepción")).not.toBeInTheDocument();
  });

  it("un rol sin usuarios lo dice (y no deja una lista vacía); con la baja de ese rol, avisa que el check la muestra", async () => {
    const first = await mountApp({
      as: "admin",
      hash: "#/usuarios?rol=doctor",
      prepare: (mock) => {
        mock.db.users = mock.db.users.filter((u) => u.role !== "doctor");
      },
    });
    violations = first.violations;
    expect(await screen.findByText("No hay usuarios con acceso con el rol «Doctor».")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Filtrar por rol" })).getByRole("button", { name: /^Doctores/ })).toHaveTextContent("Doctores0");
    expect(names()).toHaveLength(0);
    await first.user.click(screen.getByRole("button", { name: "Quitar filtro de rol" }));
    await waitFor(() => expect(names()).toEqual([account("admin").name, account("staff").name]));    // sin el doctor (se quitó de la base) y sin la baja
    expect(window.location.hash).toBe("#/usuarios");
    expect(screen.queryByRole("button", { name: "Quitar filtro de rol" })).not.toBeInTheDocument();
    first.unmount();

    // el único doctor está de baja: el aviso lo dice y el check lo trae
    const second = await mountApp({
      as: "admin",
      hash: "#/usuarios?rol=doctor",
      prepare: (mock) => {
        mock.db.users.find((u) => u.role === "doctor")!.active = false;
      },
    });
    violations = [...violations, ...second.violations];
    expect(await screen.findByText("No hay usuarios con acceso con el rol «Doctor». Marca «Mostrar usuarios sin acceso» para verlos.")).toBeInTheDocument();
    await second.user.click(showInactive());
    await waitFor(() => expect(names()).toEqual([account("doctor").name]));
    expect(screen.queryByText(/No hay usuarios/)).not.toBeInTheDocument();
  });

  it("da de baja a otra persona: sale de la lista (hasta marcar el check) y la cuenta sube", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "admin", hash: "#/usuarios" });
    violations = v;
    await user.click(await screen.findByRole("button", { name: `Editar a ${account("staff").name}` }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: /Activo/ }));
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await screen.findByText("Usuario guardado.");
    expect(mock.db.users.find((u) => u.email === account("staff").email)!.active).toBe(false);
    await waitFor(() => expect(names()).toEqual([account("admin").name, account("doctor").name]));
    expect(screen.getByText("Mostrar usuarios sin acceso (2)")).toBeInTheDocument();
    await user.click(showInactive());
    expect(names()).toHaveLength(4);
  });
});

describe("atencion", () => {
  it("lista los casos abiertos con su motivo en espanol y los marca como atendidos", async () => {
    const { user, mock, violations: v } = await mountApp({ hash: "#/atencion" });
    violations = v;
    const list = await screen.findByRole("list", { name: "Casos pendientes" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("El bot pasó la conversación a una persona");
    expect(items[0]).toHaveTextContent("El paciente pidió hablar con una persona");
    expect(items[0]).toHaveTextContent("+52 998 000 0777");

    await user.click(within(items[0]!).getByRole("button", { name: "Marcar como atendido" }));
    expect(await screen.findByText("Caso marcado como atendido.")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Casos pendientes" })).getAllByRole("listitem")).toHaveLength(2));
    expect(mock.db.attention.filter((a) => a.status === "open")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Atendidos" }));
    const done = await screen.findByRole("list", { name: "Casos atendidos" });
    expect(within(done).getAllByRole("listitem")).toHaveLength(2);
    expect(within(done).queryByRole("button", { name: "Marcar como atendido" })).not.toBeInTheDocument();
  });

  describe("atendidos: paginados de 10 en 10, los más recientes primero", () => {
    /** `n` casos atendidos, «Caso 1» el más viejo y «Caso n» el más nuevo, metidos en la base en DESORDEN a propósito. */
    const withResolved = (n: number) => (mock: MockApi) => {
      mock.db.attention = mock.db.attention.filter((a) => a.status !== "resolved");
      const base = Date.parse("2026-10-01T15:00:00.000Z");
      const idx = Array.from({ length: n }, (_, i) => i);
      const shuffled = [...idx.filter((i) => i % 2 === 0), ...idx.filter((i) => i % 2 === 1).reverse()];   // ni creciente ni decreciente
      for (const i of shuffled) {
        mock.db.attention.push({
          id: `res-${i + 1}`, kind: "handoff", status: "resolved", createdAtUtc: new Date(base + (i + 1) * 3_600_000).toISOString(),
          conversationId: null, phone: null, reason: "pidio_persona", detail: `Caso ${i + 1}`,
        });
      }
    };
    const details = (list: HTMLElement) => within(list).getAllByRole("listitem").map((li) => /Caso (\d+)/.exec(li.textContent ?? "")![1]);

    it("10 por página, empezando por el más reciente; Anterior/Siguiente y el rango que se está viendo", async () => {
      const { user, violations: v } = await mountApp({ hash: "#/atencion", prepare: withResolved(25) });
      violations = v;
      await screen.findByRole("list", { name: "Casos pendientes" });
      await user.click(screen.getByRole("button", { name: "Atendidos" }));
      let list = await screen.findByRole("list", { name: "Casos atendidos" });
      const nav = screen.getByRole("navigation", { name: "Paginación de casos atendidos" });

      expect(details(list)).toEqual(["25", "24", "23", "22", "21", "20", "19", "18", "17", "16"]);        // los 10 más nuevos
      expect(nav).toHaveTextContent("Mostrando 1–10 de 25");
      expect(nav).toHaveTextContent("Página 1 de 3");
      expect(within(nav).getByRole("button", { name: "Anterior" })).toBeDisabled();

      await user.click(within(nav).getByRole("button", { name: "Siguiente" }));
      list = screen.getByRole("list", { name: "Casos atendidos" });
      expect(details(list)).toEqual(["15", "14", "13", "12", "11", "10", "9", "8", "7", "6"]);
      expect(nav).toHaveTextContent("Mostrando 11–20 de 25");
      expect(nav).toHaveTextContent("Página 2 de 3");

      await user.click(within(nav).getByRole("button", { name: "Siguiente" }));
      list = screen.getByRole("list", { name: "Casos atendidos" });
      expect(details(list)).toEqual(["5", "4", "3", "2", "1"]);                                           // la última, con lo que sobra
      expect(nav).toHaveTextContent("Mostrando 21–25 de 25");
      expect(nav).toHaveTextContent("Página 3 de 3");
      expect(within(nav).getByRole("button", { name: "Siguiente" })).toBeDisabled();

      await user.click(within(nav).getByRole("button", { name: "Anterior" }));
      expect(details(screen.getByRole("list", { name: "Casos atendidos" }))[0]).toBe("15");
      expect(nav).toHaveTextContent("Página 2 de 3");
    });

    it("al cambiar a Pendientes y volver, empieza otra vez en la primera página; los pendientes no se paginan", async () => {
      const { user, violations: v } = await mountApp({ hash: "#/atencion", prepare: withResolved(25) });
      violations = v;
      await screen.findByRole("list", { name: "Casos pendientes" });
      expect(screen.queryByRole("navigation", { name: /Paginación/ })).toBeNull();                         // pendientes: todos, sin paginar
      await user.click(screen.getByRole("button", { name: "Atendidos" }));
      await screen.findByRole("list", { name: "Casos atendidos" });
      await user.click(within(screen.getByRole("navigation", { name: /Paginación/ })).getByRole("button", { name: "Siguiente" }));
      expect(screen.getByRole("navigation", { name: /Paginación/ })).toHaveTextContent("Página 2 de 3");

      await user.click(screen.getByRole("button", { name: "Pendientes" }));
      await screen.findByRole("list", { name: "Casos pendientes" });
      expect(screen.queryByRole("navigation", { name: /Paginación/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Atendidos" }));
      const list = await screen.findByRole("list", { name: "Casos atendidos" });
      expect(details(list)[0]).toBe("25");
      expect(screen.getByRole("navigation", { name: /Paginación/ })).toHaveTextContent("Página 1 de 3");
    });

    it("pide al servidor UNA página a la vez (limit/offset), nunca todos los atendidos; los pendientes sí vienen completos", async () => {
      const urls: string[] = [];
      const { user, violations: v } = await mountApp({
        hash: "#/atencion",
        prepare: (mock) => {
          withResolved(25)(mock);
          const original = mock.fetch;
          mock.fetch = (input, init) => {
            urls.push(String(input));
            return original(input, init);
          };
        },
      });
      violations = v;
      await screen.findByRole("list", { name: "Casos pendientes" });
      const attention = () => urls.filter((u) => u.includes("/api/attention?"));
      expect(attention().every((u) => !u.includes("limit="))).toBe(true);                                  // pendientes: sin límite

      await user.click(screen.getByRole("button", { name: "Atendidos" }));
      await screen.findByRole("list", { name: "Casos atendidos" });
      await user.click(within(screen.getByRole("navigation", { name: /Paginación/ })).getByRole("button", { name: "Siguiente" }));
      await waitFor(() => expect(attention().some((u) => u.includes("status=resolved") && u.includes("offset=10"))).toBe(true));
      const resolved = attention().filter((u) => u.includes("status=resolved"));
      expect(resolved.length).toBeGreaterThanOrEqual(2);
      expect(resolved.every((u) => u.includes("limit=10"))).toBe(true);                                    // ninguna pide todos
      expect(resolved.some((u) => u.includes("offset=0"))).toBe(true);
    });

    /** Un servidor de la versión ANTERIOR (sin reiniciar): ignora `limit`/`offset` y no manda `total`. */
    const oldServer = (n: number) => (mock: MockApi) => {
      withResolved(n)(mock);
      const original = mock.fetch;
      mock.fetch = async (input, init) => {
        const url = new URL(String(input), "http://local.test");
        if (url.pathname !== "/api/attention") return original(input, init);
        url.searchParams.delete("limit");
        url.searchParams.delete("offset");
        const res = await original(url.pathname + url.search, init);
        const { items } = (await res.json()) as { items: unknown[] };
        return new Response(JSON.stringify({ items }), { status: res.status, headers: { "Content-Type": "application/json" } });
      };
    };

    it("con un servidor de la versión anterior (sin `total`, que manda todos) no sale «NaN»: se pagina aquí mismo", async () => {
      // (no se revisa el contrato: ese servidor responde sin `total` a propósito)
      const { user } = await mountApp({ hash: "#/atencion", prepare: oldServer(25) });
      await screen.findByRole("list", { name: "Casos pendientes" });
      await user.click(screen.getByRole("button", { name: "Atendidos" }));
      let list = await screen.findByRole("list", { name: "Casos atendidos" });
      const nav = screen.getByRole("navigation", { name: /Paginación/ });
      expect(details(list)).toEqual(["25", "24", "23", "22", "21", "20", "19", "18", "17", "16"]);        // solo 10, aunque llegaron 25
      expect(nav).toHaveTextContent("Mostrando 1–10 de 25");
      expect(nav).toHaveTextContent("Página 1 de 3");
      await user.click(within(nav).getByRole("button", { name: "Siguiente" }));
      list = screen.getByRole("list", { name: "Casos atendidos" });
      expect(details(list)).toEqual(["15", "14", "13", "12", "11", "10", "9", "8", "7", "6"]);
      expect(nav).toHaveTextContent("Página 2 de 3");
      expect(document.body.textContent).not.toMatch(/NaN/);
    });

    it("con un servidor de la versión anterior y pocos atendidos (4), la lista sale completa y sin paginación ni «NaN»", async () => {
      const { user } = await mountApp({ hash: "#/atencion", prepare: oldServer(4) });
      await screen.findByRole("list", { name: "Casos pendientes" });
      await user.click(screen.getByRole("button", { name: "Atendidos" }));
      const list = await screen.findByRole("list", { name: "Casos atendidos" });
      expect(details(list)).toEqual(["4", "3", "2", "1"]);
      expect(screen.queryByRole("navigation", { name: /Paginación/ })).toBeNull();
      expect(document.body.textContent).not.toMatch(/NaN/);
    });

    it("si la lista se achica mientras se mira la última página, pasa sola a la última que exista", async () => {
      const { user, mock, violations: v } = await mountApp({ hash: "#/atencion", prepare: withResolved(25) });
      violations = v;
      await screen.findByRole("list", { name: "Casos pendientes" });
      await user.click(screen.getByRole("button", { name: "Atendidos" }));
      await screen.findByRole("list", { name: "Casos atendidos" });
      const nav = () => screen.getByRole("navigation", { name: /Paginación/ });
      await user.click(within(nav()).getByRole("button", { name: "Siguiente" }));
      await user.click(within(nav()).getByRole("button", { name: "Siguiente" }));
      await waitFor(() => expect(nav()).toHaveTextContent("Página 3 de 3"));

      // otro deja solo 12 atendidos: la página 3 ya no existe
      mock.db.attention = mock.db.attention.filter((a) => a.status !== "resolved" || Number(/(\d+)$/.exec(a.id)![1]) > 13);
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(nav()).toHaveTextContent("Página 2 de 2"));
      expect(nav()).toHaveTextContent("Mostrando 11–12 de 12");
      expect(within(screen.getByRole("list", { name: "Casos atendidos" })).getAllByRole("listitem")).toHaveLength(2);
    });

    it("con 10 o menos no hay paginación; con 11 hay dos páginas (10 y 1)", async () => {
      const diez = await mountApp({ hash: "#/atencion", prepare: withResolved(10) });
      violations = diez.violations;
      await screen.findByRole("list", { name: "Casos pendientes" });
      await diez.user.click(screen.getByRole("button", { name: "Atendidos" }));
      expect(within(await screen.findByRole("list", { name: "Casos atendidos" })).getAllByRole("listitem")).toHaveLength(10);
      expect(screen.queryByRole("navigation", { name: /Paginación/ })).toBeNull();
      diez.unmount();

      const once = await mountApp({ hash: "#/atencion", prepare: withResolved(11) });
      await screen.findByRole("list", { name: "Casos pendientes" });
      await once.user.click(screen.getByRole("button", { name: "Atendidos" }));
      expect(within(await screen.findByRole("list", { name: "Casos atendidos" })).getAllByRole("listitem")).toHaveLength(10);
      const nav = screen.getByRole("navigation", { name: /Paginación/ });
      expect(nav).toHaveTextContent("Página 1 de 2");
      await once.user.click(within(nav).getByRole("button", { name: "Siguiente" }));
      expect(within(screen.getByRole("list", { name: "Casos atendidos" })).getAllByRole("listitem")).toHaveLength(1);
      expect(nav).toHaveTextContent("Mostrando 11–11 de 11");
      violations = [...violations, ...once.violations];
    });
  });

  it("la insignia de la barra cuenta los casos abiertos", async () => {
    const { violations: v } = await mountApp();
    violations = v;
    expect(await screen.findByLabelText("3 casos abiertos")).toBeInTheDocument();
  });
});
