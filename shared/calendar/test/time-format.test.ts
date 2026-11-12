import { describe, expect, it } from "vitest";
import { hhmm, hhmmLabel, timeLabel, timeRangeLabel } from "../src";

/** Con un espacio duro entre el número y AM/PM, para que nunca se parta en dos renglones. */
const nb = (s: string) => s.replace(/ (AM|PM)/g, " $1");

describe("hora en formato de 12 h", () => {
  it("madrugada, mañana, mediodía, tarde y noche", () => {
    expect(timeLabel(0)).toBe(nb("12:00 AM"));
    expect(timeLabel(30)).toBe(nb("12:30 AM"));
    expect(timeLabel(9 * 60)).toBe(nb("9:00 AM"));
    expect(timeLabel(11 * 60 + 59)).toBe(nb("11:59 AM"));
    expect(timeLabel(12 * 60)).toBe(nb("12:00 PM"));
    expect(timeLabel(12 * 60 + 30)).toBe(nb("12:30 PM"));
    expect(timeLabel(13 * 60 + 30)).toBe(nb("1:30 PM"));
    expect(timeLabel(18 * 60)).toBe(nb("6:00 PM"));
    expect(timeLabel(23 * 60 + 30)).toBe(nb("11:30 PM"));
  });

  it("el minuto siempre lleva dos cifras y la hora ninguna a la izquierda", () => {
    expect(timeLabel(9 * 60 + 5)).toBe(nb("9:05 AM"));
    expect(timeLabel(21 * 60 + 7)).toBe(nb("9:07 PM"));
  });

  it("como hhmm, lleva cualquier minuto al día (el fin de una cita a medianoche)", () => {
    expect(timeLabel(1440)).toBe(nb("12:00 AM"));
    expect(timeLabel(1440 + 30)).toBe(nb("12:30 AM"));
    expect(timeLabel(-30)).toBe(nb("11:30 PM"));
    expect(timeLabel(24 * 60 + 13 * 60)).toBe(timeLabel(13 * 60));
  });

  it("compacto: las horas en punto sin ':00', lo demás igual", () => {
    expect(timeLabel(9 * 60, { compact: true })).toBe(nb("9 AM"));
    expect(timeLabel(12 * 60, { compact: true })).toBe(nb("12 PM"));
    expect(timeLabel(0, { compact: true })).toBe(nb("12 AM"));
    expect(timeLabel(9 * 60 + 30, { compact: true })).toBe(nb("9:30 AM"));
  });

  it("el espacio entre la hora y el meridiano es duro", () => {
    expect(timeLabel(13 * 60)).toContain(" ");
    expect(timeLabel(13 * 60)).not.toContain(" ");
  });

  it("hhmmLabel lee el formato de los datos ('HH:MM', 24 h) y devuelve lo que no entiende", () => {
    expect(hhmmLabel("09:00")).toBe(nb("9:00 AM"));
    expect(hhmmLabel("13:30")).toBe(nb("1:30 PM"));
    expect(hhmmLabel("00:00")).toBe(nb("12:00 AM"));
    expect(hhmmLabel("24:00")).toBe(nb("12:00 AM"));
    expect(hhmmLabel("18:00", { compact: true })).toBe(nb("6 PM"));
    for (const bad of ["", "9", "25:00", "10:60", "24:30", "10h", "aa:bb"]) expect(hhmmLabel(bad)).toBe(bad);
  });

  it("es coherente con hhmm: todas las medias horas del día", () => {
    for (let m = 0; m < 1440; m += 30) {
      expect(hhmmLabel(hhmm(m))).toBe(timeLabel(m));
    }
  });

  it("timeRangeLabel", () => {
    expect(timeRangeLabel(9 * 60, 9 * 60 + 30)).toBe(nb("9:00 AM – 9:30 AM"));
    expect(timeRangeLabel(11 * 60 + 45, 12 * 60 + 15)).toBe(nb("11:45 AM – 12:15 PM"));
    expect(timeRangeLabel(23 * 60 + 30, 24 * 60)).toBe(nb("11:30 PM – 12:00 AM"));
  });
});
