/**
 * Hora PARA LEER en pantalla: formato de 12 h con meridiano ("9:00 AM", "1:30 PM").
 *
 * Capa propia (no toca `calendar.ts` ni `slots.ts`, copiados de Vocero). Solo cambia lo que se
 * MUESTRA: `hhmm()` sigue devolviendo "HH:MM" de 24 h y ese es el formato de los valores que
 * viajan (API, `value` de los `<option>`, `onEmptySlot`, claves de horarios). Entre la hora y el
 * meridiano va un espacio duro (U+00A0) para que nunca se parta en dos renglones.
 */

const NBSP = " ";

export type TimeLabelOptions = {
  /** Las horas en punto sin ":00" ("9 AM"). Para etiquetas angostas, como la columna de horas. */
  compact?: boolean;
};

/** Minuto del día (0–1439; cualquier entero se lleva al día, como `hhmm`) → "1:30 PM". */
export function timeLabel(minutes: number, opts: TimeLabelOptions = {}): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const min = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const meridiem = h24 < 12 ? "AM" : "PM";
  const body = opts.compact && min === 0 ? `${h12}` : `${h12}:${String(min).padStart(2, "0")}`;
  return `${body}${NBSP}${meridiem}`;
}

/** "HH:MM" de 24 h (el formato de los datos) → "1:30 PM". Si no es una hora válida devuelve el texto tal cual. */
export function hhmmLabel(value: string, opts: TimeLabelOptions = {}): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const h = Number(match[1]);
  const min = Number(match[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return value;
  return timeLabel(h * 60 + min, opts);
}

/** "9:00 AM – 9:30 AM". */
export function timeRangeLabel(startMin: number, endMin: number): string {
  return `${timeLabel(startMin)} – ${timeLabel(endMin)}`;
}
