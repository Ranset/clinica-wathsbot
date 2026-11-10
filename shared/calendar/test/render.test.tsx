import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgendaList, MonthGrid, TimeGrid, monthWeeks, datesOf, visibleRange, zonedWallClockToUtc, type Booking, type Lane, type WeeklyHours } from "../src";

const TZ = "America/Cancun";
const DAY = "2026-11-17"; // martes
const CLINIC: WeeklyHours = {
  mon: [{ start: "09:00", end: "18:00" }], tue: [{ start: "09:00", end: "18:00" }], wed: [{ start: "09:00", end: "18:00" }],
  thu: [{ start: "09:00", end: "18:00" }], fri: [{ start: "09:00", end: "18:00" }], sat: [{ start: "09:00", end: "13:00" }],
};
const PEREZ: WeeklyHours = { tue: [{ start: "10:00", end: "14:00" }] };

const utc = (day: string, hhmm: string) => zonedWallClockToUtc(day, hhmm, TZ)!.toISOString();
function mk(id: string, hhmm: string, doctor: string, room: string, over: Partial<Booking> = {}): Booking {
  return {
    id, kind: "session", status: "agendada", source: "manual", scheduledAtUtc: utc(DAY, hhmm), durationMinutes: 30,
    patient: { id: "p" + id, name: "Paciente " + id }, doctor: { id: doctor, name: "Dr. " + doctor, specialty: "X" },
    room: { id: room, name: "Consultorio " + room }, notes: null, ...over,
  };
}
const lanes: Lane[] = [
  { id: "cervantes", label: "Dr. cervantes", sublabel: "Proctología", weeklyHours: CLINIC },
  { id: "perez", label: "Dr. perez", sublabel: "Ginecología", weeklyHours: PEREZ },
  { id: "geydi", label: "Dra. geydi", sublabel: "Anestesiología", weeklyHours: { sat: [{ start: "09:00", end: "13:00" }] } },
];
const common = { timezone: TZ, weeklyHours: CLINIC, today: DAY, nowMinutes: 600, tzLabel: "GMT-5", selectedId: null, ready: true, onSelect() {}, onEmptySlot() {}, onOpenDay() {} };
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("TimeGrid en modo carriles (un carril por doctor)", () => {
  const bookings = [mk("1", "09:00", "cervantes", "1", { source: "ai" }), mk("2", "11:00", "perez", "2"), mk("3", "11:00", "cervantes", "2")];
  const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={bookings} lanes={lanes} />);

  it("pinta una columna por carril con doctor y especialidad", () => {
    expect(count(html, "data-lane=")).toBe(3);
    for (const l of lanes) {
      expect(html).toContain(l.label);
      expect(html).toContain(l.sublabel!);
    }
  });

  it("pone cada cita solo en la columna de su doctor", () => {
    const col = (id: string) => html.split(`data-lane="${id}"`)[1]!.split("data-lane=")[0]!;
    expect(count(col("cervantes"), "<button")).toBe(2);
    expect(count(col("perez"), "<button")).toBe(1);
    expect(count(col("geydi"), "<button")).toBe(0);
  });

  it("sombrea lo que esta fuera del horario de CADA doctor", () => {
    const col = (id: string) => html.split(`data-lane="${id}"`)[1]!.split("data-lane=")[0]!;
    const off = (id: string) => count(col(id), "cal-off");
    expect(off("cervantes")).toBe(2); // 00-09 y 18-24
    expect(off("perez")).toBe(2); // 00-10 y 14-24
    expect(off("geydi")).toBe(1); // el martes no atiende: todo el dia sombreado
  });

  it("la segunda linea es el consultorio y el bot se marca", () => {
    expect(html).toContain("Consultorio 1");
    expect(html).toContain('aria-label="Agendó el bot"');
    expect(count(html, 'aria-label="Agendó el bot"')).toBe(1);
  });
});

describe("TimeGrid en modo semana (columnas por dia)", () => {
  const range = visibleRange("semana", DAY);
  const days = datesOf(range);
  const html = renderToStaticMarkup(<TimeGrid {...common} days={days} bookings={[mk("1", "09:00", "cervantes", "1")]} />);
  it("pinta 7 dias y la cita muestra doctor y consultorio", () => {
    expect(days).toHaveLength(7);
    expect(count(html, "data-day=")).toBe(7);
    expect(html).toContain("Dr. cervantes · Consultorio 1");
  });
});

describe("Citas especiales", () => {
  it("un bloqueo usa su nota y una cancelada se ve tachada", () => {
    const block = mk("b", "13:00", "x", "2", { kind: "block", patient: null, doctor: null, notes: "Mantenimiento" });
    const canc = mk("c", "15:00", "cervantes", "1", { status: "cancelada" });
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[block, canc]} />);
    expect(html).toContain("Mantenimiento");
    expect(html).toContain("line-through");
  });
  it("una cita que cruza la medianoche UTC se pinta en el dia de la clinica", () => {
    // 22:30 en Cancun = 03:30 UTC del dia siguiente
    const late = mk("l", "22:30", "cervantes", "1");
    expect(late.scheduledAtUtc.slice(0, 10)).toBe("2026-11-18");
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[late]} />);
    expect(html).toContain("Paciente l");
  });
});

describe("Mes y Lista", () => {
  it("la lista agrupa por dia y muestra doctor, consultorio y estado", () => {
    const html = renderToStaticMarkup(
      <AgendaList range={{ from: DAY, to: DAY }} bookings={[mk("1", "09:00", "cervantes", "1", { source: "ai" })]} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain("Dr. cervantes · Consultorio 1");
    expect(html).toContain("Agendó el bot");
    expect(html).toContain("Agendada");
  });
  it("la lista vacia dice que no hay nada", () => {
    const html = renderToStaticMarkup(<AgendaList range={{ from: DAY, to: DAY }} bookings={[]} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} />);
    expect(html).toContain("Nada agendado");
  });
  it("el mes pinta las citas", () => {
    const html = renderToStaticMarkup(
      <MonthGrid weeks={monthWeeks(DAY)} month="2026-11" bookings={[mk("1", "09:00", "cervantes", "1")]} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} onOpenDay={() => {}} />
    );
    expect(html).toContain("Paciente 1");
  });
});
