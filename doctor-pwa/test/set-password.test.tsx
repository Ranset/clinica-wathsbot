import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { PREFIX } from "../src/lib/storage";
import { NOW, account, freezeClock, makeServer, mountApp, storedKeys } from "./helpers";

beforeEach(freezeClock);

const GOOD = "mi-contrasena-nueva-1";

/** El enlace que genera el personal para ese doctor (con una sesión de personal, que se cierra: quien abre el enlace aún no tiene sesión). */
async function linkFor(server: ReturnType<typeof makeServer>, doctorId: string): Promise<string> {
  await server.api.auth.login(account("staff").email, account("staff").password);
  const link = await server.api.doctors.createPasswordLink(doctorId);
  await server.api.auth.logout();
  return link.url.split("?t=")[1]!;
}

const open = (server: ReturnType<typeof makeServer>, token: string | null, as: "doctor" | null = null) =>
  mountApp({ as, server, hash: token === null ? "#/contrasena" : `#/contrasena?t=${token}` });

const fill = async (t: Awaited<ReturnType<typeof mountApp>>, password: string, repeat = password) => {
  await t.user.type(await screen.findByLabelText("Contraseña nueva"), password);
  await t.user.type(screen.getByLabelText("Repite la contraseña"), repeat);
  await t.user.click(screen.getByRole("button", { name: "Guardar contraseña y entrar" }));
};

const usedLink = (log: ReturnType<typeof makeServer>["log"]) => log.find((r) => r.path === "/api/auth/password-link/use");

describe("crear (o cambiar) la contraseña con el enlace de la clínica", () => {
  it("un doctor recién dado de alta abre su enlace, ve su nombre y su código, crea su contraseña y queda en su agenda", async () => {
    const server = makeServer();
    await server.api.auth.login(account("staff").email, account("staff").password);
    const doctor = await server.api.doctors.create({ name: "Dr. Recién Llegado", specialty: "Cardiología" });
    await server.api.auth.logout();
    const token = await linkFor(server, doctor.id);
    expect(server.mock.db.users.find((u) => u.doctorId === doctor.id)).toMatchObject({ email: null, password: null }); // cuenta sin correo ni contraseña

    const t = await open(server, token);
    expect(await screen.findByRole("form", { name: "Crear contraseña" })).toBeInTheDocument();
    expect(screen.getByText("Dr. Recién Llegado")).toBeInTheDocument();
    expect(screen.getByLabelText("Usuario (tu código)")).toHaveValue(doctor.code); // su «usuario» es el código
    expect(screen.queryByLabelText("Correo")).toBeNull();

    await fill(t, GOOD);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Martes, 10 de noviembre de 2026"); // ya está en su agenda
    expect((await screen.findAllByText("Dr. Recién Llegado")).length).toBeGreaterThan(0);
    expect(window.location.hash).toBe("#/hoy");
    expect(window.location.href).not.toContain(token); // el enlace ya no está en la dirección
    expect(usedLink(t.log)?.body).toEqual({ token, password: GOOD });
    expect(server.mock.db.users.find((u) => u.doctorId === doctor.id)).toMatchObject({ password: GOOD, setup: null });
    expect(t.violations).toEqual([]);
  });

  it("si olvidó su contraseña, el enlace pone otra: la anterior deja de servir y el enlace se gasta", async () => {
    const server = makeServer();
    const token = await linkFor(server, "d1"); // el doctor de ejemplo ya tenía contraseña
    const before = account("doctor").password;
    const t = await open(server, token);
    await fill(t, GOOD);
    await screen.findByRole("heading", { level: 1 });
    const stored = server.mock.db.users.find((u) => u.doctorId === "d1")!;
    expect(stored.password).toBe(GOOD);
    expect(stored.password).not.toBe(before);
    expect(stored.setup).toBeNull();
  });

  it("valida en la pantalla: contraseña de al menos 10 caracteres y que las dos coincidan; no manda nada hasta que esté bien", async () => {
    const server = makeServer();
    const t = await open(server, await linkFor(server, "d1"));
    await fill(t, "corta");
    expect(await screen.findByText("Escribe una contraseña de al menos 10 caracteres.")).toBeInTheDocument();
    expect(usedLink(t.log)).toBeUndefined();

    await t.user.clear(screen.getByLabelText("Contraseña nueva"));
    await t.user.clear(screen.getByLabelText("Repite la contraseña"));
    await fill(t, GOOD, "otra-contrasena-distinta");
    expect(await screen.findByText("Las contraseñas no coinciden.")).toBeInTheDocument();
    expect(usedLink(t.log)).toBeUndefined();

    await t.user.clear(screen.getByLabelText("Repite la contraseña"));
    await t.user.type(screen.getByLabelText("Repite la contraseña"), GOOD);
    await t.user.click(screen.getByRole("button", { name: "Guardar contraseña y entrar" }));
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(usedLink(t.log)?.body).toEqual({ token: expect.any(String), password: GOOD });
  });

  it("un enlace que no existe, sin enlace, ya usado o vencido: «Este enlace ya no sirve», sin formulario, y se puede ir a entrar", async () => {
    // desconocido
    const a = makeServer();
    const t = await open(a, "x".repeat(32));
    expect(await screen.findByRole("heading", { name: "Este enlace ya no sirve" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Crear contraseña" })).toBeNull();
    await t.user.click(screen.getByRole("button", { name: "Ir al inicio" }));
    expect(await screen.findByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/hoy");
    t.unmount();

    // sin el parámetro del enlace
    const b = makeServer();
    const t2 = await open(b, null);
    expect(await screen.findByRole("heading", { name: "Este enlace ya no sirve" })).toBeInTheDocument();
    expect(b.log.some((r) => r.path === "/api/auth/password-link/check")).toBe(false); // ni siquiera se pregunta
    t2.unmount();

    // ya usado
    const c = makeServer();
    const used = await linkFor(c, "d1");
    await c.api.auth.usePasswordLink(used, GOOD);
    await c.api.auth.logout();
    const t3 = await open(c, used);
    expect(await screen.findByRole("heading", { name: "Este enlace ya no sirve" })).toBeInTheDocument();
    t3.unmount();

    // vencido (duran 72 h)
    const d = makeServer();
    const old = await linkFor(d, "d1");
    vi.setSystemTime(new Date(NOW.getTime() + 73 * 3600_000));
    await open(d, old);
    expect(await screen.findByRole("heading", { name: "Este enlace ya no sirve" })).toBeInTheDocument();
  });

  it("si lo usan (o la clínica genera otro) mientras escribe, al guardar avisa que ya no sirve", async () => {
    const server = makeServer();
    const t = await open(server, await linkFor(server, "d1"));
    await screen.findByRole("form", { name: "Crear contraseña" });
    server.mock.db.users.find((u) => u.doctorId === "d1")!.setup = null; // otro enlace lo reemplazó
    await fill(t, GOOD);
    expect(await screen.findByRole("heading", { name: "Este enlace ya no sirve" })).toBeInTheDocument();
    expect(server.mock.db.users.find((u) => u.doctorId === "d1")!.password).toBe(account("doctor").password); // no cambió nada
  });

  it("sin conexión al comprobar el enlace avisa y «Reintentar» lo vuelve a pedir", async () => {
    let down = true;
    const server = makeServer({ fail: (p) => down && p === "/api/auth/password-link/check" });
    const t = await open(server, await linkFor(server, "d1"));
    expect(await screen.findByText("No se pudo comprobar el enlace")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Crear contraseña" })).toBeNull();
    down = false;
    await t.user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("form", { name: "Crear contraseña" })).toBeInTheDocument();
  });

  it("con la sesión de otro doctor abierta en el dispositivo, el enlace lo cambia de cuenta y no hereda lo guardado del anterior", async () => {
    const server = makeServer();
    const token = await linkFor(server, "d3"); // el enlace es de la Dra. Bordas (cuenta creada al generarlo)
    window.localStorage.setItem(`${PREFIX}u99:agenda:x`, JSON.stringify({ savedAt: "2026-11-09T15:00:00.000Z", data: [] }));
    const t = await open(server, token, "doctor"); // el dispositivo tiene la sesión del Dr. Cervantes
    expect(await screen.findByRole("form", { name: "Crear contraseña" })).toBeInTheDocument(); // se abre aunque ya haya sesión
    expect(screen.getByText("Dra. Bordas Rodríguez")).toBeInTheDocument();
    await fill(t, GOOD);
    expect((await screen.findAllByText("Dra. Bordas Rodríguez")).length).toBeGreaterThan(0); // ahora es SU agenda
    const bordas = server.mock.db.users.find((u) => u.doctorId === "d3")!;
    await waitFor(() => expect(storedKeys().some((k) => k.includes(`:${bordas.id}:`))).toBe(true));
    expect(storedKeys().filter((k) => k.includes(":u99:"))).toEqual([]);
  });
});
