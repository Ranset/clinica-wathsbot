import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import {
  AgendaList,
  CalendarToolbar,
  MonthGrid,
  TimeGrid,
  addDaysISO,
  calendarVisible,
  monthWeeks,
  rangeLabel,
  shiftRange,
  todayInTz,
  tzOffsetLabel,
  visibleRange,
  wallClock,
  zonedWallClockToUtc,
  datesOf,
  type Booking,
  type CalendarView,
  type Lane,
  type WeeklyHours,
} from "../src";

const TZ = "America/Cancun";
const CLINIC: WeeklyHours = {
  mon: [{ start: "09:00", end: "18:00" }], tue: [{ start: "09:00", end: "18:00" }], wed: [{ start: "09:00", end: "18:00" }],
  thu: [{ start: "09:00", end: "18:00" }], fri: [{ start: "09:00", end: "18:00" }], sat: [{ start: "09:00", end: "13:00" }],
};

const DOCTORS = [
  { id: "d1", name: "Dr. Cervantes Peláez", specialty: "Proctología" },
  { id: "d2", name: "Dr. Pérez Lago", specialty: "Ginecología", hours: { tue: [{ start: "10:00", end: "14:00" }], thu: [{ start: "10:00", end: "14:00" }] } as WeeklyHours },
  { id: "d3", name: "Dra. Bordas Rodríguez", specialty: "Ortopedia" },
  { id: "d4", name: "Dr. Gustavo Torrealba", specialty: "Ultrasonidos" },
  { id: "d5", name: "Dr. Molina López", specialty: "Otorrinolaringología" },
  { id: "d6", name: "Dra. Geydi", specialty: "Anestesiología", hours: { sat: [{ start: "09:00", end: "13:00" }] } as WeeklyHours },
  { id: "d7", name: "Dra. Ana del Carmen Argüelles", specialty: "Reumatología" },
];
const ROOMS = [{ id: "r1", name: "Consultorio 1" }, { id: "r2", name: "Consultorio 2" }];
const PATIENTS = ["Ranset Fleites", "Lisy Rodríguez", "Luciano Tomás", "Leidy Martín", "Ale Gómez", "Viridiana Cruz", "Jennifer Díaz", "Pedro Juárez"];

function demoBookings(today: string): Booking[] {
  const out: Booking[] = [];
  let n = 0;
  const add = (dayOffset: number, hhmm: string, dur: number, di: number, ri: number, status: Booking["status"] = "agendada", source: Booking["source"] = "ai") => {
    const day = addDaysISO(today, dayOffset);
    const d = DOCTORS[di]!;
    out.push({
      id: `b${++n}`, kind: "session", status, source,
      scheduledAtUtc: zonedWallClockToUtc(day, hhmm, TZ)!.toISOString(),
      durationMinutes: dur,
      patient: { id: `p${n}`, name: PATIENTS[n % PATIENTS.length]! },
      doctor: { id: d.id, name: d.name, specialty: d.specialty },
      room: ROOMS[ri]!, notes: null,
    });
  };
  for (let o = -2; o <= 9; o++) {
    add(o, "09:00", 30, 0, 0, o < 0 ? "realizada" : "agendada");
    add(o, "09:00", 30, 2, 1, o < 0 ? "no_show" : "agendada", "manual");
    add(o, "10:30", 30, 3, 0);
    add(o, "11:00", 60, 4, 1, "agendada", "manual");
    add(o, "12:00", 30, 6, 0);
    add(o, "16:00", 30, 0, 1);
  }
  add(1, "10:00", 30, 1, 0); add(1, "10:30", 30, 1, 1); add(3, "11:00", 30, 1, 0);
  out.push({
    id: "blk", kind: "block", status: "agendada", source: "manual",
    scheduledAtUtc: zonedWallClockToUtc(addDaysISO(today, 2), "14:00", TZ)!.toISOString(), durationMinutes: 120,
    patient: null, doctor: null, room: ROOMS[1]!, notes: "Mantenimiento",
  });
  return out;
}

function App() {
  const now = useMemo(() => new Date(), []);
  const today = todayInTz(now, TZ);
  const params = new URLSearchParams(location.search);
  const [view, setView] = useState<CalendarView>((params.get("view") as CalendarView) || "semana");
  const [anchor, setAnchor] = useState(params.get("day") || today);
  const [listTo, setListTo] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [byRoom, setByRoom] = useState(params.get("lanes") === "room");
  const [msg, setMsg] = useState("");

  const bookings = useMemo(() => calendarVisible(demoBookings(today), { showCancelled: false }), [today]);
  const range = visibleRange(view, anchor, listTo);
  const days = datesOf(range);
  const lanes: Lane[] | undefined =
    view === "dia"
      ? byRoom
        ? ROOMS.map((r) => ({ id: r.id, label: r.name }))
        : DOCTORS.map((d) => ({ id: d.id, label: d.name, sublabel: d.specialty, weeklyHours: d.hours ?? CLINIC }))
      : undefined;

  return (
    <div className="flex h-full flex-col">
      <CalendarToolbar
        view={view} anchor={anchor} listTo={listTo ?? range.to}
        label={rangeLabel(view, anchor, listTo)} loading={false}
        onToday={() => setAnchor(today)}
        onShift={(dir) => { const r = shiftRange(view, anchor, dir, listTo); setAnchor(r.anchor); setListTo(r.listTo); }}
        onJump={(d) => setAnchor(d)}
        onView={(v) => { setView(v); setListTo(null); }}
        onListRange={(f, t) => { setAnchor(f); setListTo(t); }}
        onBlock={() => setMsg("Bloquear horario")}
      />
      {view === "dia" && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-text-3 sm:px-6">
          Columnas por:
          <button className={byRoom ? "text-text-2 underline" : "font-semibold text-brand-text"} onClick={() => setByRoom(false)}>doctor</button>
          <button className={byRoom ? "font-semibold text-brand-text" : "text-text-2 underline"} onClick={() => setByRoom(true)}>consultorio</button>
          {msg && <span className="ml-auto">{msg}</span>}
        </div>
      )}
      <main className="flex min-h-0 flex-1 flex-col p-4 sm:px-6">
        {(view === "dia" || view === "semana") && (
          <TimeGrid
            days={days} bookings={bookings} timezone={TZ} weeklyHours={CLINIC} today={today}
            nowMinutes={wallClock(now, TZ).minutes} tzLabel={tzOffsetLabel(TZ, now)}
            selectedId={selected} ready lanes={lanes}
            onSelect={(b) => setSelected(b.id)}
            onEmptySlot={(d, t, lane) => setMsg(`Hueco vacío ${d} ${t}${lane ? " · " + lane : ""}`)}
            onOpenDay={(d) => { setAnchor(d); setView("dia"); }}
          />
        )}
        {view === "mes" && (
          <MonthGrid weeks={monthWeeks(anchor)} month={anchor.slice(0, 7)} bookings={bookings} timezone={TZ} today={today}
            selectedId={selected} onSelect={(b) => setSelected(b.id)} onOpenDay={(d) => { setAnchor(d); setView("dia"); }} />
        )}
        {view === "lista" && (
          <AgendaList range={range} bookings={bookings} timezone={TZ} today={today} selectedId={selected} onSelect={(b) => setSelected(b.id)} />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
