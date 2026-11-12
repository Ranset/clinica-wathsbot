import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { doctorColor } from "@clinica/calendar";
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
  it("lista, valida y crea un usuario; no deja quitarse el acceso a uno mismo", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "admin", hash: "#/usuarios" });
    violations = v;
    const list = await screen.findByRole("list", { name: "Usuarios" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getByText("(tú)")).toBeInTheDocument();
    expect(within(list).getByText("Sin acceso")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Nuevo usuario" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo usuario" });
    await user.type(within(dialog).getByLabelText("Nombre"), "Persona Nueva");
    await user.type(within(dialog).getByLabelText("Correo"), "nueva@clinica.test");
    await user.type(within(dialog).getByLabelText("Contraseña"), "corta");
    await user.click(within(dialog).getByRole("button", { name: "Crear usuario" }));
    expect(await within(dialog).findByText("La contraseña debe tener al menos 10 caracteres.")).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText("Rol"), "doctor");
    await user.click(within(dialog).getByRole("button", { name: "Crear usuario" }));
    expect(await within(dialog).findByText("Elige a qué doctor corresponde este usuario.")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Doctor"), "d3");
    await user.clear(within(dialog).getByLabelText("Contraseña"));
    await user.type(within(dialog).getByLabelText("Contraseña"), "una-clave-larga-1");
    await user.click(within(dialog).getByRole("button", { name: "Crear usuario" }));
    expect(await screen.findByText("Usuario Persona Nueva creado.")).toBeInTheDocument();
    expect(mock.db.users.at(-1)).toMatchObject({ email: "nueva@clinica.test", role: "doctor", doctorId: "d3", active: true });
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Usuarios" })).getAllByRole("listitem")).toHaveLength(5));

    await user.click(screen.getByRole("button", { name: `Editar a ${account("admin").name}` }));
    const edit = await screen.findByRole("dialog", { name: `Editar a ${account("admin").name}` });
    expect(within(edit).getByLabelText("Rol")).toBeDisabled();
    expect(within(edit).getByRole("checkbox", { name: /Activo/ })).toBeDisabled();
  });

  it("da de baja a otra persona", async () => {
    const { user, mock, violations: v } = await mountApp({ as: "admin", hash: "#/usuarios" });
    violations = v;
    await user.click(await screen.findByRole("button", { name: `Editar a ${account("staff").name}` }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: /Activo/ }));
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await screen.findByText("Usuario guardado.");
    expect(mock.db.users.find((u) => u.email === account("staff").email)!.active).toBe(false);
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

  it("la insignia de la barra cuenta los casos abiertos", async () => {
    const { violations: v } = await mountApp();
    violations = v;
    expect(await screen.findByLabelText("3 casos abiertos")).toBeInTheDocument();
  });
});
