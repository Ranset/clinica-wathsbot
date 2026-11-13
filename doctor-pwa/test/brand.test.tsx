import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { BRAND_CACHE_KEY } from "../src/brand";
import { png } from "../../shared/api-client/test/images";
import { freezeClock, makeServer, mountApp, storedKeys } from "./helpers";

beforeEach(() => {
  window.localStorage.clear();
  freezeClock();
});

const logoOf = () => Array.from(document.querySelectorAll<HTMLImageElement>("img[data-brand-logo]"));
const defaultIcons = () => Array.from(document.querySelectorAll<HTMLElement>("[data-brand-default]"));
const custom = (server: ReturnType<typeof makeServer>, name = "Clínica Santa María", hash = "abc12345") => {
  server.mock.db.branding.name = name;
  server.mock.db.branding.logo = { contentType: "image/png", bytes: png(128), hash };
};

describe("marca de la clínica en la app del doctor", () => {
  it("por defecto: el icono y «Clínica CUBAMEX» en el inicio de sesión y en el encabezado", async () => {
    const anon = await mountApp({ as: null });
    expect(await screen.findByRole("heading", { level: 1, name: "Clínica CUBAMEX" })).toBeInTheDocument();
    expect(defaultIcons()).toHaveLength(1);
    expect(logoOf()).toHaveLength(0);
    anon.unmount();

    await mountApp();
    expect(await screen.findByRole("link", { name: "Clínica CUBAMEX, ir a Hoy" })).toBeInTheDocument();
    expect(document.title).toBe("Mi agenda · Clínica CUBAMEX");
  });

  it("con el nombre y el logotipo que puso el administrador: ya en el inicio de sesión y luego en el encabezado", async () => {
    const server = makeServer();
    custom(server);
    const anon = await mountApp({ as: null, server });
    expect(await screen.findByRole("heading", { level: 1, name: "Clínica Santa María" })).toBeInTheDocument();
    await waitFor(() => expect(logoOf()).toHaveLength(1));
    expect(logoOf()[0]!.src).toMatch(/^data:image\/png;base64,/);
    expect(defaultIcons()).toHaveLength(0);
    anon.unmount();

    await mountApp({ server });
    expect(await screen.findByRole("link", { name: "Clínica Santa María, ir a Hoy" })).toBeInTheDocument();
    expect(screen.getByText("Clínica Santa María", { selector: ".kicker" })).toBeInTheDocument();
    await waitFor(() => expect(logoOf().length).toBeGreaterThan(0));
    expect(document.title).toBe("Mi agenda · Clínica Santa María");
  });

  it("un nombre largo no desborda el encabezado (se recorta con «…»)", async () => {
    const server = makeServer();
    server.mock.db.branding.name = "Centro Médico de Especialidades del Caribe Mexicano".repeat(1);
    await mountApp({ server });
    const kicker = await screen.findByText(/Centro Médico de Especialidades/, { selector: ".kicker" });
    expect(kicker).toHaveClass("truncate");
  });

  it("se guarda en el dispositivo: sin conexión la app abre con la última marca que se leyó, y cerrar sesión NO la borra", async () => {
    const server = makeServer();
    custom(server);
    const first = await mountApp({ server });
    await screen.findByRole("link", { name: "Clínica Santa María, ir a Hoy" });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(BRAND_CACHE_KEY) ?? "null")).toMatchObject({ name: "Clínica Santa María", logo: expect.stringMatching(/^data:image\/png/) }));
    first.unmount();

    // «se abre la app en un túnel»: el servidor no contesta
    server.mock.controls.setOffline(true);
    const second = await mountApp({ server, as: null });
    expect(await screen.findByRole("link", { name: "Clínica Santa María, ir a Hoy" })).toBeInTheDocument();
    expect(logoOf().length).toBeGreaterThan(0);
    second.unmount();

    // cerrar sesión borra lo del doctor, pero la marca de la clínica se queda
    server.mock.controls.setOffline(false);
    const third = await mountApp({ server });
    window.location.hash = "#/cuenta";
    await third.user.click(await screen.findByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(storedKeys()).toEqual([]);
    expect(window.localStorage.getItem(BRAND_CACHE_KEY)).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Clínica Santa María" })).toBeInTheDocument();
  });

  it("una copia dañada o con una imagen que no es imagen se ignora (no se pinta nada raro)", async () => {
    window.localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify({ name: "Clínica X", logoUrl: "/x", logo: "javascript:alert(1)" }));
    const server = makeServer({ fail: (p) => p.startsWith("/api/branding") });             // la marca no se puede leer: se usa la copia
    const first = await mountApp({ server, as: null });
    expect(await screen.findByRole("heading", { level: 1, name: "Clínica X" })).toBeInTheDocument();
    expect(logoOf()).toHaveLength(0);                                                       // `javascript:` no es una imagen
    expect(defaultIcons().length).toBeGreaterThan(0);
    first.unmount();

    window.localStorage.setItem(BRAND_CACHE_KEY, "{no es json");                            // copia dañada: marca por defecto
    await mountApp({ server, as: null });
    expect(await screen.findByRole("heading", { level: 1, name: "Clínica CUBAMEX" })).toBeInTheDocument();
  });

  it("leer la marca NO cuenta como falla de conexión: si solo eso falla, la app no pasa a «sin conexión»", async () => {
    const server = makeServer({ fail: (p) => p.startsWith("/api/branding") });
    await mountApp({ server });
    expect(await screen.findByRole("link", { name: "Clínica CUBAMEX, ir a Hoy" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByTestId("offline-pill")).toBeNull();
  });

  it("al volver a la app se confirma: un nombre nuevo aparece, y la imagen solo se baja si cambió su dirección", async () => {
    const server = makeServer();
    custom(server);
    await mountApp({ server });
    await screen.findByRole("link", { name: "Clínica Santa María, ir a Hoy" });
    const imagenes = () => server.log.filter((r) => r.path === "/api/branding/logo").length;
    await waitFor(() => expect(imagenes()).toBe(1));

    server.mock.db.branding.name = "Clínica Nueva";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByRole("link", { name: "Clínica Nueva, ir a Hoy" })).toBeInTheDocument();
    expect(imagenes()).toBe(1);                                                              // misma huella: no se vuelve a bajar

    custom(server, "Clínica Nueva", "otra-huella");                                          // otro logotipo
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(imagenes()).toBe(2));
  });
});
