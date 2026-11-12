import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
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

/**
 * Monta la web completa contra la API simulada. Cada peticion pasa por el validador
 * de contrato: si la pantalla manda algo que `docs/openapi.yaml` no permite, o el
 * simulador responde algo fuera del contrato, `violations` lo dice.
 *
 * - `as`: ya con sesion abierta (se salta el login). `null`: sin sesion.
 * - `hash`: pantalla inicial.
 * - `prepare`: deja la base simulada como hace falta ANTES de montar la web (la lista de doctores se pide una vez al abrir).
 */
export async function mountApp({ as = "staff", hash = "#/calendario", prepare }: { as?: Role | null; hash?: string; prepare?: (mock: MockApi) => void } = {}) {
  const mock = createMockApi({ now: () => new Date() });
  prepare?.(mock);
  const cf = contractFetch(mock.fetch);
  const api = createApiClient({ fetch: cf.fetch });
  if (as) await api.auth.login(account(as).email, account(as).password);
  window.location.hash = hash;
  const user = userEvent.setup();
  const view = render(<App api={api} />);
  return { mock, api, user, violations: cf.violations, ...view };
}

/** El dia (AAAA-MM-DD) de un instante UTC en Cancun (UTC-5 todo el ano). */
export const localDay = (utc: string) => new Date(Date.parse(utc) - 5 * 3600_000).toISOString().slice(0, 10);

/** Una cita agendada de ese dia (opcionalmente de un doctor), para no depender de nombres fijos del seed. `nth` ordena por hora. */
export function pickBooking(mock: MockApi, day: string, opts: { doctorId?: string; nth?: number } = {}): Booking {
  const list = mock.db.bookings
    .filter((b) => b.kind === "session" && b.status === "agendada" && localDay(b.scheduledAtUtc) === day && (!opts.doctorId || b.doctor?.id === opts.doctorId))
    .sort((a, b) => a.scheduledAtUtc.localeCompare(b.scheduledAtUtc));
  const found = list[opts.nth ?? 0];
  if (!found) throw new Error(`No hay cita de ejemplo el ${day}`);
  return found;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** El bloque de la cita en la rejilla (su nombre accesible empieza con el paciente). */
export const bookingButton = (b: Booking) => screen.findByRole("button", { name: new RegExp(`^${esc(b.patient!.name)},`) });
