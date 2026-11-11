import { WEEKDAYS, type Interval, type WeekdayKey, type WeeklyHours } from "@clinica/calendar";

export const DAY_NAME: Record<WeekdayKey, string> = {
  mon: "Lunes",
  tue: "Martes",
  wed: "Miércoles",
  thu: "Jueves",
  fri: "Viernes",
  sat: "Sábado",
  sun: "Domingo",
};
const DAY_SHORT: Record<WeekdayKey, string> = {
  mon: "Lun",
  tue: "Mar",
  wed: "Mié",
  thu: "Jue",
  fri: "Vie",
  sat: "Sáb",
  sun: "Dom",
};

const sorted = (ivs: Interval[]) => [...ivs].sort((a, b) => a.start.localeCompare(b.start));
const key = (ivs: Interval[]) => sorted(ivs).map((i) => `${i.start}–${i.end}`).join(", ");
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/** "Lun–Vie 09:00–18:00 · Sáb 09:00–13:00": los días con el mismo horario se juntan. */
export function summarizeHours(hours: WeeklyHours): string {
  const groups = new Map<string, WeekdayKey[]>();
  for (const d of WEEKDAYS) {
    const ivs = hours[d];
    if (!ivs?.length) continue;
    const k = key(ivs);
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  if (groups.size === 0) return "Sin atención";
  return [...groups.entries()]
    .map(([k, days]) => {
      // Corridas de 3 o más días seguidos -> "Lun–Vie"; el resto, lista: "Mar, Jue".
      const idx = days.map((d) => WEEKDAYS.indexOf(d));
      const parts: string[] = [];
      for (let i = 0; i < idx.length; ) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1] === idx[j]! + 1) j++;
        parts.push(j - i >= 2 ? `${DAY_SHORT[days[i]!]}–${DAY_SHORT[days[j]!]}` : days.slice(i, j + 1).map((d) => DAY_SHORT[d]).join(", "));
        i = j + 1;
      }
      return `${parts.join(", ")} ${k}`;
    })
    .join(" · ");
}

/**
 * Revisa un horario semanal antes de mandarlo: horas completas, fin después del
 * inicio, sin solaparse y dentro de `limit` (el horario de la clínica). Devuelve el
 * primer problema de cada día que lo tenga; vacío = válido. El servidor repite
 * estas reglas; esto solo evita ir y volver por un error evidente.
 */
export function validateHours(hours: WeeklyHours, limit?: WeeklyHours): Partial<Record<WeekdayKey, string>> {
  const errors: Partial<Record<WeekdayKey, string>> = {};
  for (const d of WEEKDAYS) {
    const ivs = sorted(hours[d] ?? []);
    for (let i = 0; i < ivs.length && !errors[d]; i++) {
      const iv = ivs[i]!;
      if (!/^\d{2}:\d{2}$/.test(iv.start) || !/^\d{2}:\d{2}$/.test(iv.end)) errors[d] = "Completa las dos horas.";
      else if (toMin(iv.end) <= toMin(iv.start)) errors[d] = "La hora final debe ser después de la inicial.";
      else if (i > 0 && toMin(iv.start) < toMin(ivs[i - 1]!.end)) errors[d] = "Los tramos no pueden solaparse.";
    }
    if (!errors[d] && limit && ivs.length) {
      const inside = (iv: Interval) => (limit[d] ?? []).some((l) => toMin(iv.start) >= toMin(l.start) && toMin(iv.end) <= toMin(l.end));
      if (!ivs.every(inside)) {
        const lim = (limit[d] ?? []).map((l) => `${l.start}–${l.end}`).join(", ");
        errors[d] = lim ? `Fuera del horario de la clínica (${lim}).` : "La clínica no atiende ese día.";
      }
    }
  }
  return errors;
}

/** Quita los días sin tramos y ordena, para mandar un `{ mon: [...] }` limpio. */
export function compactHours(hours: WeeklyHours): WeeklyHours {
  const out: WeeklyHours = {};
  for (const d of WEEKDAYS) {
    if (hours[d]?.length) out[d] = sorted(hours[d]!).map((i) => ({ start: i.start, end: i.end }));
  }
  return out;
}
