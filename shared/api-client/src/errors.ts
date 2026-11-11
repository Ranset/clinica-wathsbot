import type { ErrorCode } from "./types";

/**
 * Codigos que el cliente agrega a los del contrato:
 * - `red`: no hubo respuesta (sin conexion, servidor caido, CORS).
 * - `respuesta_invalida`: respondio, pero no con el JSON esperado (p. ej. una pagina de error del hosting).
 * - `desconocido`: error HTTP con un cuerpo que no es `{ error, detail }`.
 */
export type ClientErrorCode = ErrorCode | "red" | "respuesta_invalida" | "desconocido";

/** Un error de la API o de la red, con la forma del cuerpo `{ error, detail }` del contrato. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly detail: string | undefined;
  /** El cuerpo tal cual llego (puede traer campos extra: `especialidades`, `horarios`...). */
  readonly body: unknown;

  constructor(init: { status: number; code: ClientErrorCode; detail?: string; body?: unknown }) {
    super(init.detail ?? init.code);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.body = init.body;
  }

  /** 409: el hueco ya no esta libre. */
  get isConflict(): boolean {
    return this.status === 409;
  }
  /** 422: entrada invalida o regla de agenda incumplida. */
  get isRuleError(): boolean {
    return this.status === 422;
  }
  /** Sin respuesta del servidor o error 5xx: reintentar tiene sentido. */
  get isTransient(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Una peticion cancelada con `AbortController` no es un fallo. */
export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/** Construye el `ApiError` de una respuesta HTTP que no fue 2xx. */
export function errorFromResponse(status: number, parsed: unknown): ApiError {
  if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
    const body = parsed as { error: string; detail?: unknown };
    return new ApiError({
      status,
      code: body.error as ClientErrorCode,
      detail: typeof body.detail === "string" ? body.detail : undefined,
      body: parsed,
    });
  }
  return new ApiError({ status, code: "desconocido", detail: `El servidor respondio ${status}.`, body: parsed });
}
