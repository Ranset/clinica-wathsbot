import { ApiError, errorFromResponse, isAbortError } from "./errors";
import { CSRF_METHODS, OPERATIONS, fillPath, type OperationId } from "./operations";
import type {
  Absence,
  AbsenceInput,
  AbsenceResult,
  AttentionItem,
  AttentionList,
  Booking,
  BookingCreate,
  BookingList,
  BookingPatch,
  BookingStatus,
  BotChannels,
  BotMode,
  BotSchedule,
  BotSettings,
  Channel,
  Branding,
  BusyTime,
  Doctor,
  DoctorInput,
  FreeSlots,
  LoginDoctor,
  PasswordLink,
  PasswordLinkInfo,
  PersonalEvent,
  PersonalEventInput,
  PersonalEventPatch,
  RequestStatus,
  Room,
  ScheduleChangeApplied,
  ScheduleChangeRequest,
  SessionInfo,
  User,
  UserCreate,
  UserPatch,
  WeeklyHours,
  WeeklyHoursResult,
} from "./types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  /** Prefijo de las rutas. Vacio = mismo origen (lo normal: web y API comparten dominio). */
  baseUrl?: string;
  /** Por defecto `globalThis.fetch`. Aqui entra la API simulada. */
  fetch?: FetchLike;
  /** Cookie de sesion: `same-origin` basta si la API es del mismo origen. */
  credentials?: RequestCredentials;
  /** Token CSRF inicial (normalmente llega con `login()` o `me()`). */
  csrfToken?: string | null;
};

export type RequestOptions = { signal?: AbortSignal };

/** Para refrescar sin WebSockets: con `etag`, un 304 vuelve como `notModified: true`. */
export type ConditionalOptions = RequestOptions & { etag?: string | null };
export type Conditional<T> =
  | { notModified: true; etag: string | null }
  | { notModified: false; data: T; etag: string | null };

export type ListAppointmentsParams = {
  /** Instantes UTC (`...Z`). El servidor acepta hasta 92 dias. */
  from: string;
  to: string;
  doctorId?: string;
  roomId?: string;
  status?: BookingStatus;
};

type Query = Record<string, string | number | boolean | null | undefined>;

type SendOptions = {
  path?: Record<string, string>;
  query?: Query;
  body?: unknown;
  /** El cuerpo es esta imagen tal cual (no JSON): se manda con su propio `Content-Type`. */
  image?: { bytes: Uint8Array; contentType: string };
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** `false`: un 401 no es "se acabo la sesion" (login, /api/me al arrancar). */
  notifyUnauthenticated?: boolean;
};

type Sent = { status: number; data: unknown; headers: Headers };

function queryString(query: Query | undefined): string {
  if (!query) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Una pagina de error del hosting, un proxy... no es JSON.
    return { __notJson: true, text: text.slice(0, 200) };
  }
}

/**
 * Cliente fino de la API. Una funcion por operacion del contrato, sin estado
 * propio salvo el token CSRF y la lista de quienes escuchan el 401.
 *
 * - Cookie de sesion `clinica_session` (HttpOnly: el navegador la envia solo).
 * - `X-CSRF-Token` en POST/PUT/PATCH/DELETE.
 * - Errores como `ApiError` ({ status, code, detail }); sin red, `code: "red"`.
 * - Las listas `{ items }` se devuelven ya como arreglo.
 */
export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  // Se resuelve en cada llamada para que un `fetch` simulado instalado despues funcione.
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const credentials = options.credentials ?? "same-origin";
  let csrfToken: string | null = options.csrfToken ?? null;
  const unauthenticatedListeners = new Set<(e: ApiError) => void>();

  async function send(op: OperationId, o: SendOptions = {}): Promise<Sent> {
    const [method, template] = OPERATIONS[op];
    const verb = method.toUpperCase();
    const url = baseUrl + fillPath(template, o.path) + queryString(o.query);

    const headers = new Headers({ Accept: "application/json", ...o.headers });
    let body: string | Uint8Array | undefined;
    if (o.image) {
      headers.set("Content-Type", o.image.contentType || "application/octet-stream");
      body = o.image.bytes;
    } else if (o.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(o.body);
    }
    if (CSRF_METHODS.has(verb) && csrfToken) headers.set("X-CSRF-Token", csrfToken);

    let res: Response;
    try {
      res = await doFetch(url, { method: verb, headers, body: body as BodyInit | undefined, credentials, signal: o.signal });
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new ApiError({ status: 0, code: "red", detail: "No hay conexión con el servidor." });
    }

    if (res.status === 304) return { status: 304, data: undefined, headers: res.headers };

    const parsed = await readBody(res);
    if (!res.ok) {
      const err = errorFromResponse(res.status, parsed);
      if (res.status === 401 && o.notifyUnauthenticated !== false) {
        for (const fn of unauthenticatedListeners) fn(err);
      }
      throw err;
    }
    if (res.status !== 204 && (parsed === undefined || (parsed as { __notJson?: boolean }).__notJson)) {
      throw new ApiError({
        status: res.status,
        code: "respuesta_invalida",
        detail: "El servidor respondió algo que no es JSON.",
      });
    }
    return { status: res.status, data: parsed, headers: res.headers };
  }

  /** GET de una imagen: sus bytes y su tipo, o `null` si no existe (404). `url` es la direccion tal cual (con su `?v=`). */
  async function imageAt(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    let res: Response;
    try {
      res = await doFetch(baseUrl + url, { method: "GET", headers: new Headers({ Accept: "image/*" }), credentials, signal });
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new ApiError({ status: 0, code: "red", detail: "No hay conexión con el servidor." });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw errorFromResponse(res.status, await readBody(res));
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "application/octet-stream" };
  }

  async function json<T>(op: OperationId, o?: SendOptions): Promise<T> {
    return (await send(op, o)).data as T;
  }

  async function conditional<T>(op: OperationId, o: SendOptions, etag: string | null | undefined): Promise<Conditional<T>> {
    const headers = etag ? { ...o.headers, "If-None-Match": etag } : o.headers;
    const r = await send(op, { ...o, headers });
    const newTag = r.headers.get("ETag");
    if (r.status === 304) return { notModified: true, etag: newTag ?? etag ?? null };
    return { notModified: false, data: r.data as T, etag: newTag };
  }

  const items = async <T>(op: OperationId, o?: SendOptions): Promise<T[]> => (await json<{ items: T[] }>(op, o)).items;

  const api = {
    /** El token CSRF vigente (cambia con `login()` y `me()`). */
    get csrfToken() {
      return csrfToken;
    },
    set csrfToken(token: string | null) {
      csrfToken = token;
    },

    /**
     * Avisa cuando CUALQUIER llamada recibe 401 (la sesion caduco). `login()` y
     * `me()` no lo disparan: ahi el 401 es una respuesta esperada.
     */
    onUnauthenticated(fn: (e: ApiError) => void): () => void {
      unauthenticatedListeners.add(fn);
      return () => unauthenticatedListeners.delete(fn);
    },

    health: (o?: RequestOptions) => json<{ status: "ok" }>("health", { ...o, notifyUnauthenticated: false }),

    auth: {
      async login(email: string, password: string, o?: RequestOptions): Promise<SessionInfo> {
        const info = await json<SessionInfo>("login", { body: { email, password }, notifyUnauthenticated: false, ...o });
        csrfToken = info.csrfToken;
        return info;
      },
      /**
       * La lista de la pantalla de entrada del doctor (PUBLICA, sin sesion): codigo y nombre de cada doctor que tiene una cuenta
       * activa, por codigo. Es exactamente quien puede entrar con `loginDoctor`.
       */
      loginDoctors: (o?: RequestOptions) => items<LoginDoctor>("listLoginDoctors", { notifyUnauthenticated: false, ...o }),
      /** Entrada del doctor con su codigo de 4 digitos y su contrasena (sin correo). Guarda el token CSRF, como `login()`. */
      async loginDoctor(doctorCode: string, password: string, o?: RequestOptions): Promise<SessionInfo> {
        const info = await json<SessionInfo>("doctorLogin", { body: { doctorCode, password }, notifyUnauthenticated: false, ...o });
        csrfToken = info.csrfToken;
        return info;
      },
      /**
       * Para la página del enlace (PÚBLICO): de quién es (código y nombre del doctor) y hasta cuándo vale. 404 `enlace_invalido` si no
       * existe, ya venció o ya se usó (no se distingue cuál). No cambia nada.
       */
      checkPasswordLink: (token: string, o?: RequestOptions) =>
        json<PasswordLinkInfo>("checkPasswordLink", { body: { token }, notifyUnauthenticated: false, ...o }),
      /**
       * El doctor establece su contraseña con el enlace (de un solo uso; sirve igual para una nueva si olvidó la suya) y queda dentro: guarda
       * el token CSRF como `login()`. 422 si la contraseña no cumple (el enlace no se gasta), 404 `enlace_invalido` si ya no sirve.
       */
      async usePasswordLink(token: string, password: string, o?: RequestOptions): Promise<SessionInfo> {
        const info = await json<SessionInfo>("usePasswordLink", { body: { token, password }, notifyUnauthenticated: false, ...o });
        csrfToken = info.csrfToken;
        return info;
      },
      async logout(o?: RequestOptions): Promise<void> {
        try {
          await send("logout", { ...o, notifyUnauthenticated: false });
        } finally {
          csrfToken = null;
        }
      },
      /** La sesion vigente y un token CSRF nuevo. Lanza `ApiError` 401 si no hay sesion. */
      async me(o?: RequestOptions): Promise<SessionInfo> {
        const info = await json<SessionInfo>("me", { notifyUnauthenticated: false, ...o });
        csrfToken = info.csrfToken;
        return info;
      },
    },

    appointments: {
      list: (params: ListAppointmentsParams, o?: ConditionalOptions) =>
        conditional<BookingList>("listAppointments", { query: params, signal: o?.signal }, o?.etag),
      get: (id: string, o?: RequestOptions) => json<Booking>("getAppointment", { path: { appointmentId: id }, ...o }),
      create: (body: BookingCreate, o?: RequestOptions) => json<Booking>("createAppointment", { body, ...o }),
      update: (id: string, patch: BookingPatch, o?: RequestOptions) =>
        json<Booking>("updateAppointment", { path: { appointmentId: id }, body: patch, ...o }),
      /**
       * Los horarios LIBRES a los que se puede mover esa cita agendada, día por día en `[from, to)` (fechas `AAAA-MM-DD`, hasta 42 días):
       * exactamente los que `update` aceptaría (mismas reglas), sin reservar nada. Su propio horario cuenta como libre. `roomId` limita a un
       * consultorio; `allowShortNotice` omite la antelación mínima (cita de mostrador). Solo salen los días con algún horario libre.
       */
      moveSlots: (id: string, range: { from: string; to: string; roomId?: string; allowShortNotice?: boolean }, o?: RequestOptions) =>
        json<FreeSlots>("listMoveSlots", {
          path: { appointmentId: id },
          query: { from: range.from, to: range.to, roomId: range.roomId, allowShortNotice: range.allowShortNotice ? true : undefined },
          ...o,
        }),
      /**
       * Los horarios LIBRES para una cita (o bloqueo) NUEVA, la que se llena en «Nueva cita»: los mismos que aceptaría `create` con ese doctor,
       * esa duración (30 si falta) y ese consultorio (cualquiera si falta), día por día en `[from, to)` (hasta 42 días). En un bloqueo
       * (`kind: "block"`) el consultorio es obligatorio y no lleva doctor.
       */
      availability: (
        q: { from: string; to: string; kind?: "session" | "block"; doctorId?: string; roomId?: string; durationMinutes?: number; allowShortNotice?: boolean },
        o?: RequestOptions
      ) =>
        json<FreeSlots>("listAvailability", {
          query: { from: q.from, to: q.to, kind: q.kind, doctorId: q.doctorId, roomId: q.roomId, durationMinutes: q.durationMinutes, allowShortNotice: q.allowShortNotice ? true : undefined },
          ...o,
        }),
    },

    rooms: { list: (o?: RequestOptions) => items<Room>("listRooms", o) },

    /** Ausencias de TODOS los doctores en `[from, to)` (para sombrear el calendario). */
    absences: {
      list: (range: { from: string; to: string }, o?: RequestOptions) => items<Absence>("listAbsences", { query: range, ...o }),
    },

    /**
     * Franjas en que cada doctor esta ocupado por un evento PERSONAL, en `[from, to)`. Solo horario y doctor: el titulo y las
     * notas son privados del doctor y no llegan al personal. El calendario las pinta como «No disponible».
     */
    busyTimes: {
      list: (range: { from: string; to: string }, o?: RequestOptions) => items<BusyTime>("listBusyTimes", { query: range, ...o }),
    },

    clinicHours: {
      get: (o?: RequestOptions) => json<WeeklyHours>("getClinicHours", o),
      set: (hours: WeeklyHours, o?: RequestOptions) => json<WeeklyHours>("setClinicHours", { body: hours, ...o }),
    },

    doctors: {
      list: (o?: RequestOptions) => items<Doctor>("listDoctors", o),
      create: (input: DoctorInput, o?: RequestOptions) => json<Doctor>("createDoctor", { body: input, ...o }),
      update: (id: string, input: DoctorInput, o?: RequestOptions) =>
        json<Doctor>("updateDoctor", { path: { doctorId: id }, body: input, ...o }),
      /**
       * Genera el enlace para que el doctor establezca su contraseña (la primera vez, o una nueva si la olvidó): de un solo uso, vence en 72 h y
       * reemplaza al anterior. Crea la cuenta si el doctor aún no la tiene. Lo usan el personal y el administrador.
       */
      createPasswordLink: (id: string, o?: RequestOptions) => json<PasswordLink>("createPasswordLink", { path: { doctorId: id }, ...o }),
      /** Elimina DEFINITIVAMENTE un doctor (solo administrador). 409 `doctor_con_citas` / `doctor_con_usuario` si tiene historial o cuenta con contraseña. */
      remove: async (id: string, o?: RequestOptions): Promise<void> => {
        await send("deleteDoctor", { path: { doctorId: id }, ...o });
      },
      /** `null` = volver al horario de la clinica. */
      setWeeklyHours: (id: string, weeklyHours: WeeklyHours | null, o?: RequestOptions) =>
        json<WeeklyHoursResult>("setDoctorWeeklyHours", { path: { doctorId: id }, body: { weeklyHours }, ...o }),
      absences: {
        list: (id: string, range?: { from?: string; to?: string }, o?: RequestOptions) =>
          items<Absence>("listDoctorAbsences", { path: { doctorId: id }, query: range, ...o }),
        create: (id: string, input: AbsenceInput, o?: RequestOptions) =>
          json<AbsenceResult>("createDoctorAbsence", { path: { doctorId: id }, body: input, ...o }),
        remove: async (id: string, absenceId: string, o?: RequestOptions): Promise<void> => {
          await send("deleteDoctorAbsence", { path: { doctorId: id, absenceId }, ...o });
        },
      },
    },

    scheduleChanges: {
      list: (status?: RequestStatus, o?: RequestOptions) =>
        items<ScheduleChangeRequest>("listScheduleChangeRequests", { query: { status }, ...o }),
      approve: (id: string, o?: RequestOptions) =>
        json<ScheduleChangeApplied>("approveScheduleChange", { path: { requestId: id }, ...o }),
      reject: (id: string, note?: string, o?: RequestOptions) =>
        json<ScheduleChangeRequest>("rejectScheduleChange", { path: { requestId: id }, body: note ? { note } : {}, ...o }),
    },

    bot: {
      get: (o?: RequestOptions) => json<BotSettings>("getBotSettings", o),
      /** La forma de siempre: enciende / apaga SOLO WhatsApp. */
      set: (active: boolean, o?: RequestOptions) => json<BotSettings>("setBotSettings", { body: { active }, ...o }),
      /** Enciende / apaga UN canal (`whatsapp`, `facebook` o `instagram`) sin tocar los otros. */
      setChannel: (channel: Channel, active: boolean, o?: RequestOptions) =>
        json<BotSettings>("setBotSettings", { body: { channel, active }, ...o }),
      /**
       * Cambia de UN canal lo que venga: el interruptor manual (`active`), el modo (`manual` | `schedule`) y/o el horario. Pasar a
       * `schedule` exige un horario valido (el que viene o el ya guardado).
       */
      configure: (channel: Channel, change: { active?: boolean; mode?: BotMode; schedule?: BotSchedule }, o?: RequestOptions) =>
        json<BotSettings>("setBotSettings", { body: { channel, ...change }, ...o }),
      setMode: (channel: Channel, mode: BotMode, o?: RequestOptions) => json<BotSettings>("setBotSettings", { body: { channel, mode }, ...o }),
      setSchedule: (channel: Channel, schedule: BotSchedule, o?: RequestOptions) =>
        json<BotSettings>("setBotSettings", { body: { channel, schedule }, ...o }),
      /** Cambia varios canales a la vez; solo los que vienen. */
      setChannels: (channels: Partial<BotChannels>, o?: RequestOptions) => json<BotSettings>("setBotSettings", { body: { channels }, ...o }),
    },

    /**
     * La marca de la clinica (nombre y logotipo). Leerla es PUBLICO (el login ya la muestra); cambiarla es solo del administrador.
     * El logotipo es una imagen CUADRADA (PNG, JPG o WebP, 64 a 2048 px, hasta 1 MB): el servidor valida por los bytes.
     */
    branding: {
      get: (o?: RequestOptions) => json<Branding>("getBranding", { notifyUnauthenticated: false, ...o }),
      /** Los bytes y el tipo del logotipo (`logoUrl` de `get()`, con su `?v=` para el cache), o `null` si no hay. */
      logo: (logoUrl: string, o?: RequestOptions) => imageAt(logoUrl, o?.signal),
      setName: (name: string, o?: RequestOptions) => json<Branding>("setBranding", { body: { name }, ...o }),
      /** `bytes` de la imagen tal cual y su tipo (`image/png`, `image/jpeg` o `image/webp`). */
      uploadLogo: (bytes: Uint8Array, contentType: string, o?: RequestOptions) =>
        json<Branding>("uploadBrandingLogo", { image: { bytes, contentType }, ...o }),
      removeLogo: (o?: RequestOptions) => json<Branding>("deleteBrandingLogo", o),
    },

    attention: {
      /** TODOS los casos de ese estado (lo que conviene a los pendientes, que son pocos). */
      list: (status: "open" | "resolved" = "open", o?: RequestOptions & { channel?: Channel }) => {
        const { channel, ...opts } = o ?? {};
        return items<AttentionItem>("listAttention", { query: { status, channel }, ...opts });
      },
      /**
       * UNA pagina de casos (mas recientes primero) y cuantos hay en total con ese estado. Los atendidos se acumulan sin
       * fin: asi el servidor solo trae `limit` (1 a 100) a partir de `offset`.
       */
      page: (status: "open" | "resolved", page: { limit: number; offset?: number; channel?: Channel }, o?: RequestOptions) =>
        json<AttentionList>("listAttention", { query: { status, limit: page.limit, offset: page.offset ?? 0, channel: page.channel }, ...o }),
      resolve: (id: string, o?: RequestOptions) =>
        json<AttentionItem>("resolveAttention", { path: { attentionId: id }, ...o }),
    },

    users: {
      list: (o?: RequestOptions) => items<User>("listUsers", o),
      create: (body: UserCreate, o?: RequestOptions) => json<User>("createUser", { body, ...o }),
      update: (id: string, patch: UserPatch, o?: RequestOptions) =>
        json<User>("updateUser", { path: { userId: id }, body: patch, ...o }),
    },

    /** Lo que usa la PWA del doctor: siempre acotado al doctor de la sesion. */
    doctorSelf: {
      appointments: (range: { from: string; to: string }, o?: ConditionalOptions) =>
        conditional<BookingList>("doctorAppointments", { query: range, signal: o?.signal }, o?.etag),
      hours: (o?: RequestOptions) => json<Doctor>("doctorHours", o),
      absences: {
        list: (o?: RequestOptions) => items<Absence>("doctorListAbsences", o),
        create: (input: AbsenceInput, o?: RequestOptions) =>
          json<{ absence: Absence; affectedCount: number }>("doctorCreateAbsence", { body: input, ...o }),
        remove: async (absenceId: string, o?: RequestOptions): Promise<void> => {
          await send("doctorDeleteAbsence", { path: { absenceId }, ...o });
        },
      },
      /**
       * Eventos personales (privados). Mientras dura uno el doctor no recibe citas, pero el consultorio queda libre para los demas
       * doctores. Crear/mover sobre una cita agendada = 409 `evento_con_cita`; mas de 24 h = 422 (eso es una ausencia).
       */
      personalEvents: {
        list: (range: { from: string; to: string }, o?: RequestOptions) =>
          items<PersonalEvent>("doctorListPersonalEvents", { query: range, ...o }),
        create: (input: PersonalEventInput, o?: RequestOptions) =>
          json<PersonalEvent>("doctorCreatePersonalEvent", { body: input, ...o }),
        /** Parche: solo cambia lo que se manda (`notes: null` borra las notas). */
        update: (eventId: string, patch: PersonalEventPatch, o?: RequestOptions) =>
          json<PersonalEvent>("doctorUpdatePersonalEvent", { path: { eventId }, body: patch, ...o }),
        remove: async (eventId: string, o?: RequestOptions): Promise<void> => {
          await send("doctorDeletePersonalEvent", { path: { eventId }, ...o });
        },
      },
      scheduleChanges: {
        list: (o?: RequestOptions) => items<ScheduleChangeRequest>("doctorListScheduleChanges", o),
        create: (body: { weeklyHours: WeeklyHours; effectiveFrom: string; note?: string }, o?: RequestOptions) =>
          json<ScheduleChangeRequest>("doctorCreateScheduleChange", { body, ...o }),
        /** Elimina una solicitud MIA que sigue pendiente (409 `transicion_invalida` si el personal ya la resolvio; 404 si no es mia). */
        remove: async (requestId: string, o?: RequestOptions): Promise<void> => {
          await send("doctorDeleteScheduleChange", { path: { requestId }, ...o });
        },
      },
      push: {
        subscribe: async (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, o?: RequestOptions): Promise<void> => {
          await send("doctorSubscribePush", { body: sub, ...o });
        },
        unsubscribe: async (endpoint: string, o?: RequestOptions): Promise<void> => {
          await send("doctorUnsubscribePush", { body: { endpoint }, ...o });
        },
      },
    },
  };

  return api;
}

export type ApiClient = ReturnType<typeof createApiClient>;
