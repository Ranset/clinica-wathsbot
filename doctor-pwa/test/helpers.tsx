import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { createApiClient, type Booking, type Role } from "@clinica/api-client";
import { DEMO_ACCOUNTS, createMockApi, type MockApi } from "@clinica/api-client/mock";
import { contractFetch } from "../../shared/api-client/test/spec";
import { App } from "../src/app";

/** "Ahora" de todas las pruebas: martes 2026-11-10, 10:00 en Cancun. Solo se congela `Date`; los temporizadores corren normal. */
export const NOW = new Date("2026-11-10T15:00:00Z");

export function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}

export const account = (role: Role) => DEMO_ACCOUNTS.find((a) => a.role === role)!;

/** El código de 4 dígitos y la contraseña con los que entra el doctor de ejemplo. */
export const doctorCredentials = () => {
  const a = account("doctor");
  return { code: a.doctorCode!, password: a.password };
};

/** Llena la pantalla de entrada como lo haría el doctor (espera a que cargue la lista, escribe el código y la contraseña) y pulsa «Entrar». */
export async function signIn(user: UserEvent, who: { code: string; password: string } = doctorCredentials()) {
  const combo = await screen.findByRole("combobox", { name: "Usuario" });
  await waitFor(() => expect(combo).toBeEnabled());
  await user.type(combo, who.code); // un código completo se elige solo
  await user.type(screen.getByLabelText("Contraseña"), who.password);
  await user.click(screen.getByRole("button", { name: "Entrar" }));
}

export type Logged = { method: string; path: string; body: unknown };

/**
 * Un "servidor" simulado con su cliente de la API: cada peticion pasa por el validador de contrato (si la
 * pantalla manda algo que `docs/openapi.yaml` no permite, o el simulador responde fuera del contrato,
 * `violations` lo dice) y queda en `log`.
 */
export function makeServer(opts: { /** Rutas que "no contestan" (la peticion falla como sin red), p. ej. solo `/api/branding`. */ fail?: (path: string) => boolean } = {}) {
  const mock = createMockApi({ now: () => new Date() });
  const cf = contractFetch(mock.fetch);
  const log: Logged[] = [];
  const spy = async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://mock.local");
    log.push({ method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined });
    if (opts.fail?.(u.pathname)) throw new TypeError("Failed to fetch");
    return cf.fetch(url, init);
  };
  const api = createApiClient({ fetch: spy });
  return { mock, api, log, violations: cf.violations };
}

/**
 * Monta la app completa contra la API simulada.
 * - `as`: ya con sesion abierta (se salta el login). `null`: sin sesion.
 * - `hash`: pantalla inicial.
 * - `server`: reutiliza un servidor (para "cerrar y volver a abrir la app" con el mismo servidor y el mismo dispositivo).
 */
export async function mountApp({ as = "doctor", hash = "#/hoy", server = makeServer() }: { as?: Role | null; hash?: string; server?: ReturnType<typeof makeServer> } = {}) {
  if (as) await server.api.auth.login(account(as).email, account(as).password);
  window.location.hash = hash;
  const user = userEvent.setup();
  const view = render(<App api={server.api} />);
  return { ...server, user, ...view };
}

/** Un doctor logueado (por `mountApp` o por el cliente) tiene este id de usuario en las claves guardadas. */
export const storedKeys = (): string[] => {
  const out: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) out.push(window.localStorage.key(i)!);
  return out.filter((k) => k.startsWith("clinica-doctor:"));
};

/** El dia (AAAA-MM-DD) de un instante UTC en Cancun (UTC-5 todo el ano). */
export const localDay = (utc: string) => new Date(Date.parse(utc) - 5 * 3600_000).toISOString().slice(0, 10);

/** Una cita agendada de ese dia del doctor d1 (el de la cuenta de ejemplo), para no depender de nombres fijos del seed. */
export function pickBooking(mock: MockApi, day: string, nth = 0): Booking {
  const list = mock.db.bookings
    .filter((b) => b.kind === "session" && b.status === "agendada" && b.doctor?.id === "d1" && localDay(b.scheduledAtUtc) === day)
    .sort((a, b) => a.scheduledAtUtc.localeCompare(b.scheduledAtUtc));
  const found = list[nth];
  if (!found) throw new Error(`No hay cita de ejemplo de d1 el ${day}`);
  return found;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** El bloque de la cita en la rejilla (su nombre accesible empieza con el paciente). */
export const bookingButton = (b: Booking) => screen.findByRole("button", { name: new RegExp(`^${esc(b.patient!.name)},`) });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simula lo que hace el navegador con `navigator.onLine` y sus eventos. */
export function setBrowserOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}
