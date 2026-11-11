import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { freezeClock, makeServer, mountApp, setBrowserOnline } from "./helpers";

beforeEach(freezeClock);

const KEY = "BJPBstiuH1goUchCcdvJZClMwfFIjR_sZj7yhlBzL214Av_cdD0H0mJznxpQb9YR961XV-4Qccyqa8dbVjIY6y4";
const ENDPOINT = "https://push.example.test/send/abc123";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const pushPosts = (log: ReturnType<typeof makeServer>["log"]) => log.filter((r) => r.path === "/api/doctor/push-subscriptions");

/** Un navegador con service worker, PushManager y Notification de mentira (jsdom no trae ninguno). */
function fakeBrowser(opts: { subscribed?: boolean; permission?: NotificationPermission; answer?: NotificationPermission; subscribeFails?: boolean } = {}) {
  const sub = {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "clave-publica", auth: "secreto-auth" } }),
    unsubscribe: vi.fn(async () => {
      current = null;
      return true;
    }),
  };
  let current: typeof sub | null = opts.subscribed ? sub : null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (_o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      if (opts.subscribeFails) throw new DOMException("Registration failed - push service error", "AbortError");
      current = sub;
      return sub;
    }),
  };
  const reg = { pushManager };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => reg, ready: Promise.resolve(reg) } });
  const Notification = Object.assign(function () {}, {
    permission: opts.permission ?? "default",
    requestPermission: vi.fn(async () => {
      Notification.permission = opts.answer ?? "granted";
      return Notification.permission;
    }),
  });
  vi.stubGlobal("Notification", Notification);
  vi.stubGlobal("PushManager", class {});
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY", KEY);
  return { sub, pushManager, Notification };
}

afterEach(() => {
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (navigator as { userAgent?: string }).userAgent;
  delete (navigator as { standalone?: boolean }).standalone;
});

const openAccount = async (server = makeServer()) => {
  const t = await mountApp({ hash: "#/cuenta", server });
  await screen.findByRole("region", { name: "Avisos" });
  return t;
};

describe("avisos push: pedir permiso, suscribir y registrar en el servidor", () => {
  it("activar: pide permiso, suscribe el service worker con la clave VAPID y manda endpoint y claves al servidor", async () => {
    const b = fakeBrowser();
    const t = await openAccount();
    await t.user.click(await screen.findByRole("button", { name: "Activar avisos" }));

    await screen.findByText("Los avisos están activados en este dispositivo.");
    expect(b.Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(b.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const arg = b.pushManager.subscribe.mock.calls[0]![0];
    expect(arg.userVisibleOnly).toBe(true);
    expect(arg.applicationServerKey).toHaveLength(65);
    expect(pushPosts(t.log).map((r) => [r.method, r.body])).toEqual([["POST", { endpoint: ENDPOINT, keys: { p256dh: "clave-publica", auth: "secreto-auth" } }]]);
    expect(screen.getByRole("button", { name: "Desactivar avisos" })).toBeInTheDocument();
    expect(t.violations).toEqual([]);
  });

  it("desactivar: avisa al servidor (DELETE con el endpoint) y quita la suscripción del navegador", async () => {
    const b = fakeBrowser({ subscribed: true, permission: "granted" });
    const t = await openAccount();
    await screen.findByText("Los avisos están activados en este dispositivo.");
    await t.user.click(screen.getByRole("button", { name: "Desactivar avisos" }));

    expect(await screen.findByRole("button", { name: "Activar avisos" })).toBeInTheDocument();
    expect(pushPosts(t.log).map((r) => [r.method, r.body])).toEqual([["DELETE", { endpoint: ENDPOINT }]]);
    expect(b.sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(t.violations).toEqual([]);
  });

  it("si el doctor NO da permiso, lo dice y no registra nada", async () => {
    const b = fakeBrowser({ answer: "denied" });
    const t = await openAccount();
    await t.user.click(await screen.findByRole("button", { name: "Activar avisos" }));
    expect(await screen.findByText("No diste permiso para mostrar notificaciones.")).toBeInTheDocument();
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushPosts(t.log)).toHaveLength(0);
    // el navegador ahora los tiene bloqueados: la pantalla lo explica
    expect(await screen.findByText(/Las notificaciones están bloqueadas para este sitio/)).toBeInTheDocument();
  });

  it("notificaciones ya bloqueadas en el navegador: explica cómo desbloquearlas y no ofrece activar", async () => {
    fakeBrowser({ permission: "denied" });
    await openAccount();
    expect(await screen.findByText(/Las notificaciones están bloqueadas para este sitio/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activar avisos" })).toBeNull();
  });

  it("si el navegador no logra suscribir (servicio de push caído) lo dice con su motivo", async () => {
    fakeBrowser({ subscribeFails: true });
    const t = await openAccount();
    await t.user.click(await screen.findByRole("button", { name: "Activar avisos" }));
    expect(await screen.findByText(/No se pudo suscribir este dispositivo: Registration failed/)).toBeInTheDocument();
    expect(pushPosts(t.log)).toHaveLength(0);
  });

  it("si el servidor no registra la suscripción, lo dice y NO deja el dispositivo a medias (se deshace); reintentar funciona sin volver a pedir permiso", async () => {
    const b = fakeBrowser();
    const t = await openAccount();
    t.mock.controls.failNext(1, 503);
    await t.user.click(await screen.findByRole("button", { name: "Activar avisos" }));
    expect(await screen.findByText(/El servidor tuvo un problema/)).toBeInTheDocument();
    expect(b.sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Los avisos están activados en este dispositivo.")).toBeNull();

    // un 5xx deja la app en «sin conexión»; la sonda de conexión la recupera sola y el botón vuelve a servir
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Activar avisos" })).toBeEnabled());
    await t.user.click(await screen.findByRole("button", { name: "Activar avisos" }));
    expect(await screen.findByText("Los avisos están activados en este dispositivo.")).toBeInTheDocument();
    expect(b.pushManager.subscribe).toHaveBeenCalledTimes(2);
    expect(b.Notification.requestPermission).toHaveBeenCalledTimes(2); // el navegador ya la concedió: no vuelve a preguntar
    expect(pushPosts(t.log).filter((r) => r.method === "POST")).toHaveLength(2);
  });

  it("sin conexión no se puede activar ni desactivar (necesita registrarse en el servidor)", async () => {
    fakeBrowser();
    const t = await openAccount();
    await screen.findByRole("button", { name: "Activar avisos" });
    setBrowserOnline(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Activar avisos" })).toBeDisabled());
    expect(screen.getAllByText(/Sin conexión: esto necesita internet/).length).toBeGreaterThan(0);
    expect(pushPosts(t.log)).toHaveLength(0);
  });
});

describe("avisos push: lo que no se puede en cada dispositivo", () => {
  it("iPhone en Safari (app sin instalar): explica que solo funciona con la app instalada (iOS 16.4+) y cómo instalarla; sin botón", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: IPHONE_UA });
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", KEY);
    await openAccount();
    expect(await screen.findByText(/En iPhone y iPad los avisos solo funcionan con la app instalada en la pantalla de inicio \(iOS o iPadOS 16\.4 o superior\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activar avisos" })).toBeNull();
    // y la tarjeta de instalación da los pasos de Safari
    expect(within(screen.getByRole("region", { name: "Instalar la app" })).getByText(/Añadir a pantalla de inicio/)).toBeInTheDocument();
    // siempre queda dicho en la pantalla, también donde sí se puede
    expect(screen.getByText(/En iPhone y iPad solo funciona con la app instalada .* \(iOS 16\.4 o superior\)/)).toBeInTheDocument();
  });

  it("iPhone con la app instalada sí ofrece activar los avisos", async () => {
    fakeBrowser();
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: IPHONE_UA });
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    await openAccount();
    expect(await screen.findByRole("button", { name: "Activar avisos" })).toBeEnabled();
    expect(screen.getByText("La app ya está instalada en este dispositivo.")).toBeInTheDocument();
  });

  it("sin clave VAPID configurada dice que los avisos aún no están listos en el servidor", async () => {
    fakeBrowser();
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", "");
    await openAccount();
    expect(await screen.findByText(/todavía no están configurados en el servidor/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activar avisos" })).toBeNull();
  });

  it("navegador sin service worker (o sin push) lo dice", async () => {
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", KEY);
    await openAccount();
    expect(await screen.findByText(/no tiene \(o aún no activó\) el servicio en segundo plano/)).toBeInTheDocument();
  });
});

describe("cerrar sesión suelta los avisos de este dispositivo", () => {
  it("avisa al servidor y quita la suscripción local antes de salir", async () => {
    const b = fakeBrowser({ subscribed: true, permission: "granted" });
    const t = await openAccount();
    await screen.findByText("Los avisos están activados en este dispositivo.");
    await t.user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(pushPosts(t.log).map((r) => [r.method, r.body])).toEqual([["DELETE", { endpoint: ENDPOINT }]]);
    expect(b.sub.unsubscribe).toHaveBeenCalledTimes(1);
    // el DELETE va ANTES del cierre de sesión (después ya no habría sesión para autorizarlo)
    const order = t.log.map((r) => `${r.method} ${r.path}`);
    expect(order.indexOf("DELETE /api/doctor/push-subscriptions")).toBeLessThan(order.indexOf("POST /api/auth/logout"));
  });

  it("sin conexión igual cierra sesión y quita la suscripción local", async () => {
    const b = fakeBrowser({ subscribed: true, permission: "granted" });
    const t = await openAccount();
    await screen.findByText("Los avisos están activados en este dispositivo.");
    t.mock.controls.setOffline(true);
    await t.user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("form", { name: "Iniciar sesión" })).toBeInTheDocument();
    expect(b.sub.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
