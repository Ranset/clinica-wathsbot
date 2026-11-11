import { addDaysISO, zonedWallClockToUtc, type DateRange } from "@clinica/calendar";
import { TZ } from "./fmt";

/**
 * Los días visibles (AAAA-MM-DD, ambos inclusive) como instantes UTC para la API:
 * desde las 00:00 de Cancún del primero hasta las 00:00 del día SIGUIENTE al último
 * (extremo final exclusivo). Con el tope de 92 días de la API, 92 días exactos caben.
 */
export function rangeToUtc(range: DateRange): { from: string; to: string } {
  const from = zonedWallClockToUtc(range.from, "00:00", TZ);
  const to = zonedWallClockToUtc(addDaysISO(range.to, 1), "00:00", TZ);
  if (!from || !to) throw new Error(`Rango inválido: ${range.from} – ${range.to}`);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** El instante UTC de una fecha y hora de pared de Cancún, o `null` si alguna no existe. */
export function utcOf(day: string, time: string): string | null {
  return zonedWallClockToUtc(day, time, TZ)?.toISOString() ?? null;
}

/** "09:00", "09:30"... entre dos horas, cada 30 min (las citas son de 30 min alineadas). */
export function timeOptions(from = "07:00", to = "20:00"): string[] {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const out: string[] = [];
  for (let m = toMin(from); m <= toMin(to); m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}
