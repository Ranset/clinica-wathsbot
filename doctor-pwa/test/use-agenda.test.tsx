import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createApiClient } from "@clinica/api-client";
import { createMockApi } from "@clinica/api-client/mock";
import { contractFetch } from "../../shared/api-client/test/spec";
import { ApiProvider } from "../src/api-context";
import { AuthProvider, useAuth } from "../src/auth";
import { ConnectionProvider, useConnection } from "../src/lib/connection";
import { useAgenda, type AgendaQuery } from "../src/pages/agenda/use-agenda";
import { account, freezeClock, sleep, storedKeys } from "./helpers";

beforeEach(freezeClock);

const WEEK: AgendaQuery = { from: "2026-11-09T05:00:00.000Z", to: "2026-11-16T05:00:00.000Z" };

/** Solo monta lo de adentro cuando la sesión ya está confirmada (igual que la app: nunca hay pantallas sin usuario). */
function WaitAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  return state.status === "authenticated" ? <>{children}</> : null;
}

async function setup(opts: { intervalMs?: number; coalesceMs?: number } = {}) {
  const mock = createMockApi({ now: () => new Date() });
  const cf = contractFetch(mock.fetch);
  /** El estado HTTP de cada consulta de MI agenda: 200 trae datos, 304 no. */
  const statuses: number[] = [];
  const sent: (string | null)[] = [];
  const spy = async (url: string, init?: RequestInit) => {
    const res = await cf.fetch(url, init);
    if (url.startsWith("/api/doctor/appointments?")) {
      statuses.push(res.status);
      sent.push(new Headers(init?.headers).get("If-None-Match"));
    }
    return res;
  };
  const api = createApiClient({ fetch: spy });
  await api.auth.login(account("doctor").email, account("doctor").password);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={api}>
      <ConnectionProvider>
        <AuthProvider>
          <WaitAuth>{children}</WaitAuth>
        </AuthProvider>
      </ConnectionProvider>
    </ApiProvider>
  );
  const mount = (query: AgendaQuery | null = WEEK) =>
    renderHook(({ q }: { q: AgendaQuery | null }) => ({ agenda: useAgenda(q, opts), conn: useConnection() }), { wrapper, initialProps: { q: query } });
  return { mock, statuses, sent, violations: cf.violations, mount };
}

const setVisibility = (state: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
afterEach(() => setVisibility("visible"));

describe("useAgenda: refresco con ETag (mi agenda)", () => {
  it("la primera consulta trae datos (200); las siguientes preguntan con If-None-Match y reciben 304 sin tocar el estado", async () => {
    const { mount, statuses, sent, violations } = await setup({ intervalMs: 40, coalesceMs: 5 });
    const { result } = mount();
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    const first = result.current.agenda.bookings;
    expect(first.length).toBeGreaterThan(0);

    await waitFor(() => expect(statuses.length).toBeGreaterThanOrEqual(4));
    expect(statuses[0]).toBe(200);
    expect(statuses.slice(1).every((s) => s === 304)).toBe(true);
    expect(sent[0]).toBeNull();
    expect(sent[1]).toMatch(/^W\/"[0-9a-f]{8}"$/);
    // un 304 no cambia la lista: es el MISMO arreglo, la rejilla no se repinta
    expect(result.current.agenda.bookings).toBe(first);
    expect(result.current.agenda.error).toBeNull();
    expect(result.current.agenda.stale).toBe(false);
    expect(violations).toEqual([]);
  });

  it("el doctor solo ve SUS citas y sin teléfono: patient.id es el id de la cita", async () => {
    const { mount } = await setup({ intervalMs: 60_000 });
    const { result } = mount();
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    const list = result.current.agenda.bookings;
    expect(list.every((b) => b.doctor?.id === "d1")).toBe(true);
    for (const b of list) {
      expect(b.patient).not.toBeNull();
      expect(b.patient).not.toHaveProperty("phone");
      expect(b.patient!.id).toBe(b.id);
    }
    expect(JSON.stringify(list)).not.toMatch(/52998/);
  });

  it("cuando el servidor cambia (una cita del bot), la siguiente consulta trae 200 y la lista nueva", async () => {
    const { mount, mock, statuses } = await setup({ intervalMs: 40, coalesceMs: 5 });
    const { result } = mount();
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    const before = result.current.agenda.bookings;
    await waitFor(() => expect(statuses.includes(304)).toBe(true));

    const made = mock.simulateBotBooking({ doctorId: "d1", patientName: "Paciente Del Bot" })!;
    // el simulador agenda en el primer hueco libre (hoy mismo, con 60 min de antelación): cae dentro de esta semana
    expect(made.scheduledAtUtc >= WEEK.from && made.scheduledAtUtc < WEEK.to).toBe(true);
    await waitFor(() => expect(result.current.agenda.bookings.some((b) => b.id === made.id)).toBe(true));
    expect(result.current.agenda.bookings).not.toBe(before);
    expect(result.current.agenda.bookings).toHaveLength(before.length + 1);
    // y es la versión SIN teléfono: el doctor nunca recibe el del paciente
    expect(result.current.agenda.bookings.find((b) => b.id === made.id)!.patient).toEqual({ id: made.id, name: "Paciente Del Bot" });
  });

  it("varios avisos seguidos se juntan en UNA sola consulta (coalesce), también al volver la red", async () => {
    const { mount, statuses } = await setup({ intervalMs: 60_000, coalesceMs: 30 });
    const { result } = mount();
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    await sleep(40);
    expect(statuses).toHaveLength(1);

    act(() => {
      for (let i = 0; i < 6; i++) result.current.agenda.refresh();
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await sleep(150);
    expect(statuses).toHaveLength(2);
    expect(statuses[1]).toBe(304);
  });

  it("al cambiar de semana no se queda con datos de la anterior, y al volver NO usa un ETag viejo suelto", async () => {
    const { mount, statuses, sent } = await setup({ intervalMs: 60_000, coalesceMs: 5 });
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    const week = result.current.agenda.bookings;

    const next: AgendaQuery = { from: "2026-11-16T05:00:00.000Z", to: "2026-11-23T05:00:00.000Z" };
    rerender({ q: next });
    expect(result.current.agenda.ready).toBe(false);
    expect(result.current.agenda.bookings).toEqual([]); // nada de la semana anterior mientras llega la nueva
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    expect(result.current.agenda.bookings.every((b) => b.scheduledAtUtc >= next.from)).toBe(true);

    // Volver: la copia guardada de esa semana se ve al instante (sin esperar a la red)…
    rerender({ q: WEEK });
    expect(result.current.agenda.ready).toBe(true);
    expect(result.current.agenda.bookings).toEqual(week);
    expect(result.current.agenda.stale).toBe(true); // …pero aún sin confirmar
    // …y se confirma con su propio ETag (304), no con el de la otra semana.
    await waitFor(() => expect(result.current.agenda.stale).toBe(false));
    expect(sent[0]).toBeNull();
    expect(sent[1]).toBeNull(); // la otra semana nunca se había pedido
    expect(sent[2]).toMatch(/^W\/"/);
    expect(statuses).toEqual([200, 200, 304]);
  });

  it("con la pestaña oculta no consulta; al volver, consulta de inmediato", async () => {
    const { mount, statuses } = await setup({ intervalMs: 30, coalesceMs: 5 });
    const { result } = mount();
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    setVisibility("hidden");
    await sleep(40); // deja terminar lo que estaba en vuelo
    const quiet = statuses.length;
    await sleep(150);
    expect(statuses.length).toBe(quiet);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(statuses.length).toBeGreaterThan(quiet));
  });

  it("sin consulta (null) no pide nada", async () => {
    const { mount, statuses } = await setup({ intervalMs: 20, coalesceMs: 5 });
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    rerender({ q: null });
    await sleep(30);
    const n = statuses.length;
    await sleep(100);
    expect(statuses.length).toBe(n);
    expect(result.current.agenda.ready).toBe(false);
  });
});

describe("useAgenda: sin conexión (solo lectura con la última copia)", () => {
  it("sin conexión conserva lo que ya tenía, lo marca como no confirmado y avisa; al volver la red se recupera solo", async () => {
    const { mount, mock } = await setup({ intervalMs: 40, coalesceMs: 5 });
    const { result } = mount();
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    await waitFor(() => expect(result.current.agenda.stale).toBe(false));
    const kept = result.current.agenda.bookings;
    const syncedBefore = result.current.agenda.syncedAt!;

    mock.controls.setOffline(true);
    await waitFor(() => expect(result.current.agenda.error).toMatch(/No hay conexión/));
    expect(result.current.agenda.ready).toBe(true);
    expect(result.current.agenda.stale).toBe(true);
    expect(result.current.agenda.bookings).toBe(kept);
    // «última sincronización» no avanza mientras no haya servidor
    expect(result.current.agenda.syncedAt).toEqual(syncedBefore);
    // y la conexión global lo sabe: de ahí sale «solo lectura»
    await waitFor(() => expect(result.current.conn.online).toBe(false));

    mock.controls.setOffline(false);
    await waitFor(() => expect(result.current.agenda.error).toBeNull());
    expect(result.current.agenda.stale).toBe(false);
    await waitFor(() => expect(result.current.conn.online).toBe(true));
  });

  it("un 5xx (página de error del hosting) cuenta igual: se queda con lo que tenía y se recupera", async () => {
    const { mount, mock } = await setup({ intervalMs: 40, coalesceMs: 5 });
    const { result } = mount();
    await waitFor(() => expect(result.current.agenda.ready).toBe(true));
    mock.controls.failNext(1, 503);
    await waitFor(() => expect(result.current.agenda.error).toMatch(/problema/));
    await waitFor(() => expect(result.current.agenda.error).toBeNull());
    expect(result.current.agenda.bookings.length).toBeGreaterThan(0);
  });

  it("la agenda queda guardada en el dispositivo; al abrir sin red se ve la copia al instante con su hora de sincronización", async () => {
    const { mount, mock } = await setup({ intervalMs: 60_000, coalesceMs: 5 });
    const first = mount();
    await waitFor(() => expect(first.result.current.agenda.ready).toBe(true));
    await waitFor(() => expect(first.result.current.agenda.stale).toBe(false));
    const saved = first.result.current.agenda.bookings;
    const syncedAt = first.result.current.agenda.syncedAt!;
    expect(storedKeys().some((k) => k.includes(":agenda:"))).toBe(true);
    first.unmount();

    // «Se cierra la app y se vuelve a abrir en un túnel»: ya no hay red.
    mock.controls.setOffline(true);
    const second = mount();
    // la app abre con la sesión recordada (el servidor no contesta); en cuanto aparece la pantalla ya hay agenda: la copia,
    // marcada como no confirmada y con la hora de la última vez que el servidor la confirmó
    await waitFor(() => expect(second.result.current).not.toBeNull());
    expect(second.result.current.agenda.ready).toBe(true);
    expect(second.result.current.agenda.bookings).toEqual(saved);
    expect(second.result.current.agenda.stale).toBe(true);
    expect(second.result.current.agenda.syncedAt!.getTime()).toBeGreaterThanOrEqual(syncedAt.getTime() - 1);
    await waitFor(() => expect(second.result.current.agenda.error).toMatch(/No hay conexión/));
    expect(second.result.current.agenda.bookings).toEqual(saved); // el error NO borra lo que se ve
  });

  it("al volver la red, la copia se confirma con el ETag guardado: el servidor responde 304 y no se baja nada", async () => {
    const { mount, mock, statuses, sent } = await setup({ intervalMs: 60_000, coalesceMs: 5 });
    const first = mount();
    await waitFor(() => expect(first.result.current.agenda.stale).toBe(false));
    first.unmount();
    expect(statuses).toEqual([200]);

    mock.controls.setOffline(true);
    const second = mount();
    await waitFor(() => expect(second.result.current?.agenda.error).toBeTruthy());
    mock.controls.setOffline(false);
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(second.result.current.agenda.stale).toBe(false));
    expect(statuses.at(-1)).toBe(304);
    expect(sent.at(-1)).toMatch(/^W\/"[0-9a-f]{8}"$/);
  });

  it("sin copia de ese rango y sin red: no hay agenda (ready=false) y se dice por qué", async () => {
    const { mount, mock } = await setup({ intervalMs: 60_000, coalesceMs: 5 });
    // se abre otra semana con red (así el dispositivo recuerda la sesión), y luego se pide una semana que nunca se bajó, sin red
    const other: AgendaQuery = { from: "2026-11-23T05:00:00.000Z", to: "2026-11-30T05:00:00.000Z" };
    const online = mount(other);
    await waitFor(() => expect(online.result.current.agenda.stale).toBe(false));
    online.unmount();

    mock.controls.setOffline(true);
    const { result } = mount();
    await waitFor(() => expect(result.current).not.toBeNull());
    await waitFor(() => expect(result.current.agenda.error).toMatch(/No hay conexión/));
    expect(result.current.agenda.ready).toBe(false);
    expect(result.current.agenda.bookings).toEqual([]);
  });
});
