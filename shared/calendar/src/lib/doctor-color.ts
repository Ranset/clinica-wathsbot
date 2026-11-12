/**
 * Un color propio y FIJO para cada doctor, para reconocerlo de un vistazo en el calendario.
 *
 * Capa propia (no toca `calendar.ts` ni `slots.ts`, copiados de Vocero). Sin base de datos: el color sale del id del
 * doctor, asi es el mismo en todas las pantallas y dispositivos, no cambia al dar de alta o de baja a otros y un doctor
 * nuevo recibe el siguiente de la paleta. Los ids son consecutivos (`"1"` en el servidor, `"d1"` en el simulador), por
 * eso los primeros 10 doctores nunca comparten color; del 11 en adelante la paleta se repite.
 *
 * Los colores son oscuros a proposito: con texto blanco encima cumplen contraste >= 4.5:1 (AA) y los 7 primeros, que
 * son los de la clinica, estan bien separados entre si. Se evita el verde azulado de la marca (botones, "hoy") y el
 * verde/ambar/gris de los estados de una cita.
 */
export const DOCTOR_COLORS = [
  "#1d4ed8", // azul
  "#c2410c", // naranja
  "#7e22ce", // morado
  "#0e7490", // cian
  "#be185d", // rosa
  "#4d7c0f", // verde olivo
  "#92400e", // cafe
  "#b91c1c", // rojo
  "#a16207", // mostaza
  "#475569", // gris azulado
] as const;

/** El nombre de cada color de la paleta, en el mismo orden (para etiquetas accesibles: no todos distinguen colores a simple vista). */
export const DOCTOR_COLOR_NAMES = ["azul", "naranja", "morado", "cian", "rosa", "verde olivo", "café", "rojo", "mostaza", "gris azulado"] as const;

/** Texto que va encima de un color de doctor. */
export const ON_DOCTOR_COLOR = "#ffffff";

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Posicion en la paleta: el numero del id (`"3"` y `"d3"` son el mismo doctor) o, si no trae numero, un hash estable. */
export function doctorColorIndex(id: string): number {
  const digits = /\d+/.exec(id)?.[0];
  const n = digits !== undefined ? Number(digits) : NaN;
  const base = Number.isSafeInteger(n) && n > 0 ? n - 1 : fnv1a(id);
  return base % DOCTOR_COLORS.length;
}

/** El color AUTOMATICO del doctor (`#rrggbb`) segun su id, o `null` si no hay doctor (un bloqueo de consultorio). */
export function doctorColor(id: string | null | undefined): string | null {
  if (id === null || id === undefined || id === "") return null;
  return DOCTOR_COLORS[doctorColorIndex(String(id))] ?? null;
}

/**
 * El color con el que se ve un doctor: el que se le ELIGIO (`color`, `#rrggbb`) o, si no tiene, el automatico por su id.
 * Es lo que usa todo el calendario; `doctorColor` solo da el automatico.
 */
export function colorOf(doctor: { id: string; color?: string | null } | null | undefined): string | null {
  if (!doctor) return null;
  return doctor.color && HEX_COLOR.test(doctor.color) ? doctor.color.toLowerCase() : doctorColor(doctor.id);
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Un `#rrggbb` valido. */
export const isHexColor = (value: unknown): value is string => typeof value === "string" && HEX_COLOR.test(value);

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Contraste WCAG de un `#rrggbb` contra el blanco (1 = igual al blanco, 21 = negro). */
export function contrastWithWhite(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as [number, number, number];
  return 1.05 / (0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) + 0.05);
}

/**
 * ¿Se lee el texto BLANCO sobre este color? (AA, >= 4.5:1). Las citas agendadas se rellenan con el color del doctor y
 * llevan texto blanco, asi que un color mas claro no se puede elegir. El servidor aplica la MISMA regla
 * (`server/app/colors.py`); las dos comparten casos de prueba.
 */
export const isReadableOnWhite = (color: string): boolean => isHexColor(color) && contrastWithWhite(color) >= 4.5;
