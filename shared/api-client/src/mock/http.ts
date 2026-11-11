import type { ErrorCode, Role } from "../types";
import { OPERATIONS, type OperationId } from "../operations";

/** Un error de la API con el cuerpo `{ error, detail }` del contrato. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    detail?: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(detail ?? code);
  }
  body(): Record<string, unknown> {
    return { error: this.code, ...(this.message !== this.code ? { detail: this.message } : {}), ...this.extra };
  }
}

export const unauthorized = (detail = "Inicia sesión para continuar.") => new HttpError(401, "no_autenticado", detail);
export const forbidden = (detail = "Tu rol no permite esta operación.") => new HttpError(403, "sin_permiso", detail);
export const notFound = (detail = "No existe o no te pertenece.") => new HttpError(404, "no_encontrado", detail);
export const invalid = (detail: string) => new HttpError(422, "validacion", detail);
export const rule = (code: ErrorCode, detail: string) => new HttpError(422, code, detail);
export const conflict = (detail = "Ese horario ya no está libre.") => new HttpError(409, "horario_ocupado", detail);

export type Result = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Equivale al `Set-Cookie` de `clinica_session`: un id abre la sesion, `null` la cierra. */
  setSession?: string | null;
};

export type Ctx<TUser = unknown> = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
  /** Quien tiene la sesion (las rutas publicas no lo traen). */
  user: TUser;
  /** Id de la sesion abierta (la "cookie"), o `null` en rutas publicas. */
  sessionId: string | null;
  now: Date;
};

export type Route<TUser = unknown> = {
  operationId: OperationId;
  method: string;
  /** Plantilla del contrato: `/api/doctors/{doctorId}`. */
  path: string;
  /** `null` = ruta publica (sin sesion). Son los `x-roles` del contrato. */
  roles: readonly Role[] | null;
  /** Escribe con sesion por cookie: exige `X-CSRF-Token`. */
  csrf: boolean;
  handler: (ctx: Ctx<TUser>) => Result | Promise<Result>;
};

/**
 * Declara una ruta tomando metodo y ruta de la tabla `OPERATIONS` (la misma que
 * usa el cliente), de modo que simulador y cliente no pueden desviarse entre si.
 */
export function route<TUser>(
  operationId: OperationId,
  roles: readonly Role[] | null,
  handler: Route<TUser>["handler"]
): Route<TUser> {
  const [method, path] = OPERATIONS[operationId];
  const verb = method.toUpperCase();
  return { operationId, method: verb, path, roles, csrf: roles !== null && verb !== "GET", handler };
}

const matchers = new Map<string, RegExp>();
function matcherOf(template: string): RegExp {
  let re = matchers.get(template);
  if (!re) {
    re = new RegExp("^" + template.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)") + "/?$");
    matchers.set(template, re);
  }
  return re;
}

export function matchRoute<T>(routes: Route<T>[], method: string, pathname: string): { route: Route<T>; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = matcherOf(r.path).exec(pathname);
    if (m) {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.groups ?? {})) params[k] = decodeURIComponent(v);
      return { route: r, params };
    }
  }
  return null;
}

export const ok = (body: unknown, status = 200, headers?: Record<string, string>): Result => ({ status, body, headers });
export const noContent = (): Result => ({ status: 204 });

/* ---------------------------------------------------- lectura de cuerpos */

export type Obj = Record<string, unknown>;

export function asObject(body: unknown, what = "El cuerpo"): Obj {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid(`${what} debe ser un objeto JSON.`);
  return body as Obj;
}

export function reqString(o: Obj, key: string, max = 500): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") throw invalid(`Falta "${key}".`);
  if (v.length > max) throw invalid(`"${key}" admite hasta ${max} caracteres.`);
  return v.trim();
}

export function optString(o: Obj, key: string, max = 500): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalid(`"${key}" debe ser texto.`);
  if (v.length > max) throw invalid(`"${key}" admite hasta ${max} caracteres.`);
  return v.trim();
}

export function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw invalid(`"${key}" debe ser verdadero o falso.`);
  return v;
}

export function isoInstant(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw invalid(`"${key}" debe ser una fecha y hora ISO (UTC).`);
  return new Date(v).toISOString();
}
