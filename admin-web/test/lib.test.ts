import { describe, expect, it } from "vitest";
import { ApiError } from "@clinica/api-client";
import { MAX_RANGE_DAYS, datesOf, visibleRange } from "@clinica/calendar";
import { messageFor } from "../src/lib/errors";
import { ago, fmtDateTime, fmtPhone, fmtSpan } from "../src/lib/fmt";
import { compactHours, summarizeHours, validateHours } from "../src/lib/hours";
import { rangeToUtc, timeOptions, utcOf } from "../src/lib/range";
import { NAV, canOpen, permissionsFor } from "../src/permissions";
import { hrefFor, parseHash } from "../src/router";

const CLINIC = {
  mon: [{ start: "09:00", end: "18:00" }], tue: [{ start: "09:00", end: "18:00" }], wed: [{ start: "09:00", end: "18:00" }],
  thu: [{ start: "09:00", end: "18:00" }], fri: [{ start: "09:00", end: "18:00" }], sat: [{ start: "09:00", end: "13:00" }],
};

describe("rangeToUtc: los dias visibles como instantes UTC (Cancun = UTC-5)", () => {
  it("una semana: desde las 00:00 del lunes hasta las 00:00 del lunes siguiente", () => {
    expect(rangeToUtc(visibleRange("semana", "2026-11-12"))).toEqual({ from: "2026-11-09T05:00:00.000Z", to: "2026-11-16T05:00:00.000Z" });
  });

  it("un dia", () => {
    expect(rangeToUtc({ from: "2026-11-10", to: "2026-11-10" })).toEqual({ from: "2026-11-10T05:00:00.000Z", to: "2026-11-11T05:00:00.000Z" });
  });

  it("la vista de mes (42 dias) y la lista mas larga (92 dias) caben en el tope de la API", () => {
    for (const range of [visibleRange("mes", "2026-11-15"), visibleRange("lista", "2026-11-01", "2027-12-31")]) {
      const { from, to } = rangeToUtc(range);
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      expect(days).toBe(datesOf(range).length);
      expect(days).toBeLessThanOrEqual(MAX_RANGE_DAYS);
    }
    expect(datesOf(visibleRange("lista", "2026-11-01", "2027-12-31"))).toHaveLength(MAX_RANGE_DAYS);
  });

  it("utcOf convierte hora de pared de Cancun y rechaza lo que no existe", () => {
    expect(utcOf("2026-11-12", "11:00")).toBe("2026-11-12T16:00:00.000Z");
    expect(utcOf("2026-02-31", "11:00")).not.toBe("2026-02-31T16:00:00.000Z");
    expect(utcOf("no-fecha", "11:00")).toBeNull();
  });

  it("timeOptions da medias horas alineadas", () => {
    const t = timeOptions("09:00", "11:00");
    expect(t).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
  });
});

describe("horarios semanales", () => {
  it("summarizeHours junta dias iguales y distingue corridas de dias sueltos", () => {
    expect(summarizeHours(CLINIC)).toBe("Lun–Vie 09:00–18:00 · Sáb 09:00–13:00");
    expect(summarizeHours({ tue: [{ start: "10:00", end: "14:00" }], thu: [{ start: "10:00", end: "14:00" }] })).toBe("Mar, Jue 10:00–14:00");
    expect(summarizeHours({ mon: [{ start: "10:00", end: "16:00" }], wed: [{ start: "10:00", end: "16:00" }], fri: [{ start: "10:00", end: "16:00" }] })).toBe("Lun, Mié, Vie 10:00–16:00");
    expect(summarizeHours({ mon: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }] })).toBe("Lun 09:00–12:00, 14:00–18:00");
    expect(summarizeHours({})).toBe("Sin atención");
  });

  it("validateHours: orden, solapes y limites de la clinica", () => {
    expect(validateHours(CLINIC, CLINIC)).toEqual({});
    expect(validateHours({ mon: [{ start: "12:00", end: "10:00" }] }).mon).toMatch(/después de la inicial/);
    expect(validateHours({ mon: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] }).mon).toMatch(/solapar/);
    expect(validateHours({ mon: [{ start: "", end: "12:00" }] }).mon).toMatch(/Completa/);
    expect(validateHours({ mon: [{ start: "08:00", end: "12:00" }] }, CLINIC).mon).toMatch(/Fuera del horario de la clínica \(09:00–18:00\)/);
    expect(validateHours({ sun: [{ start: "10:00", end: "12:00" }] }, CLINIC).sun).toMatch(/no atiende ese día/);
    expect(validateHours({ sat: [{ start: "09:00", end: "13:00" }] }, CLINIC)).toEqual({});
  });

  it("compactHours quita dias vacios y ordena los tramos", () => {
    expect(compactHours({ mon: [], tue: [{ start: "14:00", end: "16:00" }, { start: "09:00", end: "10:00" }] })).toEqual({
      tue: [{ start: "09:00", end: "10:00" }, { start: "14:00", end: "16:00" }],
    });
  });
});

describe("textos", () => {
  it("messageFor prefiere el detalle del servidor y cuida los casos de red y 5xx", () => {
    expect(messageFor(new ApiError({ status: 409, code: "horario_ocupado", detail: "Dr. X ya tiene una cita en ese horario." }))).toBe("Dr. X ya tiene una cita en ese horario.");
    expect(messageFor(new ApiError({ status: 409, code: "horario_ocupado" }))).toBe("Ese horario ya no está libre.");
    expect(messageFor(new ApiError({ status: 0, code: "red" }))).toMatch(/No hay conexión/);
    expect(messageFor(new ApiError({ status: 502, code: "desconocido", detail: "El servidor respondio 502." }))).toMatch(/problema/);
    expect(messageFor(new Error("boom"))).toMatch(/inesperado/);
  });

  it("formatos de fecha en la hora de Cancun", () => {
    expect(fmtDateTime("2026-11-12T16:00:00.000Z")).toBe("jue 12 nov · 11:00");
    expect(fmtSpan("2026-11-12T16:00:00.000Z", 30)).toBe("11:00 – 11:30");
    expect(fmtPhone("529980001234")).toBe("+52 998 000 1234");
    expect(fmtPhone("14155550123")).toBe("+14155550123");
  });

  it("ago", () => {
    const t = new Date("2026-11-10T15:00:00Z");
    expect(ago(t, new Date(t.getTime() + 2_000))).toBe("ahora mismo");
    expect(ago(t, new Date(t.getTime() + 30_000))).toBe("hace 30 s");
    expect(ago(t, new Date(t.getTime() + 5 * 60_000))).toBe("hace 5 min");
  });
});

describe("permisos y rutas", () => {
  it("cada rol ve lo suyo", () => {
    expect(permissionsFor("admin")).toMatchObject({ manageUsers: true, manageDoctors: true, editClinicHours: true, manageAppointments: true, toggleBot: true });
    expect(permissionsFor("staff")).toMatchObject({ manageUsers: false, manageDoctors: false, editClinicHours: false, manageAppointments: true, manageDoctorSchedules: true, toggleBot: true, handleAttention: true });
    expect(permissionsFor("doctor").useAdminWeb).toBe(false);
    expect(permissionsFor(null).useAdminWeb).toBe(false);
  });

  it("canOpen: Usuarios solo para el administrador; un doctor no abre nada", () => {
    expect(NAV.filter((n) => canOpen("staff", n.path)).map((n) => n.path)).toEqual(["/calendario", "/doctores", "/atencion"]);
    expect(NAV.filter((n) => canOpen("admin", n.path)).map((n) => n.path)).toEqual(["/calendario", "/doctores", "/atencion", "/usuarios"]);
    expect(NAV.filter((n) => canOpen("doctor", n.path))).toEqual([]);
    expect(canOpen("admin", "/no-existe")).toBe(false);
  });

  it("la direccion lleva la ruta y los filtros", () => {
    expect(hrefFor("/calendario", { vista: "semana", dia: "2026-11-12", doctor: null, canceladas: "" })).toBe("#/calendario?vista=semana&dia=2026-11-12");
    const r = parseHash("#/calendario?vista=semana&dia=2026-11-12");
    expect(r.path).toBe("/calendario");
    expect(r.query.get("vista")).toBe("semana");
    expect(parseHash("").path).toBe("/");
    expect(parseHash("#/doctores").query.get("x")).toBeNull();
  });
});
