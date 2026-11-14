import { todayInTz } from "@clinica/calendar/src/lib/slots";
import { readBytes } from "../image";
import type { Booking, Channel } from "../types";
import { buildRoutes } from "./handlers";
import { HttpError, forbidden, invalid, matchRoute, unauthorized, type Result, type Route } from "./http";
import { TZ, nextFreeSlot } from "./rules";
import { createSeededDb } from "./seed";
import { botBook, botCancel, botHandoff, botMine, botView, botWho } from "./bot";
import { doctorRef, nextId, type DB, type StoredUser } from "./state";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type MockApiOptions = {
  /** El reloj del servidor. Las pruebas lo fijan; por defecto, la hora real. */
  now?: () => Date;
  /** Retardo por peticion, para ver los estados de carga. 0 en pruebas. */
  latencyMs?: number;
  /** Donde recordar la sesion entre recargas (el equivalente a la cookie). Nulo: se pierde al recargar. */
  storage?: StorageLike | null;
  storageKey?: string;
};

/**
 * Un servidor de la clinica EN MEMORIA que habla el contrato de `docs/openapi.yaml`
 * (todo menos `/api/bot/*` y el webhook de Zernio): sesion + CSRF, roles, ETag/304,
 * errores 401/403/404/409/422/429 y las reglas de agenda (doctor y consultorio
 * libres, horario del doctor, ausencias, antelacion de 60 min, horizonte de 60
 * dias, alineacion a 30 min, transiciones de estado, mover sin perder la cita).
 *
 * Se usa como `fetch` del cliente: `createApiClient({ fetch: mock.fetch })`.
 * Una instancia = un navegador (una sola "cookie").
 */
export function createMockApi(options: MockApiOptions = {}) {
  const clock = options.now ?? (() => new Date());
  const storage = options.storage ?? null;
  const storageKey = options.storageKey ?? "clinica-mock-session";

  let db: DB = createSeededDb(clock());
  let routes: Route<StoredUser>[] = buildRoutes(db);
  let sessionId: string | null = null;
  let offline = false;
  let failures: { count: number; status: number } = { count: 0, status: 503 };
  let latencyMs = options.latencyMs ?? 0;
  let requests = 0;

  /* La "cookie": se restaura la sesion guardada si ese usuario sigue existiendo. */
  function restoreSession() {
    sessionId = null;
    if (!storage) return;
    try {
      const saved = JSON.parse(storage.getItem(storageKey) ?? "null") as { sid: string; userId: string } | null;
      if (saved && db.users.some((u) => u.id === saved.userId && u.active)) {
        db.sessions.set(saved.sid, { userId: saved.userId, csrfTokens: new Set() });
        sessionId = saved.sid;
      }
    } catch {
      /* almacenamiento bloqueado o corrupto: se empieza sin sesion */
    }
  }
  function persistSession() {
    if (!storage) return;
    try {
      const s = sessionId ? db.sessions.get(sessionId) : undefined;
      if (s) storage.setItem(storageKey, JSON.stringify({ sid: sessionId, userId: s.userId }));
      else storage.removeItem(storageKey);
    } catch {
      /* sin almacenamiento: la sesion dura hasta recargar */
    }
  }
  restoreSession();

  const abortError = () => new DOMException("The operation was aborted.", "AbortError");

  async function wait(ms: number, signal?: AbortSignal | null) {
    if (signal?.aborted) throw abortError();
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function dispatch(method: string, url: URL, headers: Headers, bodyText: string, rawBody: Uint8Array | null): Promise<Result> {
    const match = matchRoute(routes, method, url.pathname);
    if (!match) throw new HttpError(404, "no_encontrado", `El simulador no implementa ${method} ${url.pathname}.`);
    const { route, params } = match;

    let user: StoredUser | undefined;
    if (route.roles) {
      const session = sessionId ? db.sessions.get(sessionId) : undefined;
      user = session ? db.users.find((u) => u.id === session.userId && u.active) : undefined;
      if (!session || !user) throw unauthorized();
      if (!route.roles.includes(user.role)) throw forbidden();
      if (route.csrf) {
        const token = headers.get("X-CSRF-Token");
        if (!token || !session.csrfTokens.has(token)) throw forbidden("Falta el token CSRF o ya no es válido.");
      }
    }

    let body: unknown;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw invalid("El cuerpo no es JSON válido.");
      }
    }

    return route.handler({ params, query: url.searchParams, body, rawBody, headers, user: user as StoredUser, sessionId, now: clock() });
  }

  function toResponse(r: Result): Response {
    const headers = new Headers(r.headers);
    if (r.status === 204 || r.status === 304) return new Response(null, { status: r.status, headers });
    if (r.binary) {
      headers.set("Content-Type", r.binary.contentType);
      return new Response(r.binary.bytes as BodyInit, { status: r.status, headers });
    }
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(r.body ?? null), { status: r.status, headers });
  }

  /** El `fetch` del simulador: acepta lo mismo que el `fetch` del navegador (URL relativa o absoluta). */
  async function mockFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), "http://mock.local");
    const method = (init.method ?? req?.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? req?.headers);
    const signal = init.signal ?? req?.signal ?? null;
    const bodyText = typeof init.body === "string" ? init.body : "";
    // una imagen subida llega como bytes (no es JSON)
    let rawBody: Uint8Array | null = null;
    if (init.body instanceof Uint8Array) rawBody = init.body;
    else if (init.body instanceof ArrayBuffer) rawBody = new Uint8Array(init.body);
    else if (typeof Blob !== "undefined" && init.body instanceof Blob) rawBody = await readBytes(init.body);

    requests++;
    await wait(latencyMs, signal);
    if (offline) throw new TypeError("Failed to fetch");
    if (failures.count > 0) {
      failures.count--;
      return new Response("<html><body>Service Unavailable</body></html>", { status: failures.status, headers: { "Content-Type": "text/html" } });
    }

    try {
      const result = await dispatch(method, url, headers, bodyText, rawBody);
      if (result.setSession !== undefined) {
        if (result.setSession === null) {
          if (sessionId) db.sessions.delete(sessionId);
          sessionId = null;
        } else sessionId = result.setSession;
        persistSession();
      }
      return toResponse(result);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 401) {
          // Sesion vencida o inexistente: la "cookie" ya no sirve.
          if (sessionId && !db.sessions.has(sessionId)) sessionId = null;
        }
        return toResponse({ status: e.status, body: e.body() });
      }
      return toResponse({ status: 500, body: { error: "desconocido", detail: e instanceof Error ? e.message : String(e) } });
    }
  }

  /** Hace lo que haria el bot al agendar: una cita `source: "ai"` en el primer hueco libre del doctor. */
  function simulateBotBooking(
    opts: { doctorId?: string; patientName?: string; channel?: Channel; contactId?: string; contactPhone?: string } = {}
  ): Booking | null {
    const now = clock();
    const active = db.doctors.filter((d) => d.active);
    const doctor = opts.doctorId ? db.doctors.find((d) => d.id === opts.doctorId) : active[Math.floor(Math.random() * active.length)];
    if (!doctor) return null;
    // Sin canal: una persona de WhatsApp con un telefono inventado (lo de siempre). Con canal: la misma puerta que el bot de verdad
    // (identidad, `telefono_contacto` obligatorio fuera de WhatsApp...).
    const channel = opts.channel ?? "whatsapp";
    const phone = `52998${String(70000 + db.bookings.length).padStart(7, "0")}`;
    const who = botWho(channel === "whatsapp" ? { telefono: phone } : { canal: channel, contacto_id: opts.contactId });
    return botBook(db, now, who, {
      patientName: opts.patientName ?? (channel === "whatsapp" ? "Paciente WhatsApp Demo" : "Paciente Messenger Demo"),
      doctorId: doctor.id,
      contactPhone: opts.contactPhone,
    });
  }

  return {
    /** Pasalo a `createApiClient({ fetch })`. */
    fetch: mockFetch as (input: string, init?: RequestInit) => Promise<Response>,
    /** Las rutas implementadas (para comprobarlas contra el contrato). */
    routes: routes as readonly Route<StoredUser>[],
    /** El estado en memoria, para pruebas y depuracion. */
    get db(): DB {
      return db;
    },
    get requestCount(): number {
      return requests;
    },
    simulateBotBooking,
    /**
     * Lo que hace el bot contra la API (no hay `/api/bot/*` por HTTP): identidad por canal, aislamiento entre canales, `telefono_contacto`
     * obligatorio fuera de WhatsApp y traspasos. Las entradas son los cuerpos del contrato (`telefono` o `canal` + `contacto_id`).
     */
    bot: {
      /** Lo que contestaria `GET /api/bot/status`. */
      status: () => botView(db, clock()),
      mine: (who: Record<string, unknown>): Booking[] => botMine(db, clock(), botWho(who)),
      book: (who: Record<string, unknown>, input: { patientName: string; doctorId: string; contactPhone?: unknown }): Booking | null =>
        botBook(db, clock(), botWho(who), input),
      cancel: (who: Record<string, unknown>, bookingId: string): Booking => botCancel(db, botWho(who), bookingId),
      handoff: (body: Record<string, unknown>) => botHandoff(db, clock(), body),
    },
    /** Vuelve a los datos de ejemplo y cierra la sesion. */
    reset() {
      db = createSeededDb(clock());
      routes = buildRoutes(db);
      this.routes = routes;
      sessionId = null;
      persistSession();
    },
    controls: {
      /** Sin red: el `fetch` falla como cuando se cae la conexion. */
      setOffline(value: boolean) {
        offline = value;
      },
      /** Las proximas `count` peticiones responden con una pagina de error HTML (503 por defecto). */
      failNext(count = 1, status = 503) {
        failures = { count, status };
      },
      setLatency(ms: number) {
        latencyMs = ms;
      },
      /** Como si la cookie venciera: la siguiente peticion recibe 401. */
      expireSession() {
        if (sessionId) db.sessions.delete(sessionId);
      },
    },
  };
}

export type MockApi = ReturnType<typeof createMockApi>;
