import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, isAbortError } from "../src";

type Call = { url: string; method: string; headers: Headers; body: unknown };

/** Un `fetch` de mentira: responde lo que se le programa y anota lo que recibe. */
function stub(...replies: (Response | Error | ((c: Call) => Response))[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next.clone();
  });
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const SESSION = { user: { id: "u1", email: "a@b.test", name: "A", role: "staff", doctorId: null, active: true }, csrfToken: "tok-1" };

describe("CSRF y cabeceras", () => {
  it("manda X-CSRF-Token solo en los metodos que escriben, y solo despues de tenerlo", async () => {
    const { fetch, calls } = stub(json(SESSION), json({ items: [] }), json({ active: true }), json({ active: false }), new Response(null, { status: 204 }));
    const api = createApiClient({ fetch });

    await api.auth.login("a@b.test", "x");
    expect(calls[0]!.headers.get("X-CSRF-Token")).toBeNull(); // login: aun no hay token

    await api.rooms.list(); // GET
    await api.bot.get(); // GET
    await api.bot.set(false); // PUT
    await api.doctors.absences.remove("d1", "a1"); // DELETE

    expect(calls[1]!.headers.get("X-CSRF-Token")).toBeNull();
    expect(calls[2]!.headers.get("X-CSRF-Token")).toBeNull();
    expect(calls[3]!.headers.get("X-CSRF-Token")).toBe("tok-1");
    expect(calls[4]!.headers.get("X-CSRF-Token")).toBe("tok-1");
  });

  it("me() renueva el token y logout() lo borra aunque el servidor falle", async () => {
    const { fetch, calls } = stub(json({ ...SESSION, csrfToken: "tok-2" }), json({ error: "no_autenticado" }, 401), json({ active: true }));
    const api = createApiClient({ fetch, csrfToken: "viejo" });
    await api.auth.me();
    expect(api.csrfToken).toBe("tok-2");
    await expect(api.auth.logout()).rejects.toBeInstanceOf(ApiError);
    expect(api.csrfToken).toBeNull();
    await api.bot.set(true);
    expect(calls[2]!.headers.has("X-CSRF-Token")).toBe(false);
  });

  it("Content-Type solo cuando hay cuerpo; siempre pide JSON", async () => {
    const { fetch, calls } = stub(json({ items: [] }), json({ active: true }));
    const api = createApiClient({ fetch, csrfToken: "t" });
    await api.users.list();
    await api.bot.set(true);
    expect(calls[0]!.headers.get("Content-Type")).toBeNull();
    expect(calls[0]!.headers.get("Accept")).toBe("application/json");
    expect(calls[1]!.headers.get("Content-Type")).toBe("application/json");
    expect(calls[1]!.body).toEqual({ active: true });
  });
});

describe("rutas y consultas", () => {
  it("escapa los parametros de ruta y omite los de consulta vacios", async () => {
    const { fetch, calls } = stub(json({ items: [] }), json({ id: "b/1" }));
    const api = createApiClient({ fetch, baseUrl: "https://clinica.test" });
    await api.attention.list("open");
    await api.appointments.get("b/1");
    expect(calls[0]!.url).toBe("https://clinica.test/api/attention?status=open");
    expect(calls[1]!.url).toBe("https://clinica.test/api/appointments/b%2F1");

    const s2 = stub(json({ items: [], serverTimeUtc: "x" }));
    await createApiClient({ fetch: s2.fetch }).appointments.list({ from: "2026-11-09T05:00:00.000Z", to: "2026-11-16T05:00:00.000Z", doctorId: undefined });
    expect(s2.calls[0]!.url).toBe("/api/appointments?from=2026-11-09T05%3A00%3A00.000Z&to=2026-11-16T05%3A00%3A00.000Z");
  });

  it("devuelve las listas { items } ya como arreglo", async () => {
    const { fetch } = stub(json({ items: [{ id: "r1", name: "Consultorio 1" }] }));
    expect(await createApiClient({ fetch }).rooms.list()).toEqual([{ id: "r1", name: "Consultorio 1" }]);
  });
});

describe("errores", () => {
  it("convierte { error, detail } en ApiError y conserva los campos extra", async () => {
    const body = { error: "horario_ocupado", detail: "Ya hay una cita", horarios: ["2026-11-12T10:00-05:00"] };
    const api = createApiClient({ fetch: stub(json(body, 409)).fetch });
    const err = await api.appointments.create({ scheduledAtUtc: "2026-11-12T15:00:00.000Z" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "horario_ocupado", detail: "Ya hay una cita", isConflict: true, isRuleError: false });
    expect(err.body).toEqual(body);
  });

  it("una pagina de error que no es JSON es 'desconocido' (y 5xx es transitorio)", async () => {
    const html = new Response("<h1>Bad gateway</h1>", { status: 502, headers: { "Content-Type": "text/html" } });
    const err = await createApiClient({ fetch: stub(html).fetch }).rooms.list().catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: "desconocido", isTransient: true });
  });

  it("un 200 que no es JSON es 'respuesta_invalida'", async () => {
    const html = new Response("<html>login del hosting</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const err = await createApiClient({ fetch: stub(html).fetch }).rooms.list().catch((e) => e);
    expect(err).toMatchObject({ code: "respuesta_invalida", status: 200 });
  });

  it("sin red es 'red' con status 0; una cancelacion se deja pasar tal cual", async () => {
    const down = await createApiClient({ fetch: stub(new TypeError("Failed to fetch")).fetch }).rooms.list().catch((e) => e);
    expect(down).toMatchObject({ status: 0, code: "red", isTransient: true });

    const abort = new DOMException("Aborted", "AbortError");
    const cancelled = await createApiClient({ fetch: stub(abort).fetch }).rooms.list().catch((e) => e);
    expect(isAbortError(cancelled)).toBe(true);
    expect(cancelled).not.toBeInstanceOf(ApiError);
  });

  it("avisa del 401 a quien escuche, salvo en login() y me() (ahi es una respuesta esperada)", async () => {
    const api = createApiClient({ fetch: stub(json({ error: "no_autenticado" }, 401)).fetch });
    const seen = vi.fn();
    const off = api.onUnauthenticated(seen);

    await api.auth.me().catch(() => {});
    await api.auth.login("a@b.test", "mal").catch(() => {});
    expect(seen).not.toHaveBeenCalled();

    await api.rooms.list().catch(() => {});
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0]).toMatchObject({ status: 401, code: "no_autenticado" });

    off();
    await api.rooms.list().catch(() => {});
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("ETag y 304", () => {
  const range = { from: "2026-11-09T05:00:00.000Z", to: "2026-11-16T05:00:00.000Z" };

  it("sin etag pide todo y devuelve el ETag nuevo", async () => {
    const list = { items: [], serverTimeUtc: "2026-11-10T15:00:00.000Z" };
    const { fetch, calls } = stub(json(list, 200, { ETag: 'W/"abc"' }));
    const r = await createApiClient({ fetch }).appointments.list(range);
    expect(calls[0]!.headers.has("If-None-Match")).toBe(false);
    expect(r).toEqual({ notModified: false, data: list, etag: 'W/"abc"' });
  });

  it("con etag manda If-None-Match y un 304 vuelve como notModified conservando el etag", async () => {
    const { fetch, calls } = stub(new Response(null, { status: 304 }));
    const r = await createApiClient({ fetch }).appointments.list(range, { etag: 'W/"abc"' });
    expect(calls[0]!.headers.get("If-None-Match")).toBe('W/"abc"');
    expect(r).toEqual({ notModified: true, etag: 'W/"abc"' });
  });

  it("si el servidor cambio, un 200 trae datos y etag nuevos", async () => {
    const list = { items: [{ id: "b9" }], serverTimeUtc: "x" };
    const { fetch } = stub(json(list, 200, { ETag: 'W/"def"' }));
    const r = await createApiClient({ fetch }).doctorSelf.appointments(range, { etag: 'W/"abc"' });
    expect(r).toMatchObject({ notModified: false, etag: 'W/"def"' });
  });
});
