import { describe, expect, it } from "vitest";
import { absenceDaySegment, absenceLabel, zonedWallClockToUtc } from "../src";

const TZ = "America/Cancun"; // UTC-5, sin horario de verano
const at = (day: string, hhmm: string) => zonedWallClockToUtc(day, hhmm, TZ)!.toISOString();
const seg = (a: { startUtc: string; endUtc: string }, day: string) => absenceDaySegment(a, day, TZ);

describe("tramo de una ausencia en un día (hora de la clínica)", () => {
  it("un día completo (de 00:00 a 00:00 de Cancún) llena ese día y no toca los vecinos", () => {
    const a = { startUtc: at("2026-11-12", "00:00"), endUtc: at("2026-11-13", "00:00") };
    expect(a.startUtc).toBe("2026-11-12T05:00:00.000Z"); // la medianoche de Cancún es 05:00 UTC
    expect(seg(a, "2026-11-12")).toEqual({ startMin: 0, endMin: 1440, continuesBefore: false, continuesAfter: false });
    expect(seg(a, "2026-11-11")).toBeNull();
    expect(seg(a, "2026-11-13")).toBeNull();
  });

  it("por horas: solo ese tramo del día", () => {
    const a = { startUtc: at("2026-11-12", "09:00"), endUtc: at("2026-11-12", "12:30") };
    expect(seg(a, "2026-11-12")).toEqual({ startMin: 540, endMin: 750, continuesBefore: false, continuesAfter: false });
    expect(seg(a, "2026-11-13")).toBeNull();
  });

  it("de varios días: tramo inicial, días completos del medio y tramo final", () => {
    const a = { startUtc: at("2026-11-12", "15:00"), endUtc: at("2026-11-14", "10:00") };
    expect(seg(a, "2026-11-11")).toBeNull();
    expect(seg(a, "2026-11-12")).toEqual({ startMin: 900, endMin: 1440, continuesBefore: false, continuesAfter: true });
    expect(seg(a, "2026-11-13")).toEqual({ startMin: 0, endMin: 1440, continuesBefore: true, continuesAfter: true });
    expect(seg(a, "2026-11-14")).toEqual({ startMin: 0, endMin: 600, continuesBefore: true, continuesAfter: false });
    expect(seg(a, "2026-11-15")).toBeNull();
  });

  it("una ausencia LARGA (vacaciones de semanas) se ve en cualquier día de su rango, no solo en los primeros 7", () => {
    const a = { startUtc: at("2026-11-12", "00:00"), endUtc: at("2026-12-12", "00:00") }; // 30 días
    for (const day of ["2026-11-12", "2026-11-19", "2026-11-26", "2026-12-03", "2026-12-11"]) {
      expect(seg(a, day), day).toEqual({ startMin: 0, endMin: 1440, continuesBefore: day !== "2026-11-12", continuesAfter: day !== "2026-12-11" });
    }
    expect(seg(a, "2026-12-12")).toBeNull();
    expect(seg(a, "2026-11-11")).toBeNull();
  });

  it("la zona manda, no UTC: lo que en UTC cae al día siguiente sigue siendo del día de la clínica", () => {
    // 22:00 a 23:30 de Cancún del 12 = 03:00 a 04:30 UTC del 13
    const a = { startUtc: at("2026-11-12", "22:00"), endUtc: at("2026-11-12", "23:30") };
    expect(a.startUtc).toBe("2026-11-13T03:00:00.000Z");
    expect(seg(a, "2026-11-12")).toEqual({ startMin: 1320, endMin: 1410, continuesBefore: false, continuesAfter: false });
    expect(seg(a, "2026-11-13")).toBeNull();
  });

  it("termina justo a medianoche: llena hasta el final del día y no se cuela en el siguiente", () => {
    const a = { startUtc: at("2026-11-12", "20:00"), endUtc: at("2026-11-13", "00:00") };
    expect(seg(a, "2026-11-12")).toEqual({ startMin: 1200, endMin: 1440, continuesBefore: false, continuesAfter: false });
    expect(seg(a, "2026-11-13")).toBeNull();
  });

  it("datos malos no rompen nada: sin tramo", () => {
    expect(seg({ startUtc: "no-es-fecha", endUtc: at("2026-11-13", "00:00") }, "2026-11-12")).toBeNull();
    expect(seg({ startUtc: at("2026-11-12", "10:00"), endUtc: at("2026-11-12", "10:00") }, "2026-11-12")).toBeNull(); // vacía
    expect(seg({ startUtc: at("2026-11-12", "12:00"), endUtc: at("2026-11-12", "10:00") }, "2026-11-12")).toBeNull(); // al revés
    expect(seg({ startUtc: at("2026-11-12", "00:00"), endUtc: at("2026-11-13", "00:00") }, "no-es-dia")).toBeNull();
  });

  it("la etiqueta: «Ausencia», o «Ausencia · motivo» si lo hay", () => {
    expect(absenceLabel({})).toBe("Ausencia");
    expect(absenceLabel({ reason: null })).toBe("Ausencia");
    expect(absenceLabel({ reason: "   " })).toBe("Ausencia");
    expect(absenceLabel({ reason: " Congreso " })).toBe("Ausencia · Congreso");
  });

  it("un evento personal del doctor (kind «busy») es siempre «No disponible»: el motivo, si llega, nunca se muestra", () => {
    expect(absenceLabel({ kind: "busy" })).toBe("No disponible");
    expect(absenceLabel({ kind: "busy", reason: "Cirugía de la Sra. Quintana" })).toBe("No disponible");
    expect(absenceLabel({ kind: "absence", reason: "Congreso" })).toBe("Ausencia · Congreso");
  });
});
