"""Motor de agenda: PORT de `bot/scheduler.py` sobre SQL.

Se conserva la logica determinista (`find_doctor`, reparto de `free_slots`, `nearest`, claves y codigos de error en
espanol). Cambia el origen de los datos (repositorio SQL en vez de Google Calendar) y la exclusion mutua: ya no hay
`threading.Lock` ni re-verificacion posterior; reservar es UNA transaccion y los UNIQUE de `appointment_blocks`
deciden la carrera.

Dos superficies:
  - Para el bot (dicts en espanol como `scheduler.py`; los errores son `{"error": codigo}`):
    `free_slots`, `nearest`, `book`, `mine`, `cancel`, `reschedule`.
  - Para el personal/API (lanzan `AgendaError`): `create_booking`, `update_booking`, `get_booking`, `list_bookings`.

Reglas (todas, tambien al reprogramar): doctor libre en CUALQUIER consultorio y al menos un consultorio libre;
dentro del horario de la clinica y del doctor; doctor sin ausencia; alineado a 30 min; antelacion minima 60 min;
horizonte 60 dias. `allow_short_notice` omite SOLO la antelacion minima (no permite el pasado).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import is_unique_violation, to_db, utcnow
from ..models import SOURCES, STATUSES, Appointment, AppointmentBlock, Doctor, Room
from .audit import BOT, SYSTEM, Actor, audit
from .errors import (CITA_NO_ENCONTRADA, DOCTOR_NO_DISPONIBLE, ESPECIALIDAD, FALTA_NOMBRE, FUERA_DE_HORARIO,
                     FUERA_DE_RANGO, HORARIO_OCUPADO, HORARIO_PASADO, NO_ENCONTRADO, RANGO_INVALIDO, TRANSICION_INVALIDA,
                     VALIDACION, AgendaError)
from .repo import Repo
from .uow import Unit
from .util import iso, norm, overlaps

_UTC = timezone.utc
UNSET = object()
#: cuantos dias como maximo se piden de una vez a `move_slots` (la cuadricula de un mes de la web son 42)
MAX_MOVE_SLOT_DAYS = 42
#: el rango de inicios que se ofrece al mover un BLOQUEO de consultorio (de 7:00 a 20:00, como el selector de la web)
BLOCK_FIRST_HOUR, BLOCK_LAST_HOUR = 7, 20

#: transiciones de estado permitidas (contrato: PATCH /api/appointments/{id})
TRANSITIONS = {
    "agendada": {"realizada", "no_show", "cancelada"},
    "realizada": {"no_show"},
    "no_show": {"realizada"},
    "cancelada": set(),
}


def find_doctor(specialty, doctors):
    """Doctor cuya especialidad o alias coincide con lo que pidio el paciente (sinonimos y errores menores), o None.
    Port de `scheduler.find_doctor`: los nombres a comparar son la etiqueta mas los alias de la BD."""
    q = norm(specialty or "")
    for d in doctors:
        names = [d.specialty] + list(d.aliases or [])
        if any(norm(n) in q or q in norm(n) for n in names if q):
            return d
    return None


class _Ctx:
    """Datos de un rango para un doctor, traidos en pocas consultas (reemplaza a `_busy` + `slot_state`)."""

    def __init__(self, agenda: "Agenda", repo: Repo, doc: Doctor, lo: datetime, hi: datetime):
        self.rules = agenda.rules
        self.doc = doc
        self.rooms = repo.rooms()
        self.clinic = repo.clinic_schedule()
        self.sched = repo.doctor_schedule(doc, self.clinic)
        lo_u, hi_u = to_db(lo), to_db(hi)
        self.busy = repo.busy(lo_u, hi_u)
        # ausencias Y eventos personales del doctor: para el motor son lo mismo (el doctor no se ofrece en esa franja)
        self.absences = repo.absences(doc.id, lo_u, hi_u) + repo.personal_events(doc.id, lo_u, hi_u)

    def attends(self, start: datetime) -> bool:
        """El doctor trabaja en ese hueco (horario propio) y no esta ausente ni tiene un evento personal."""
        if not self.sched.has_slot(start):
            return False
        a, b = to_db(start), to_db(start + self.rules.slot)
        return not any(overlaps(a, b, x, y) for x, y in self.absences)

    def slot_state(self, start: datetime):
        """(ok, consultorios_libres). Port de `Agenda.slot_state`: ok si el doctor atiende y esta libre (en cualquier
        consultorio) y al menos un consultorio esta libre."""
        su = to_db(start)
        doc_busy = self.busy.doctor_taken(self.doc.id, su)
        free = [r for r in self.rooms if not self.busy.room_taken(r.id, su)]
        return (not doc_busy and bool(free) and self.attends(start)), free


class Agenda(Unit):
    # ------------------------------------------------------------------ catalogo
    def find_doctor(self, specialty) -> Doctor | None:
        with self._read() as repo:
            return find_doctor(specialty, repo.doctors())

    def _unknown_specialty(self, repo: Repo) -> dict:
        return {"error": ESPECIALIDAD, "especialidades": [d.specialty for d in repo.doctors()]}

    def _bot_view(self, a: Appointment) -> dict:
        return {"cita_id": str(a.id), "doctor": a.doctor.name, "especialidad": a.doctor.specialty,
                "consultorio": a.room.name, "inicio": iso(a.start_utc.replace(tzinfo=_UTC), self.rules.tz),
                "paciente": a.patient_name}

    def bot_config(self) -> dict:
        """Doctores activos y limites para armar el prompt del bot (`BotConfig` del contrato)."""
        r = self.rules
        with self._read() as repo:
            clinic = repo.clinic_schedule()
            return {"timezone": r.tz.key, "slotMinutes": r.slot_minutes, "minNoticeMinutes": r.min_notice_minutes,
                    "horizonDays": r.horizon_days, "clinicHours": clinic.to_weekly(),
                    "doctors": [{"name": d.name, "specialty": d.specialty,
                                 "weeklyHours": repo.doctor_schedule(d, clinic).to_weekly(),
                                 "usesClinicHours": bool(d.uses_clinic_hours)} for d in repo.doctors()]}

    # ------------------------------------------------------------------ lectura (bot)
    def free_slots(self, specialty, from_day: date | None = None, days=7, limit=6, hora_min=None, hora_max=None):
        r = self.rules
        with self._read() as repo:
            doc = find_doctor(specialty, repo.doctors())
            if not doc:
                return self._unknown_specialty(repo)
            now = self.now()
            earliest = now + timedelta(minutes=r.min_notice_minutes)
            latest = now + timedelta(days=r.horizon_days)
            d0 = from_day or earliest.date()
            d0 = max(d0, earliest.date())
            horizon = min(days, r.horizon_days)
            ctx = _Ctx(self, repo, doc, datetime.combine(d0, time(0), r.tz),
                       datetime.combine(d0 + timedelta(days=horizon), time(0), r.tz))
            out = []
            for i in range(horizon):
                for s in ctx.clinic.all_slots(d0 + timedelta(days=i)):
                    if s < earliest or s > latest:  # `latest`: el original no acotaba un `from_day` lejano
                        continue
                    if hora_min is not None and s.hour + s.minute / 60 < hora_min:
                        continue
                    if hora_max is not None and s.hour + s.minute / 60 >= hora_max:
                        continue
                    ok, _free = ctx.slot_state(s)
                    if ok:
                        out.append(s)
            # repartir: primeros dias con huecos, y horas variadas dentro de cada dia
            # (manana / mediodia / tarde) en lugar de siempre la primera hora.
            by_day = {}
            for s in out:
                by_day.setdefault(s.date(), []).append(s)
            days_ok = sorted(by_day)[:3]
            fracs = [0.0, 0.5, 0.8, 0.25, 0.65, 0.95]
            picked = []
            n = 0
            while len(picked) < limit and any(by_day[d] for d in days_ok) and n < 60:
                d = days_ok[n % len(days_ok)]
                lst = by_day[d]
                if lst:
                    picked.append(lst.pop(int(fracs[n % len(fracs)] * len(lst)) if len(lst) > 1 else 0))
                n += 1
            picked.sort()
            res = {"doctor": doc.name, "especialidad": doc.specialty, "horarios": [iso(s, r.tz) for s in picked]}
            if not picked:
                res["nota"] = "sin horarios libres con esos criterios en los dias consultados"
            return res

    def nearest(self, specialty, target: datetime, limit=3, window_days=7):
        """Huecos libres mas cercanos a la fecha/hora que pidio el paciente.
        Respeta antelacion minima y horizonte maximo. 'exacto' = el horario pedido esta libre."""
        r = self.rules
        if target.tzinfo is None:
            target = target.replace(tzinfo=r.tz)
        with self._read() as repo:
            doc = find_doctor(specialty, repo.doctors())
            if not doc:
                return self._unknown_specialty(repo)
            now = self.now()
            earliest = now + timedelta(minutes=r.min_notice_minutes)
            latest = now + timedelta(days=r.horizon_days)
            res = {"doctor": doc.name, "especialidad": doc.specialty, "maximo_agendable": latest.date().isoformat()}
            if target > latest:
                res.update(error=FUERA_DE_RANGO, horarios=[],
                           nota=f"solo se agenda hasta {r.horizon_days} dias a futuro")
                return res
            note = None
            if target < earliest:
                note = (f"el horario pedido ya paso o requiere {r.min_notice_minutes} min de antelacion; "
                        "se buscan los primeros disponibles")
                target = earliest
            lo = max(earliest.date(), (target - timedelta(days=window_days)).date())
            hi = min(latest.date(), (target + timedelta(days=window_days)).date())
            ctx = _Ctx(self, repo, doc, datetime.combine(lo, time(0), r.tz),
                       datetime.combine(hi + timedelta(days=1), time(0), r.tz))
            cands = []
            d = lo
            while d <= hi:
                for s in ctx.clinic.all_slots(d):
                    if earliest <= s <= latest and ctx.slot_state(s)[0]:
                        cands.append(s)
                d += timedelta(days=1)
            cands.sort(key=lambda s: (abs((s - target).total_seconds()), s))
            top = cands[:limit]
            exact = bool(top) and top[0] == target.replace(second=0, microsecond=0)
            top.sort()
            res.update(exacto=exact, horarios=[iso(x, r.tz) for x in top])
            if note:
                res["nota"] = note
            if not top:
                res["nota"] = "sin horarios libres cerca de esa fecha"
            return res

    def mine(self, phone) -> list[dict]:
        """Citas agendadas, futuras o en curso, del paciente (por telefono). Incluye las que creo el personal."""
        now = self.now()
        with self._read() as repo:
            rows = repo.upcoming_for_phone(phone, to_db(now), to_db(now + timedelta(days=self.rules.horizon_days + 30)))
            return sorted((self._bot_view(a) for a in rows), key=lambda x: x["inicio"])

    # ------------------------------------------------------------------ escritura (bot)
    def _bot(self, work):
        try:
            return self._write(work)
        except AgendaError as e:
            return e.body()

    def book(self, phone, patient_name, specialty, start: datetime, *, source="ai", actor: Actor = BOT):
        with self._read() as repo:
            doc = find_doctor(specialty, repo.doctors())
            if not doc:
                return self._unknown_specialty(repo)
        if not patient_name or len(patient_name.split()) < 2:
            return {"error": FALTA_NOMBRE}
        if not phone:  # sin telefono el paciente no podria ver, cancelar ni mover su cita
            return {"error": VALIDACION, "detail": "falta el telefono del paciente"}

        def work(repo, s):
            a = self._create(repo, s, kind="session", start=start, minutes=self.rules.slot_minutes,
                             patient_name=patient_name, phone=phone, doctor_id=doc.id, room_id=None, notes=None,
                             allow_short_notice=False, source=source, actor=actor)
            return {"ok": True, **self._bot_view(a)}
        return self._bot(work)

    def cancel(self, phone, cita_id, *, actor: Actor = BOT):
        def work(repo, s):
            a = repo.own_appointment(phone, cita_id, lock=True)
            if a is None:
                raise AgendaError(CITA_NO_ENCONTRADA)
            view = self._bot_view(a)
            self._set_status(repo, s, a, "cancelada", actor)
            return {"ok": True, "cancelada": view}
        return self._bot(work)

    def reschedule(self, phone, cita_id, new_start: datetime, *, actor: Actor = BOT):
        """Mueve la cita DEL PACIENTE en una sola transaccion: si el nuevo horario falla, la original se conserva."""
        def work(repo, s):
            a = repo.own_appointment(phone, cita_id, lock=True)
            if a is None:
                raise AgendaError(CITA_NO_ENCONTRADA)
            old = iso(a.start_utc.replace(tzinfo=_UTC), self.rules.tz)  # sin SQL: _move bloquea antes de leer nada mas
            self._move(repo, s, a, new_start, room_id=None, allow_short_notice=False, actor=actor)
            return {"ok": True, **self._bot_view(a), "reprogramada_desde": old}
        return self._bot(work)

    # ------------------------------------------------------------------ personal / API
    def create_booking(self, *, start: datetime, kind="session", duration_minutes=None, patient_name=None, phone=None,
                       doctor_id=None, room_id=None, notes=None, allow_short_notice=False, source="manual",
                       actor: Actor = SYSTEM) -> Appointment:
        """Alta manual de una cita (`kind='session'`) o de un bloqueo de consultorio (`kind='block'`)."""
        minutes = self.rules.slot_minutes if duration_minutes is None else duration_minutes
        return self._write(lambda repo, s: self._create(
            repo, s, kind=kind, start=start, minutes=minutes, patient_name=patient_name, phone=phone,
            doctor_id=doctor_id, room_id=room_id, notes=notes, allow_short_notice=allow_short_notice, source=source,
            actor=actor))

    def update_booking(self, appointment_id, *, status=None, start: datetime | None = None, room_id=None,
                       notes=UNSET, allow_short_notice=False, actor: Actor = SYSTEM) -> Appointment:
        """Cambia estado, mueve (atomico) o edita notas. Un cambio de estado no se combina con mover."""
        def work(repo, s):
            a = repo.appointment(appointment_id, lock=True)
            if a is None:
                raise AgendaError(NO_ENCONTRADO)
            if status is not None and status not in STATUSES:
                raise AgendaError(VALIDACION, f"estado desconocido: {status!r}")
            changing = status is not None and status != a.status
            moving = start is not None or room_id is not None
            if changing and moving:
                raise AgendaError(VALIDACION, "no combines un cambio de estado con mover la cita")
            if changing:
                self._set_status(repo, s, a, status, actor)
            elif moving:
                if a.status != "agendada":
                    raise AgendaError(TRANSICION_INVALIDA, f"una cita {a.status} no se puede mover")
                self._move(repo, s, a, start, room_id=room_id, allow_short_notice=allow_short_notice, actor=actor)
            if notes is not UNSET:
                a.notes = self._clean_notes(notes)
            a.doctor, a.room  # noqa: B018 - se cargan AHORA: la capa de rutas serializa despues de cerrar la sesion
            return a
        return self._write(work)

    def move_slots(self, appointment_id, from_day: date, to_day: date, *, room_id=None, allow_short_notice=False) -> dict:
        """Los horarios LIBRES a los que se puede mover esa cita agendada, dia por dia en `[from_day, to_day)`: exactamente los que
        `update_booking` aceptaria (mismas reglas que `_move`: horario de la clinica y del doctor, ausencias y eventos personales,
        antelacion, horizonte, doctor y consultorio libres), pero sin reservar nada. Su PROPIO horario cuenta como libre para ella.
        Con `room_id` solo cuentan los huecos libres en ESE consultorio; sin el, en cualquiera (un bloqueo se queda en el suyo).
        Un bloqueo no sigue las reglas de pacientes: se ofrecen los inicios de 7:00 a 20:00 donde su consultorio este libre.
        -> `{"slotMinutes", "durationMinutes", "days": [{"date": "AAAA-MM-DD", "slots": ["HH:MM", ...]}]}` (solo dias con algun
        horario libre; hora de pared de la clinica)."""
        r = self.rules
        if to_day <= from_day or (to_day - from_day).days > MAX_MOVE_SLOT_DAYS:
            raise AgendaError(RANGO_INVALIDO, f"el rango debe ser de 1 a {MAX_MOVE_SLOT_DAYS} dias")
        with self._read() as repo:
            a = repo.appointment(appointment_id)
            if a is None:
                raise AgendaError(NO_ENCONTRADO)
            if a.status != "agendada":
                raise AgendaError(TRANSICION_INVALIDA, f"una cita {a.status} no se puede mover")
            now = self.now()
            minutes = a.duration_minutes
            if room_id is None and a.kind == "block":
                room_id = a.room_id
            if room_id is not None:
                room = repo.room(room_id)
                if room is None:
                    raise AgendaError(VALIDACION, "consultorio inexistente o inactivo")
                candidates = [room]
            else:
                candidates = repo.rooms()
            lo = datetime.combine(from_day, time(0), r.tz)
            hi = datetime.combine(to_day, time(0), r.tz) + timedelta(minutes=minutes)       # + lo que ocupa el ultimo inicio
            lo_u, hi_u = to_db(lo), to_db(hi)
            busy = repo.busy(lo_u, hi_u, ignore_appointment_id=a.id)
            floor = now if allow_short_notice else now + timedelta(minutes=r.min_notice_minutes)
            latest = now + timedelta(days=r.horizon_days)

            def rooms_free(slots_u):
                return any(not any(busy.room_taken(rm.id, x) for x in slots_u) for rm in candidates)

            days = []
            if a.kind == "session":
                doc = a.doctor
                clinic = repo.clinic_schedule()
                sched = repo.doctor_schedule(doc, clinic)
                away = (repo.absences(doc.id, lo_u, hi_u) + repo.personal_events(doc.id, lo_u, hi_u)) if doc.active else []
                for i in range((to_day - from_day).days):
                    day = from_day + timedelta(days=i)
                    found = []
                    for s in (clinic.all_slots(day) if doc.active else []):
                        if s < floor or s > latest:
                            continue
                        slots = self._slots(s, minutes)
                        if not all(clinic.has_slot(x) and sched.has_slot(x) for x in slots):
                            continue
                        slots_u = [to_db(x) for x in slots]
                        if any(overlaps(slots_u[0], slots_u[-1] + r.slot, x, y) for x, y in away):
                            continue
                        if any(busy.doctor_taken(doc.id, x) for x in slots_u) or not rooms_free(slots_u):
                            continue
                        found.append(s.strftime("%H:%M"))
                    if found:
                        days.append({"date": day.isoformat(), "slots": found})
            else:
                for i in range((to_day - from_day).days):
                    day = from_day + timedelta(days=i)
                    found = []
                    for k in range(BLOCK_FIRST_HOUR * 60 // r.slot_minutes, BLOCK_LAST_HOUR * 60 // r.slot_minutes):
                        s = datetime.combine(day, time(0), r.tz) + r.slot * k
                        if s + timedelta(minutes=minutes) <= now:
                            continue                                                                  # ya termino: no se mueve al pasado
                        if rooms_free([to_db(x) for x in self._slots(s, minutes)]):
                            found.append(s.strftime("%H:%M"))
                    if found:
                        days.append({"date": day.isoformat(), "slots": found})
            return {"slotMinutes": r.slot_minutes, "durationMinutes": minutes, "days": days}

    def get_booking(self, appointment_id) -> Appointment | None:
        with self._read() as repo:
            return repo.appointment(appointment_id)

    def list_bookings(self, start: datetime, end: datetime, *, doctor_id=None, room_id=None, status=None):
        with self._read() as repo:
            return repo.list_range(start, end, doctor_id=doctor_id, room_id=room_id, status=status)

    # ------------------------------------------------------------------ nucleo transaccional
    def _create(self, repo: Repo, s: Session, *, kind, start, minutes, patient_name, phone, doctor_id, room_id, notes,
                allow_short_notice, source, actor) -> Appointment:
        r = self.rules
        if kind not in ("session", "block"):
            raise AgendaError(VALIDACION, f"kind desconocido: {kind!r}")
        if source not in SOURCES:
            raise AgendaError(VALIDACION, f"source desconocido: {source!r}")
        self._check_duration(minutes)
        start = self._aware(start)
        now = self.now()
        notes = self._clean_notes(notes)
        # lo primero que lee la transaccion (ver Repo.lock_rooms); id invalido -> validacion
        try:
            repo.lock_rooms([int(room_id)] if room_id is not None else None)
        except (TypeError, ValueError):
            raise AgendaError(VALIDACION, "consultorio invalido") from None

        if kind == "block":
            if doctor_id is not None:
                raise AgendaError(VALIDACION, "un bloqueo de consultorio no lleva doctor")
            if room_id is None:
                raise AgendaError(VALIDACION, "un bloqueo de consultorio exige roomId")
            room = repo.room(room_id)
            if room is None:
                raise AgendaError(VALIDACION, "consultorio inexistente o inactivo")
            slots = self._check_block(start, minutes, now)
            candidates, doctor, name, phone_ = [room], None, None, None
        else:
            doctor = repo.doctor(doctor_id) if doctor_id is not None else None
            if doctor is None:
                raise AgendaError(VALIDACION, "doctor inexistente o no indicado")
            name = self._clean_name(patient_name)
            phone_ = self._clean_phone(phone)
            slots = self._check_bookable(repo, doctor, start, minutes, allow_short_notice=allow_short_notice, now=now)
            if room_id is not None:
                room = repo.room(room_id)
                if room is None:
                    raise AgendaError(VALIDACION, "consultorio inexistente o inactivo")
                candidates = [room]
            else:
                candidates = repo.rooms()

        slots_u = [to_db(x) for x in slots]
        free = self._free_rooms(repo, doctor, candidates, slots_u)
        appt = Appointment(kind=kind, status="agendada", source=source, phone=phone_, patient_name=name,
                           doctor=doctor, room=free[0], start_utc=slots_u[0], duration_minutes=minutes, notes=notes,
                           created_by_id=actor.user_id)
        s.add(appt)
        s.flush()
        appt.room = self._place(s, appt.id, doctor.id if doctor else None, slots_u, free)
        audit(s, actor, "appointment.create", "appointment", appt.id,
              {"kind": kind, "source": source, "start": iso(slots[0], r.tz), "minutes": minutes,
               "doctorId": doctor.id if doctor else None, "roomId": appt.room.id})
        return appt

    def _move(self, repo: Repo, s: Session, a: Appointment, start: datetime | None, *, room_id, allow_short_notice,
              actor: Actor) -> None:
        """Mueve una cita agendada (hueco y/o consultorio) dentro de la transaccion en curso.

        Libera primero los huecos propios y luego reserva los nuevos (asi un cambio de 10:00 a 10:30 de una cita larga, o
        de solo consultorio, no choca consigo misma). Si algo falla se lanza un error y la transaccion entera se revierte:
        la cita original queda intacta, con sus huecos."""
        r = self.rules
        if room_id is None and a.kind == "block":
            room_id = a.room_id  # un bloqueo sigue en SU consultorio salvo que se pida otro
        try:
            repo.lock_rooms([int(room_id)] if room_id is not None else None)  # antes de cualquier otra lectura
        except (TypeError, ValueError):
            raise AgendaError(VALIDACION, "consultorio invalido") from None
        old_start = a.start_utc.replace(tzinfo=_UTC).astimezone(r.tz)
        new_start = self._aware(start) if start is not None else old_start
        time_changed = new_start != old_start
        now = self.now()
        doctor = a.doctor
        if a.kind == "session":
            if time_changed:
                slots = self._check_bookable(repo, doctor, new_start, a.duration_minutes,
                                             allow_short_notice=allow_short_notice, now=now)
            else:
                slots = self._slots(new_start, a.duration_minutes)
        else:
            slots = self._check_block(new_start, a.duration_minutes, now)
        if room_id is not None:
            room = repo.room(room_id)
            if room is None:
                raise AgendaError(VALIDACION, "consultorio inexistente o inactivo")
            candidates = [room]
        else:
            candidates = repo.rooms()
        slots_u = [to_db(x) for x in slots]
        repo.delete_blocks(a.id)
        free = self._free_rooms(repo, doctor, candidates, slots_u)
        a.room = self._place(s, a.id, doctor.id if doctor else None, slots_u, free)
        a.start_utc = slots_u[0]
        audit(s, actor, "appointment.move", "appointment", a.id,
              {"from": iso(old_start, r.tz), "to": iso(slots[0], r.tz), "roomId": a.room.id})

    def _set_status(self, repo: Repo, s: Session, a: Appointment, status: str, actor: Actor) -> None:
        allowed = TRANSITIONS[a.status]
        if a.kind == "block":  # un bloqueo solo se levanta (cancelada)
            allowed = allowed & {"cancelada"}
        if status not in allowed:
            raise AgendaError(TRANSICION_INVALIDA, f"{a.status} -> {status}")
        before = a.status
        a.status = status
        if status == "cancelada":  # libera el hueco
            a.cancelled_at = utcnow()
            repo.delete_blocks(a.id)
        audit(s, actor, "appointment.cancel" if status == "cancelada" else "appointment.status", "appointment", a.id,
              {"from": before, "to": status})

    def _place(self, s: Session, appointment_id: int, doctor_id, slots_u: list[datetime], rooms: list[Room]) -> Room:
        """Inserta los bloques en el primer consultorio donde el UNIQUE lo permite. Cada intento va en un SAVEPOINT:
        si choca (otro proceso reservo lo mismo antes), se descarta solo ese intento y se prueba el siguiente."""
        for room in rooms:
            try:
                with s.begin_nested():
                    for slot in slots_u:
                        s.add(AppointmentBlock(appointment_id=appointment_id, doctor_id=doctor_id, room_id=room.id,
                                               slot_start=slot))
                    s.flush()
            except IntegrityError as e:
                if not is_unique_violation(e):
                    raise
                continue
            return room
        raise AgendaError(HORARIO_OCUPADO)

    def _free_rooms(self, repo: Repo, doctor: Doctor | None, candidates: list[Room], slots_u: list[datetime]) -> list[Room]:
        """Consultorios libres en TODOS los huecos, si el doctor tambien esta libre. Es solo una pre-comprobacion para
        no insertar a ciegas: la decision final es del UNIQUE."""
        busy = repo.busy(slots_u[0], slots_u[-1] + self.rules.slot)
        if doctor is not None and any(busy.doctor_taken(doctor.id, x) for x in slots_u):
            raise AgendaError(HORARIO_OCUPADO)
        free = [rm for rm in candidates if not any(busy.room_taken(rm.id, x) for x in slots_u)]
        if not free:
            raise AgendaError(HORARIO_OCUPADO)
        return free

    # ------------------------------------------------------------------ validaciones
    def _aware(self, dt: datetime) -> datetime:
        if dt.tzinfo is None:
            return dt.replace(tzinfo=self.rules.tz)
        return dt.astimezone(self.rules.tz)

    def _slots(self, start: datetime, minutes: int) -> list[datetime]:
        return [start + self.rules.slot * i for i in range(minutes // self.rules.slot_minutes)]

    def _check_duration(self, minutes) -> None:
        r = self.rules
        if (not isinstance(minutes, int) or isinstance(minutes, bool) or minutes <= 0 or minutes % r.slot_minutes
                or minutes > r.max_duration_minutes):
            raise AgendaError(VALIDACION, f"la duracion debe ser multiplo de {r.slot_minutes} min "
                                          f"(maximo {r.max_duration_minutes})")

    def _check_bookable(self, repo: Repo, doc: Doctor, start: datetime, minutes: int, *, allow_short_notice: bool,
                        now: datetime) -> list[datetime]:
        """Port de `_check_bookable` + horario/ausencias del doctor. Devuelve los huecos (con zona) que ocupara."""
        r = self.rules
        floor = now if allow_short_notice else now + timedelta(minutes=r.min_notice_minutes)
        if start < floor:
            raise AgendaError(HORARIO_PASADO)
        if start > now + timedelta(days=r.horizon_days):
            raise AgendaError(FUERA_DE_RANGO)
        slots = self._slots(start, minutes)
        clinic = repo.clinic_schedule()
        if not all(clinic.has_slot(x) for x in slots):
            raise AgendaError(FUERA_DE_HORARIO)
        if not doc.active:
            raise AgendaError(DOCTOR_NO_DISPONIBLE, "el doctor esta inactivo")
        if not all(repo.doctor_schedule(doc, clinic).has_slot(x) for x in slots):
            raise AgendaError(DOCTOR_NO_DISPONIBLE, "fuera del horario del doctor")
        lo, hi = to_db(slots[0]), to_db(slots[-1] + r.slot)
        if repo.absences(doc.id, lo, hi):
            raise AgendaError(DOCTOR_NO_DISPONIBLE, "el doctor esta ausente")
        if repo.personal_events(doc.id, lo, hi):
            # a proposito sin decir por que: el evento es privado del doctor (tambien para el personal)
            raise AgendaError(DOCTOR_NO_DISPONIBLE, "el doctor no esta disponible en ese horario")
        return slots

    def _check_block(self, start: datetime, minutes: int, now: datetime) -> list[datetime]:
        """Un bloqueo no sigue las reglas de pacientes (antelacion, horizonte, horario de la clinica): solo debe estar
        alineado a la rejilla y no haber terminado ya."""
        r = self.rules
        if (start.hour * 60 + start.minute) % r.slot_minutes or start.second or start.microsecond:
            raise AgendaError(FUERA_DE_HORARIO, f"el bloqueo debe empezar en una marca de {r.slot_minutes} min")
        if start + timedelta(minutes=minutes) <= now:
            raise AgendaError(HORARIO_PASADO)
        return self._slots(start, minutes)

    @staticmethod
    def _clean_name(name) -> str:
        name = " ".join(str(name or "").split())
        if len(name.split()) < 2:
            raise AgendaError(FALTA_NOMBRE)
        if len(name) > 120:
            raise AgendaError(VALIDACION, "nombre demasiado largo")
        return name

    @staticmethod
    def _clean_phone(phone) -> str | None:
        if phone is None or str(phone).strip() == "":
            return None
        phone = str(phone).strip()
        if not phone.isdigit() or len(phone) > 20:
            raise AgendaError(VALIDACION, "el telefono debe ser solo digitos")
        return phone

    @staticmethod
    def _clean_notes(notes) -> str | None:
        if notes is None:
            return None
        notes = str(notes).strip()
        if len(notes) > 500:
            raise AgendaError(VALIDACION, "notas: maximo 500 caracteres")
        return notes or None

