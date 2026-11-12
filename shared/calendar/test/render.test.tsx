import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgendaList, DoctorLegend, MonthGrid, TimeGrid, monthWeeks, datesOf, visibleRange, zonedWallClockToUtc, type Booking, type Lane, type WeeklyHours } from "../src";

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

describe("Cada doctor se ve con su color", () => {
  const AZUL = "#1d4ed8"; // doctor "1"
  const NARANJA = "#c2410c"; // doctor "2"
  const dr1 = mk("1", "09:00", "1", "1");
  const dr2 = mk("2", "11:00", "2", "2");
  const props = { ...common, days: [DAY] };

  it("rejilla: la cita agendada se rellena con el color de SU doctor y cada doctor con el suyo", () => {
    const html = renderToStaticMarkup(<TimeGrid {...props} bookings={[dr1, dr2]} />);
    const btn = (id: string) => html.split("<button").find((b) => b.includes(`Paciente ${id},`)) ?? "";
    expect(btn("1")).toContain(`background-color:${AZUL}`);
    expect(btn("1")).toContain("color:#ffffff");
    expect(btn("2")).toContain(`background-color:${NARANJA}`);
    expect(btn("2")).not.toContain(AZUL);
  });

  it("el color ELEGIDO para el doctor manda sobre el automatico, en la rejilla, el mes, la lista, los carriles y la leyenda", () => {
    const VERDE = "#047857";
    const elegido = mk("1", "09:00", "1", "1", { doctor: { id: "1", name: "Dr. 1", specialty: "X", color: VERDE } });
    const grid = renderToStaticMarkup(<TimeGrid {...props} bookings={[elegido]} />);
    expect(grid).toContain(`background-color:${VERDE}`);
    expect(grid).not.toContain(`background-color:${AZUL}`);                                        // el automatico del doctor 1 ya no se usa
    const sinElegir = mk("2", "10:00", "1", "1", { doctor: { id: "1", name: "Dr. 1", specialty: "X", color: null } });
    expect(renderToStaticMarkup(<TimeGrid {...props} bookings={[sinElegir]} />)).toContain(`background-color:${AZUL}`);
    const month = renderToStaticMarkup(
      <MonthGrid weeks={monthWeeks(DAY)} month="2026-11" bookings={[elegido]} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} onOpenDay={() => {}} />
    );
    expect(month).toContain(`background-color:${VERDE}`);
    const list = renderToStaticMarkup(<AgendaList range={{ from: DAY, to: DAY }} bookings={[elegido]} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} />);
    expect(list).toContain(`background-color:${VERDE}`);
    const legend = renderToStaticMarkup(<DoctorLegend doctors={[{ id: "1", name: "Dr. 1", color: VERDE }, { id: "2", name: "Dr. 2", color: null }]} />);
    expect(legend).toContain(`background-color:${VERDE}`);
    expect(legend).toContain(`background-color:${NARANJA}`);                                        // el doctor 2 sin elegir: su automatico
  });

  it("rejilla: una cita realizada, no asistio o cancelada conserva su estado y lleva una franja del color del doctor", () => {
    for (const status of ["realizada", "no_show", "cancelada"] as const) {
      const html = renderToStaticMarkup(<TimeGrid {...props} bookings={[mk("1", "09:00", "2", "1", { status })]} />);
      expect(html, status).toContain(`border-left-color:${NARANJA}`);
      expect(html, status).toContain("border-left-width:4px");
      expect(html, status).not.toContain(`background-color:${NARANJA}`);   // el fondo sigue siendo el del estado
    }
  });

  it("rejilla: un bloqueo de consultorio no tiene doctor ni color de doctor", () => {
    const block = mk("b", "13:00", "x", "2", { kind: "block", patient: null, doctor: null, notes: "Mantenimiento" });
    const html = renderToStaticMarkup(<TimeGrid {...props} bookings={[block]} />);
    expect(html).toContain("Mantenimiento");
    expect(html).not.toMatch(/background-color:#|border-left-color/);
  });

  it("carriles: el encabezado de cada doctor lleva una franja de su color; sin color no hay franja", () => {
    const withColor: Lane[] = [{ id: "1", label: "Dr. uno", color: AZUL }, { id: "2", label: "Dr. dos", color: NARANJA }, { id: "r1", label: "Consultorio 1" }];
    const html = renderToStaticMarkup(<TimeGrid {...props} bookings={[dr1]} lanes={withColor} laneOf={(b) => b.doctor?.id} />);
    const head = (id: string) => html.split("<div ").find((d) => d.includes(`data-lane-head="${id}"`)) ?? "";
    expect(head("1")).toContain(`border-top-color:${AZUL}`);
    expect(head("2")).toContain(`border-top-color:${NARANJA}`);
    expect(head("r1")).not.toContain("border-top-color");
  });

  it("mes y lista: el puntito de la cita es del color del doctor", () => {
    const month = renderToStaticMarkup(
      <MonthGrid weeks={monthWeeks(DAY)} month="2026-11" bookings={[dr1, dr2]} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} onOpenDay={() => {}} />
    );
    expect(month).toContain(`background-color:${AZUL}`);
    expect(month).toContain(`background-color:${NARANJA}`);
    const list = renderToStaticMarkup(<AgendaList range={{ from: DAY, to: DAY }} bookings={[dr1, dr2]} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} />);
    expect(list).toContain(`background-color:${AZUL}`);
    expect(list).toContain(`background-color:${NARANJA}`);
  });

  it("leyenda: lista a cada doctor con su color; con onSelect son botones que filtran", () => {
    const doctors = [{ id: "1", name: "Dr. Cervantes", specialty: "Proctología" }, { id: "2", name: "Dra. Pérez" }];
    const plain = renderToStaticMarkup(<DoctorLegend doctors={doctors} />);
    expect(plain).toContain('aria-label="Colores por doctor"');
    expect(plain).toContain("Dr. Cervantes");
    expect(plain).toContain("Dra. Pérez");
    expect(plain).toContain(`background-color:${AZUL}`);
    expect(plain).toContain(`background-color:${NARANJA}`);
    expect(plain).not.toContain("<button");
    const filter = renderToStaticMarkup(<DoctorLegend doctors={doctors} selectedId="2" onSelect={() => {}} />);
    expect(filter.match(/<button/g)).toHaveLength(2);
    expect(filter).toContain('aria-pressed="true"');    // el elegido
    expect(filter).toContain('title="Dr. Cervantes · Proctología"');
    expect(renderToStaticMarkup(<DoctorLegend doctors={[]} />)).toBe("");
  });
});

describe("Las horas se ven en formato de 12 h (AM/PM), nunca de 24 h", () => {
  const nb = (s: string) => s.replace(/ (AM|PM)/g, " $1");
  // 24 h que no deben aparecer como texto visible: "09:00", "13:30", "18:00"... (los `data-`/clases no llevan ese formato)
  const hora24 = />\s*(?:[01]\d|2[0-3]):[0-5]\d\s*</;
  const bookings = [mk("1", "09:00", "cervantes", "1"), mk("2", "13:30", "perez", "2")];

  it("la rejilla: columna de horas, hora de la cita y nombre accesible", () => {
    // una cita de 30 min es "compacta" (solo la hora de inicio); una de 60 min muestra el tramo completo
    const largo = mk("3", "15:00", "cervantes", "1", { durationMinutes: 60 });
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[...bookings, largo]} />);
    for (const h of ["1 AM", "9 AM", "11 AM", "12 PM", "1 PM", "6 PM", "11 PM"]) expect(html).toContain(`>${nb(h)}<`);
    expect(html).toContain(`aria-label="Paciente 2, Dr. perez · Consultorio 2, ${nb("1:30 PM")} a ${nb("2:00 PM")}"`);
    expect(html).toContain(`>${nb("1:30 PM")}<`);
    expect(html).toContain(`>${nb("3:00 PM – 4:00 PM")}<`);
    expect(html).not.toMatch(hora24);
  });

  it("la lista: el tramo de cada cita", () => {
    const html = renderToStaticMarkup(
      <AgendaList range={{ from: DAY, to: DAY }} bookings={bookings} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain(nb("9:00 AM – 9:30 AM"));
    expect(html).toContain(nb("1:30 PM – 2:00 PM"));
    expect(html).not.toMatch(hora24);
  });

  it("el mes: la hora de inicio de cada cita", () => {
    const html = renderToStaticMarkup(
      <MonthGrid weeks={monthWeeks(DAY)} month="2026-11" bookings={bookings} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} onOpenDay={() => {}} />
    );
    expect(html).toContain(`>${nb("9 AM")}<`);
    expect(html).toContain(`>${nb("1:30 PM")}<`);
    expect(html).not.toMatch(hora24);
  });

  it("el dato que viaja sigue en 24 h: tocar un hueco entrega 'HH:MM'", () => {
    // `onEmptySlot` y los `value` de los selectores son el formato de la API; solo cambia lo que se lee.
    expect(zonedWallClockToUtc(DAY, "13:30", TZ)!.toISOString()).toBe("2026-11-17T18:30:00.000Z");
  });
});
