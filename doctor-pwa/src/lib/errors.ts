import { isApiError, type ClientErrorCode } from "@clinica/api-client";

const BY_CODE: Partial<Record<ClientErrorCode, string>> = {
  horario_ocupado: "Ese horario ya no está libre.",
  horario_pasado_o_muy_cercano: "Ese horario ya pasó o está muy cerca (se piden 60 minutos de antelación).",
  fuera_de_rango: "Solo se puede agendar hasta 60 días a futuro.",
  fuera_de_horario: "Ese horario queda fuera del horario de atención.",
  falta_nombre_completo: "Escribe el nombre y el apellido del paciente.",
  doctor_no_disponible: "El doctor no está disponible en ese horario.",
  transicion_invalida: "Esa cita no puede pasar a ese estado.",
  rango_invalido: "El rango de fechas no es válido.",
  validacion: "Revisa los datos e inténtalo de nuevo.",
  no_autenticado: "Tu sesión terminó. Inicia sesión de nuevo.",
  sin_permiso: "Tu rol no permite esta operación.",
  no_encontrado: "Ya no existe; es posible que alguien más lo haya cambiado.",
  credenciales_invalidas: "Correo o contraseña incorrectos.",
  demasiados_intentos: "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
};

/** Un texto en español, listo para mostrar, de cualquier error. Prefiere el `detail` que manda el servidor. */
export function messageFor(err: unknown, fallback = "Ocurrió un error inesperado. Inténtalo de nuevo."): string {
  if (!isApiError(err)) return fallback;
  if (err.code === "red") return "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.";
  if (err.status >= 500) return "El servidor tuvo un problema. Inténtalo de nuevo en un momento.";
  return err.detail ?? BY_CODE[err.code] ?? fallback;
}

/** El cambio no se aplicó porque otro lo hizo antes (el hueco ya no está libre). */
export const isConflict = (err: unknown): boolean => isApiError(err) && err.status === 409;

/**
 * Sin red, el servidor caído (5xx) o una respuesta que no es JSON (la página de error del hosting):
 * no es culpa de lo que se pidió, y reintentar más tarde tiene sentido. Es lo que hace pasar la app a «sin conexión».
 */
export const isTransientError = (err: unknown): boolean => isApiError(err) && (err.isTransient || err.code === "respuesta_invalida");
