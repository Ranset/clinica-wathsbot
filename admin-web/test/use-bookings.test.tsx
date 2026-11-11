import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createApiClient } from "@clinica/api-client";
import { createMockApi } from "@clinica/api-client/mock";
import { contractFetch } from "../../shared/api-client/test/spec";
import { ApiProvider } from "../src/api-context";
import { useBookings, type BookingsQuery } from "../src/pages/calendar/use-bookings";
import { account, freezeClock } from "./helpers";

beforeEach(freezeClock);

const WEEK: BookingsQuery = { from: "2026-11-09T05:00:00.000Z", to: "2026-11-16T05:00:00.000Z" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(opts: { intervalMs?: number; coalesceMs?: number } = {}) {
  const mock = createMockApi({ now: () => new Date() });
  const cf = contractFetch(mock.fetch);
  /** El estado HTTP de cada consulta de citas: 200 trae datos, 304 no. */
  const statuses: number[] = [];
  const sent: (string | null)[] = [];
  const spy = async (url: string, init?: RequestInit) => {
    const res = await cf.fetch(url, init);
    if (url.startsWith("/api/appointments?")) {
      statuses.push(res.status);
      sent.push(new Headers(init?.headers).get("If-None-Match"));
    }
    return res;
  };
  const api = createApiClient({ fetch: spy });
  await api.auth.login(account("staff").email, account("staff").password);
  const wrapper = ({ children }: { children: ReactNode }) => <ApiProvider api={api}>{children}</ApiProvider>;
  const hook = renderHook(({ q }: { q: BookingsQuery | null }) => useBookings(q, opts), { wrapper, initialProps: { q: WEEK as BookingsQuery | null } });
  return { mock, statuses, sent, violations: cf.violations, ...hook };
}

const setVisibility = (state: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
afterEach(() => setVisibility("visible"));

describe("useBookings: refresco con ETag", () => {
  it("la primera consulta trae datos (200); las siguientes preguntan con If-None-Match y reciben 304 sin tocar el estado", async () => {
    const { result, statuses, sent, violations } = await setup({ intervalMs: 40, coalesceMs: 5 });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const first = result.current.bookings;
    expect(first.length).toBeGreaterThan(0);

    await waitFor(() => expect(statuses.length).toBeGreaterThanOrEqual(4));
    expect(statuses[0]).toBe(200);
    expect(statuses.slice(1).every((s) => s === 304)).toBe(true);
    expect(sent[0]).toBeNull();
    expect(sent[1]).toMatch(/^W\/"[0-9a-f]{8}"$/);
    // un 304 no cambia la lista: es el MISMO arreglo, la rejilla no se repinta
    expect(result.current.bookings).toBe(first);
    expect(result.current.error).toBeNull();
    expect(violations).toEqual([]);
  });

  it("cuando el servidor cambia (una cita del bot), la siguiente consulta trae 200 y la lista nueva", async () => {
    const { result, mock, statuses } = await setup({ intervalMs: 40, coalesceMs: 5 });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const before = result.current.bookings;
    await waitFor(() => expect(statuses.includes(304)).toBe(true));

    const made = mock.simulateBotBooking({ doctorId: "d4", patientName: "Paciente Del Bot" })!;
    await waitFor(() => expect(result.current.bookings.some((b) => b.id === made.id)).toBe(true));
    expect(result.current.bookings).not.toBe(before);
    expect(result.current.bookings).toHaveLength(before.length + 1);
    expect(statuses.at(-1) === 200 || statuses.includes(200)).toBe(true);
  });

  it("varios avisos seguidos se juntan en UNA sola consulta (coalesce)", async () => {
    const { result, statuses } = await setup({ intervalMs: 60_000, coalesceMs: 30 });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(statuses).toHaveLength(1);

    act(() => {
      for (let i = 0; i < 6; i++) result.current.refresh();
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await sleep(150);
    expect(statuses).toHaveLength(2);
    expect(statuses[1]).toBe(304);
  });

  it("al cambiar de rango no se queda con datos del anterior, y al volver NO usa un ETag viejo (si no, quedaria sin datos)", async () => {
    const { result, rerender, statuses, sent } = await setup({ intervalMs: 60_000, coalesceMs: 5 });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const week = result.current.bookings;

    const next: BookingsQuery = { from: "2026-11-16T05:00:00.000Z", to: "2026-11-23T05:00:00.000Z" };
    rerender({ q: next });
    expect(result.current.ready).toBe(false);
    expect(result.current.bookings).toEqual([]); // nada del rango anterior mientras llega el nuevo
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.bookings.every((b) => b.scheduledAtUtc >= next.from)).toBe(true);

    rerender({ q: WEEK });
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.bookings).toEqual(week);
    // cada cambio de rango abrio con una consulta sin If-None-Match y 200
    expect(sent.filter((x) => x === null)).toHaveLength(3);
    expect(statuses).toEqual([200, 200, 200]);
  });

  it("con la pestana oculta no consulta; al volver, consulta de inmediato", async () => {
    const { result, statuses } = await setup({ intervalMs: 30, coalesceMs: 5 });
    await waitFor(() => expect(result.current.ready).toBe(true));
    setVisibility("hidden");
    await sleep(40); // deja terminar lo que estaba en vuelo
    const quiet = statuses.length;
    await sleep(150);
    expect(statuses.length).toBe(quiet);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(statuses.length).toBeGreaterThan(quiet));
  });

  it("sin conexion conserva lo que ya tenia y avisa; al volver la red, se recupera solo", async () => {
    const { result, mock } = await setup({ intervalMs: 40, coalesceMs: 5 });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const kept = result.current.bookings;

    mock.controls.setOffline(true);
    await waitFor(() => expect(result.current.error).toMatch(/No hay conexión/));
    expect(result.current.ready).toBe(true);
    expect(result.current.bookings).toBe(kept);

    mock.controls.setOffline(false);
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("un error 5xx (pagina del hosting) tambien se muestra como error de servidor, sin tirar la pantalla", async () => {
    const { result, mock } = await setup({ intervalMs: 40, coalesceMs: 5 });
    await waitFor(() => expect(result.current.ready).toBe(true));
    mock.controls.failNext(1, 503);
    await waitFor(() => expect(result.current.error).toMatch(/problema/));
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.bookings.length).toBeGreaterThan(0);
  });

  it("sin consulta (null) no pide nada", async () => {
    const { result, rerender, statuses } = await setup({ intervalMs: 20, coalesceMs: 5 });
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ q: null });
    await sleep(30);
    const n = statuses.length;
    await sleep(100);
    expect(statuses.length).toBe(n);
    expect(result.current.ready).toBe(false);
  });
});
