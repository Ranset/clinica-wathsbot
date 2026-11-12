import { beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { readStoredSession, safeLocalStorage, writeStoredSession } from "../src/lib/storage";
import { account, bookingButton, freezeClock, makeServer, mountApp, pickBooking, storedKeys } from "./helpers";

beforeEach(freezeClock);

const posts = (log: ReturnType<typeof makeServer>["log"]) => log.filter((r) => r.method === "POST" && r.path.startsWith("/api/doctor/"));

describe("la app abre sin conexión (solo lectura con lo último guardado)", () => {
  it("abre con la agenda, el horario y las ausencias guardados, dice la última sincronización, no deja escribir, y se recupera al volver la red", async () => {
    const server = makeServer();
    server.mock.db.absences.push({ id: "a-mia", doctorId: "d1", startUtc: "2026-11-16T05:00:00.000Z", endUtc: "2026-11-17T05:00:00.000Z", reason: "Trámite" });

    // 1) con red: se abre la agenda y se guardan copias
    const first = await mountApp({ server });
    const cita = pickBooking(server.mock, "2026-11-10");
    await bookingButton(cita);
    await screen.findByText("Dr. Cervantes Peláez");
    await waitFor(() => expect(storedKeys().some((k) => k.endsWith(":absences"))).toBe(true));
    first.unmount();

    // 2) «se abre la app en un túnel»: el servidor no contesta
    server.mock.controls.setOffline(true);
    const second = await mountApp({ server, as: null });

    expect(await bookingButton(cita)).toBeInTheDocument(); // la agenda guardada
    expect(screen.getByText("Dr. Cervantes Peláez")).toBeInTheDocument(); // el perfil guardado
    expect(await screen.findByTestId("offline-pill")).toHaveTextContent("Sin conexión");
    expect(screen.getByText(/Sin conexión\. Ves lo último que se guardó en este dispositivo/)).toBeInTheDocument();
    expect(screen.getByTestId("sync-status")).toHaveTextContent("Última sincronización: hoy 10:00 AM");

    // ausencias: se leen, no se escribe
    window.location.hash = "#/ausencias";
    expect(await screen.findByText("Trámite")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Registrar ausencia" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quitar la ausencia del lun 16 nov" })).toBeDisabled();

    // horario: se lee el vigente (perfil guardado), no se pide un cambio
    window.location.hash = "#/horario";
    expect(await screen.findByRole("list", { name: "Mi horario semanal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Solicitar cambio de horario" })).toBeDisabled();
    expect(posts(server.log)).toHaveLength(0);

    // 3) vuelve la red: se confirma la sesión (token CSRF), se refresca todo y se puede escribir otra vez
    server.mock.controls.setOffline(false);
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(screen.queryByTestId("offline-pill")).toBeNull(), { timeout: 3000 });
    expect(screen.getByRole("button", { name: "Solicitar cambio de horario" })).toBeEnabled();
    window.location.hash = "#/ausencias";
    await waitFor(() => expect(screen.getByRole("button", { name: "Registrar ausencia" })).toBeEnabled());
    second.unmount();
  });

  it("mientras la sesión abierta sin red no se confirma, no hay token para escribir: aunque el navegador diga «en línea», sigue solo lectura", async () => {
    const server = makeServer();
    const first = await mountApp({ server });
    await screen.findByText("Dr. Cervantes Peláez");
    first.unmount();

    server.mock.controls.setOffline(true);
    await mountApp({ server, as: null, hash: "#/ausencias" });
    expect(await screen.findByRole("button", { name: "Registrar ausencia" })).toBeDisabled();
    // el navegador cree que hay red (navigator.onLine=true) pero el servidor no responde: la app no se fía del navegador
    expect(navigator.onLine).toBe(true);
    expect(await screen.findByTestId("offline-pill")).toBeInTheDocument();
  });

  it("la primera vez en un dispositivo (nada guardado) y sin red: avisa que se necesita conexión y deja reintentar", async () => {
    const server = makeServer();
    server.mock.controls.setOffline(true);
    const t = await mountApp({ server, as: null });
    expect(await screen.findByText("No se pudo conectar")).toBeInTheDocument();
    expect(screen.getByText(/La primera vez que entras en este dispositivo se necesita conexión/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Secciones" })).toBeNull();

    server.mock.controls.setOffline(false);
    await t.user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument(); // hay red, pero no hay sesión
  });

  it("la sesión recordada de alguien que NO es doctor no abre nada sin conexión", async () => {
    const server = makeServer();
    const staff = server.mock.db.users.find((u) => u.role === "staff")!;
    writeStoredSession(safeLocalStorage(), { user: { id: staff.id, email: staff.email, name: staff.name, role: "staff", doctorId: null, active: true }, savedAt: new Date().toISOString() });
    server.mock.controls.setOffline(true);
    await mountApp({ server, as: null });
    expect(await screen.findByText("No se pudo conectar")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("una sesión vencida de verdad (401) al abrir olvida la sesión recordada y pide entrar de nuevo", async () => {
    const server = makeServer();
    const first = await mountApp({ server });
    await screen.findByText("Dr. Cervantes Peláez");
    expect(readStoredSession(safeLocalStorage())?.user.email).toBe(account("doctor").email);
    first.unmount();

    server.mock.controls.expireSession();
    await mountApp({ server, as: null });
    expect(await screen.findByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(readStoredSession(safeLocalStorage())).toBeNull();
  });

  it("abierta sin red y con la sesión vencida: al volver la red lo manda al login con el aviso", async () => {
    const server = makeServer();
    const first = await mountApp({ server });
    await screen.findByText("Dr. Cervantes Peláez");
    first.unmount();

    server.mock.controls.setOffline(true);
    await mountApp({ server, as: null });
    expect(await screen.findByTestId("offline-pill")).toBeInTheDocument();

    server.mock.controls.setOffline(false);
    server.mock.controls.expireSession();
    act(() => void window.dispatchEvent(new Event("online")));
    expect(await screen.findByText("Tu sesión terminó. Inicia sesión de nuevo.", undefined, { timeout: 3000 })).toBeInTheDocument();
  });
});
