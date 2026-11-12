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

describe("Las ausencias se ven en la rejilla (franja rayada con el motivo)", () => {
  const count = (html: string) => html.split("data-absence").length - 1;
  const band = (html: string) => html.split("<div ").filter((d) => d.includes("data-absence"));
  const HOUR = 48; // px por hora de la rejilla
  const allDay = { startUtc: utc(DAY, "00:00"), endUtc: utc("2026-11-18", "00:00"), reason: "Congreso" };

  it("una ausencia de todo el día llena la columna de ese día, con su motivo, y no se pinta en otros días", () => {
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} absences={[allDay]} />);
    expect(count(html)).toBe(1);
    const [b] = band(html);
    expect(b).toContain('aria-label="Ausencia · Congreso"');
    expect(b).toContain("cal-absence");
    expect(b).toContain(`top:1px;height:${24 * HOUR - 1}px`);
    expect(b).toContain("Ausencia · Congreso</span>");   // la etiqueta visible
    // otro día: nada
    expect(count(renderToStaticMarkup(<TimeGrid {...common} days={["2026-11-19"]} bookings={[]} absences={[allDay]} />))).toBe(0);
  });

  it("por horas: la franja va de su hora de inicio a la de fin, en la hora de la clínica", () => {
    const a = { startUtc: utc(DAY, "10:00"), endUtc: utc(DAY, "12:00"), reason: null };
    const [b] = band(renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} absences={[a]} />));
    expect(b).toContain(`top:${10 * HOUR + 1}px;height:${2 * HOUR - 1}px`);
    expect(b).toContain('aria-label="Ausencia"');
  });

  it("de varios días: una franja en cada columna que toca, en la semana", () => {
    const week = datesOf(visibleRange("semana", DAY)); // lun 16 a dom 22
    const a = { startUtc: utc("2026-11-18", "00:00"), endUtc: utc("2026-11-21", "00:00"), reason: "Vacaciones" }; // mié, jue y vie
    const html = renderToStaticMarkup(<TimeGrid {...common} days={week} bookings={[]} absences={[a]} />);
    expect(count(html)).toBe(3);
    for (const day of ["2026-11-18", "2026-11-19", "2026-11-20"]) {
      expect(html.split(`data-day="${day}"`)[1]!.split("data-day=")[0], day).toContain("data-absence");
    }
    for (const day of ["2026-11-16", "2026-11-17", "2026-11-21", "2026-11-22"]) {
      expect(html.split(`data-day="${day}"`)[1]!.split("data-day=")[0], day).not.toContain("data-absence");
    }
  });

  it("una ausencia larga (semanas) se pinta en una semana que queda lejos de donde empezó", () => {
    const larga = { startUtc: utc("2026-11-01", "00:00"), endUtc: utc("2026-12-31", "00:00"), reason: "Licencia" };
    const week = datesOf(visibleRange("semana", "2026-12-09"));
    expect(count(renderToStaticMarkup(<TimeGrid {...common} days={week} bookings={[]} absences={[larga]} />))).toBe(7);
  });

  it("con carriles: una ausencia con laneId solo va en ese carril; sin laneId va en todos", () => {
    const delPerez = { ...allDay, laneId: "perez", reason: "Solo Pérez" };
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} lanes={lanes} absences={[delPerez]} />);
    const col = (id: string) => html.split(`data-lane="${id}"`)[1]!.split("data-lane=")[0]!;
    expect(col("perez")).toContain("Solo Pérez");
    expect(col("cervantes")).not.toContain("data-absence");
    expect(col("geydi")).not.toContain("data-absence");
    expect(count(html)).toBe(1);

    const detodos = { startUtc: allDay.startUtc, endUtc: allDay.endUtc, reason: "Cierre" }; // sin laneId
    const all = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} lanes={lanes} absences={[detodos]} />);
    expect(count(all)).toBe(3);
  });

  it("sin ausencias no hay franjas; la cita dentro de una ausencia se sigue viendo (queda por encima)", () => {
    const cita = mk("1", "11:00", "1", "1");
    expect(count(renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[cita]} />))).toBe(0);
    expect(count(renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[cita]} absences={[]} />))).toBe(0);
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[cita]} absences={[allDay]} />);
    expect(html).toContain("Paciente 1,");
    expect(html.indexOf("data-absence")).toBeLessThan(html.indexOf("Paciente 1,"));   // la franja va antes: la cita queda encima
    expect(html).toMatch(/z-\[5\]/);                                                     // y por debajo de las citas (z-10)
  });

  it("no tapa los clics: tocar un hueco dentro de la ausencia sigue siendo tocar el hueco; y una ausencia muy corta no lleva texto pero si nombre accesible", () => {
    const corta = { startUtc: utc(DAY, "10:00"), endUtc: utc(DAY, "10:30"), reason: "Trámite" };
    const [b] = band(renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} absences={[corta]} />));
    expect(b).toContain("pointer-events-none");
    expect(b).toContain('aria-label="Ausencia · Trámite"');
    expect(b).not.toContain("truncate");                                                 // 30 min = 23 px: no cabe la etiqueta
  });
});

describe("«No disponible»: el doctor ocupado por un evento personal (lo que ve el personal)", () => {
  const busyCount = (html: string) => html.split("data-busy").length - 1;
  const band = (html: string) => html.split("<div ").filter((d) => d.includes("data-busy"));
  const HOUR = 48;
  const busy = { startUtc: utc(DAY, "10:00"), endUtc: utc(DAY, "11:30"), kind: "busy" as const };

  it("franja gris «No disponible», sin motivo, en la hora de la clinica; no cuenta como ausencia", () => {
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} absences={[busy]} />);
    expect(busyCount(html)).toBe(1);
    expect(html.split("data-absence").length - 1).toBe(0);                     // no se confunde con una ausencia
    const [b] = band(html);
    expect(b).toContain("cal-busy");
    expect(b).not.toContain("cal-absence");
    expect(b).toContain('aria-label="No disponible"');
    expect(b).toContain(`top:${10 * HOUR + 1}px;height:${1.5 * HOUR - 1}px`);
    expect(b).toContain("No disponible</span>");
  });

  it("jamas muestra un motivo: aunque llegue uno (el evento es privado del doctor)", () => {
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} absences={[{ ...busy, reason: "Cirugía de la Sra. Quintana" }]} />);
    expect(html).not.toContain("Quintana");
    expect(html).not.toContain("Cirug");
    expect(html).toContain("No disponible");
  });

  it("con carriles va solo en el carril de su doctor, y convive con una ausencia en la misma rejilla", () => {
    const ausencia = { startUtc: utc(DAY, "14:00"), endUtc: utc(DAY, "15:00"), reason: "Trámite", laneId: "cervantes" };
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} lanes={lanes} absences={[{ ...busy, laneId: "perez" }, ausencia]} />);
    const col = (id: string) => html.split(`data-lane="${id}"`)[1]!.split("data-lane=")[0]!;
    expect(busyCount(col("perez"))).toBe(1);
    expect(busyCount(col("cervantes"))).toBe(0);
    expect(col("cervantes")).toContain("data-absence");
    expect(col("cervantes")).toContain("Ausencia · Trámite");
  });
});

describe("Eventos personales del doctor en su agenda (con su texto)", () => {
  const HOUR = 48;
  const ev = (id: string, from: string, to: string, over: object = {}) => ({ id, title: "Evento " + id, startUtc: utc(DAY, from), endUtc: utc(DAY, to), ...over });
  const evs = (html: string) => html.split("<button").filter((d) => d.includes("data-personal-event"));

  it("un bloque con su titulo y horario, distinto de una cita (no es una cita de la clinica)", () => {
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} personalEvents={[ev("7", "13:00", "14:00", { title: "Comida con residentes" })]} />);
    const [b] = evs(html);
    expect(b).toContain('data-personal-event="7"');
    expect(b).toContain("cal-personal");
    expect(b).toContain("Comida con residentes");
    expect(b).toContain('aria-label="Evento personal: Comida con residentes, 1:00 PM a 2:00 PM"');   // 12 h con espacio duro
    expect(b).toContain(`top:${13 * HOUR + 1}px;height:${HOUR - 2}px`);
    expect(b).not.toContain("background-color:#");                      // sin el color de ningun doctor
  });

  it("se ve junto a las citas: la columna se reparte si se encimaran, y las citas siguen ahi", () => {
    const cita = mk("1", "13:00", "1", "1");
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[cita]} personalEvents={[ev("7", "13:00", "14:00")]} />);
    expect(html).toContain("Paciente 1,");
    const [b] = evs(html);
    expect(b).toContain("width:calc(50% - 4px)");                        // dos en la misma franja: mitad y mitad
    // sin encimarse, cada uno usa todo el ancho
    const solo = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[cita]} personalEvents={[ev("7", "15:00", "16:00")]} />);
    expect(evs(solo)[0]).toContain("width:calc(100% - 4px)");
  });

  it("dos eventos encimados se reparten el ancho", () => {
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} personalEvents={[ev("1", "10:00", "11:00"), ev("2", "10:30", "11:30")]} />);
    expect(evs(html)).toHaveLength(2);
    expect(evs(html).every((b) => b.includes("width:calc(50% - 4px)"))).toBe(true);
  });

  it("uno que cruza la medianoche se recorta en cada dia (zona de la clinica) y en la semana aparece en dos columnas", () => {
    const noche = ev("9", "22:00", "23:59", { endUtc: utc("2026-11-18", "02:00") });
    const week = datesOf(visibleRange("semana", DAY));
    const html = renderToStaticMarkup(<TimeGrid {...common} days={week} bookings={[]} personalEvents={[noche]} />);
    expect(evs(html)).toHaveLength(2);
    expect(html.split(`data-day="${DAY}"`)[1]!.split("data-day=")[0]).toContain('data-personal-event="9"');
    expect(html.split('data-day="2026-11-18"')[1]!.split("data-day=")[0]).toContain('data-personal-event="9"');
    expect(html.split('data-day="2026-11-19"')[1]!.split("data-day=")[0]).not.toContain("data-personal-event");
  });

  it("no se pinta en otro dia", () => {
    const e = [ev("7", "13:00", "14:00")];
    expect(evs(renderToStaticMarkup(<TimeGrid {...common} days={["2026-11-19"]} bookings={[]} personalEvents={e} />))).toHaveLength(0);
  });

  it("con carriles (la vista «Hoy» de la PWA tiene uno): en el carril de su laneId, o en todos si no trae", () => {
    const col = (html: string, id: string) => html.split(`data-lane="${id}"`)[1]!.split("data-lane=")[0]!;
    const propio = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} lanes={lanes} personalEvents={[ev("7", "13:00", "14:00", { laneId: "perez" })]} />);
    expect(evs(col(propio, "perez"))).toHaveLength(1);
    expect(evs(col(propio, "cervantes"))).toHaveLength(0);
    expect(evs(col(propio, "geydi"))).toHaveLength(0);
    const detodos = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} lanes={[lanes[0]!]} personalEvents={[ev("8", "13:00", "14:00")]} />);
    expect(evs(detodos)).toHaveLength(1);                                                       // un solo carril: ahi sale
    const varios = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} lanes={lanes} personalEvents={[ev("9", "13:00", "14:00")]} />);
    expect(evs(varios)).toHaveLength(3);                                                        // sin laneId: en todos
  });

  it("el evento seleccionado se resalta por SU id (no por el de una cita con el mismo id)", () => {
    const cita = mk("7", "09:00", "1", "1");                              // la cita tiene el id "7" igual que el evento
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[cita]} selectedId="7" personalEvents={[ev("7", "13:00", "14:00")]} />);
    expect(evs(html)[0]).not.toContain("ring-offset-1");                  // (el resaltado lleva ring-offset-1; el foco, solo focus-visible:ring-*)
    const sel = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[]} selectedEventId="7" personalEvents={[ev("7", "13:00", "14:00")]} />);
    expect(evs(sel)[0]).toContain("ring-offset-1");
  });
});

describe("Al pasar el puntero por una cita se dice el doctor, su especialidad y el consultorio", () => {
  const titleOf = (html: string, patient: string) => {
    const btn = html.split("<button").find((b) => b.includes(patient)) ?? "";
    return btn.match(/ title="([^"]*)"/)?.[1];
  };
  const drCervantes = { id: "cervantes", name: "Dr. cervantes", specialty: "Proctología" };
  const drPerez = { id: "perez", name: "Dr. perez", specialty: "Ginecología" };
  const cita = mk("1", "10:00", "cervantes", "1", { doctor: drCervantes });   // «Dr. cervantes», Proctología, «Consultorio 1»

  it("rejilla de día o semana: «doctor · especialidad · consultorio»", () => {
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[cita]} />);
    expect(titleOf(html, "Paciente 1,")).toBe("Dr. cervantes · Proctología · Consultorio 1");
  });

  it("con carriles (el doctor ya es la columna y la cita solo escribe el consultorio) el aviso lleva los dos", () => {
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[cita]} lanes={lanes} />);
    expect(titleOf(html, "Paciente 1,")).toBe("Dr. cervantes · Proctología · Consultorio 1");
    expect(html).toContain('aria-label="Paciente 1, Consultorio 1,');   // lo visible/accesible no cambia
  });

  it("también en una cita corta o angosta que no alcanza a escribirlos", () => {
    const a = mk("2", "10:00", "cervantes", "1", { doctor: drCervantes });
    const b = mk("3", "10:00", "perez", "2", { doctor: drPerez });          // se encima con la otra: columna a medias
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[a, b]} />);
    expect(titleOf(html, "Paciente 2,")).toBe("Dr. cervantes · Proctología · Consultorio 1");
    expect(titleOf(html, "Paciente 3,")).toBe("Dr. perez · Ginecología · Consultorio 2");
  });

  it("un bloqueo de consultorio no tiene doctor: solo el consultorio", () => {
    const bloqueo = mk("4", "12:00", "x", "2", { kind: "block", doctor: null, patient: null, notes: "Mantenimiento" });
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[bloqueo]} />);
    expect(titleOf(html, "Mantenimiento,")).toBe("Consultorio 2");
  });

  it("lo que falte se omite: sin especialidad (o en blanco) o sin consultorio no quedan «·» sueltos", () => {
    const sinEsp = mk("7", "14:00", "x", "1", { doctor: { id: "x", name: "Dr. x", specialty: "  " } });
    const sinSala = mk("8", "15:00", "cervantes", "1", { doctor: drCervantes, room: null });
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[sinEsp, sinSala]} />);
    expect(titleOf(html, "Paciente 7,")).toBe("Dr. x · Consultorio 1");
    expect(titleOf(html, "Paciente 8,")).toBe("Dr. cervantes · Proctología");
  });

  it("sin doctor ni consultorio no hay aviso (en vez de un aviso vacío)", () => {
    const sola = mk("5", "13:00", "x", "x", { doctor: null, room: null });
    const html = renderToStaticMarkup(<TimeGrid {...common} days={[DAY]} bookings={[sola]} />);
    expect(titleOf(html, "Paciente 5,")).toBeUndefined();
  });

  it("vista de mes: cada cita del día lleva el aviso", () => {
    const html = renderToStaticMarkup(
      <MonthGrid weeks={monthWeeks(DAY)} month="2026-11" bookings={[cita, mk("6", "11:00", "perez", "2", { doctor: drPerez })]} timezone={TZ} today={DAY} selectedId={null} onSelect={() => {}} onOpenDay={() => {}} />
    );
    expect(titleOf(html, "Paciente 1")).toBe("Dr. cervantes · Proctología · Consultorio 1");
    expect(titleOf(html, "Paciente 6")).toBe("Dr. perez · Ginecología · Consultorio 2");
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
