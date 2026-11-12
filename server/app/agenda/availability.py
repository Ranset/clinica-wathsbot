"""Disponibilidad: horario de la clinica, horario propio del doctor y ausencias.

Reglas del contrato:
- El horario propio del doctor debe quedar DENTRO del de la clinica (`fuera_de_horario` si no).
- Cambiar el horario o crear una ausencia surte efecto de inmediato (el doctor deja de ofrecerse) y NO cancela citas:
  se devuelven las citas afectadas para que el personal avise (el bot no puede escribir primero).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from ..db import to_db
from ..models import Appointment, ClinicHours, Doctor, DoctorAbsence, DoctorHours, PersonalEvent
from .audit import SYSTEM, Actor, audit
from .errors import EVENTO_CON_CITA, FUERA_DE_HORARIO, NO_ENCONTRADO, VALIDACION, AgendaError
from .hours import Schedule, validate_weekly
from .repo import Repo
from .service import UNSET
from .uow import Unit
from .util import iso

_UTC = timezone.utc

# Eventos personales del doctor
EVENT_TITLE_MAX = 120
EVENT_NOTES_MAX = 1000
EVENT_MAX_HOURS = 24          # mas largo (varios dias) es una ausencia, que si avisa al personal
EVENT_WINDOW_DAYS = 400       # no se aceptan fechas absurdas (ni 1900 ni 2100)


class Availability(Unit):
    # ---- lectura ----
    def clinic_weekly(self) -> dict:
        with self._read() as repo:
            return repo.clinic_schedule().to_weekly()

    def doctor_weekly(self, doctor_id) -> tuple[dict, bool]:
        """(horario efectivo en formato `WeeklyHours`, usa_horario_de_la_clinica)."""
        with self._read() as repo:
            doc = self._doctor(repo, doctor_id)
            return repo.doctor_schedule(doc, repo.clinic_schedule()).to_weekly(), doc.uses_clinic_hours

    def list_absences(self, doctor_id, start: datetime | None = None, end: datetime | None = None) -> list[DoctorAbsence]:
        with self._read() as repo:
            self._doctor(repo, doctor_id)
            q = select(DoctorAbsence).where(DoctorAbsence.doctor_id == int(doctor_id)).order_by(DoctorAbsence.start_utc)
            if start is not None:
                q = q.where(DoctorAbsence.end_utc > to_db(start))
            if end is not None:
                q = q.where(DoctorAbsence.start_utc < to_db(end))
            return list(repo.s.scalars(q))

    def absences_between(self, start: datetime, end: datetime) -> list[DoctorAbsence]:
        """Ausencias de TODOS los doctores que se solapan con [start, end) (para sombrear el calendario del personal)."""
        with self._read() as repo:
            q = (select(DoctorAbsence).where(DoctorAbsence.end_utc > to_db(start), DoctorAbsence.start_utc < to_db(end))
                 .order_by(DoctorAbsence.start_utc, DoctorAbsence.id))
            return list(repo.s.scalars(q))

    def list_personal_events(self, doctor_id, start: datetime, end: datetime) -> list[PersonalEvent]:
        """Los eventos PROPIOS del doctor que se solapan con [start, end) (con titulo y notas: solo para su duenio)."""
        with self._read() as repo:
            self._doctor(repo, doctor_id)
            q = (select(PersonalEvent).where(PersonalEvent.doctor_id == int(doctor_id), PersonalEvent.end_utc > to_db(start),
                                             PersonalEvent.start_utc < to_db(end))
                 .order_by(PersonalEvent.start_utc, PersonalEvent.id))
            return list(repo.s.scalars(q))

    def busy_between(self, start: datetime, end: datetime) -> list[tuple[int, int, datetime, datetime]]:
        """`(id, doctor_id, start_utc, end_utc)` de los eventos personales de TODOS los doctores en [start, end), para
        sombrear el calendario del personal. A proposito solo se consultan esas 4 columnas: el titulo y las notas son
        privados del doctor y no deben cargarse siquiera en el camino del personal."""
        with self._read() as repo:
            q = (select(PersonalEvent.id, PersonalEvent.doctor_id, PersonalEvent.start_utc, PersonalEvent.end_utc)
                 .where(PersonalEvent.end_utc > to_db(start), PersonalEvent.start_utc < to_db(end))
                 .order_by(PersonalEvent.start_utc, PersonalEvent.id))
            return [tuple(r) for r in repo.s.execute(q)]

    # ---- escritura ----
    def set_clinic_hours(self, weekly: dict, actor: Actor = SYSTEM) -> dict:
        self._validate(weekly)
        if not any(weekly.values()):   # un `{}` por error (o un cliente con un bug) borraria el horario de TODA la clinica
            raise AgendaError(VALIDACION, "el horario de la clinica debe tener al menos un intervalo")

        def work(repo: Repo, s):
            s.execute(delete(ClinicHours))
            for wd, a, b in Schedule.from_weekly(self.rules, weekly).rows():
                s.add(ClinicHours(weekday=wd, start_time=a, end_time=b))
            s.flush()
            audit(s, actor, "clinic_hours.set", "clinic_hours", None, {"weekly": weekly})
            return repo.clinic_schedule().to_weekly()
        return self._write(work)

    def set_doctor_hours(self, doctor_id, weekly: dict | None, actor: Actor = SYSTEM) -> tuple[Doctor, list[Appointment]]:
        """Fija el horario semanal propio, o `None` para volver al de la clinica.
        Devuelve (doctor, citas agendadas futuras que quedan fuera del nuevo horario); no se tocan."""
        if weekly is not None:
            self._validate(weekly)
        return self._write(lambda repo, s: self.apply_hours(repo, s, doctor_id, weekly, actor))

    def check_proposal(self, weekly: dict) -> None:
        """Valida un horario propuesto (forma y que quede dentro del de la clinica) sin guardar nada."""
        self._validate(weekly)
        with self._read() as repo:
            self._check_inside_clinic(repo.clinic_schedule(), Schedule.from_weekly(self.rules, weekly))

    @staticmethod
    def _check_inside_clinic(clinic: Schedule, new: Schedule) -> None:
        for wd, a, b in new.rows():
            if not any(ca <= a and b <= cb for ca, cb in clinic.by_weekday.get(wd, [])):
                raise AgendaError(FUERA_DE_HORARIO, "el horario del doctor debe quedar dentro del de la clinica")

    def apply_hours(self, repo: Repo, s, doctor_id, weekly: dict | None, actor: Actor) -> tuple[Doctor, list[Appointment]]:
        """Nucleo transaccional de `set_doctor_hours`: participa en la transaccion de quien llama (p. ej. aprobar una
        solicitud de cambio de horario, que debe ser atomico con marcarla como aprobada)."""
        doc = self._doctor(repo, doctor_id)
        clinic = repo.clinic_schedule()
        if weekly is None:
            new = clinic
        else:
            self._validate(weekly)
            new = Schedule.from_weekly(self.rules, weekly)
            self._check_inside_clinic(clinic, new)
        s.execute(delete(DoctorHours).where(DoctorHours.doctor_id == doc.id))
        if weekly is not None:
            for wd, a, b in new.rows():
                s.add(DoctorHours(doctor_id=doc.id, weekday=wd, start_time=a, end_time=b))
        doc.uses_clinic_hours = weekly is None
        s.flush()
        s.expire(doc, ["hours"])
        affected = self._outside(repo, doc, new)
        audit(s, actor, "doctor_hours.set", "doctor", doc.id,
              {"weekly": weekly, "affected": [a.id for a in affected]})
        return doc, affected

    def add_absence(self, doctor_id, start: datetime, end: datetime, reason: str | None = None,
                    actor: Actor = SYSTEM) -> tuple[DoctorAbsence, list[Appointment]]:
        """Registra una ausencia; el doctor deja de ofrecerse de inmediato. No cancela citas: las devuelve."""
        start, end = self._aware(start), self._aware(end)
        if start >= end:
            raise AgendaError(VALIDACION, "la ausencia debe terminar despues de empezar")
        if reason is not None and len(reason) > 200:
            raise AgendaError(VALIDACION, "motivo: maximo 200 caracteres")

        def work(repo: Repo, s):
            doc = self._doctor(repo, doctor_id)
            ab = DoctorAbsence(doctor_id=doc.id, start_utc=to_db(start), end_utc=to_db(end),
                               reason=(reason or None), created_by_id=actor.user_id)
            s.add(ab)
            s.flush()
            affected = self._overlapping(repo, doc, to_db(start), to_db(end))
            audit(s, actor, "absence.create", "doctor", doc.id,
                  {"absenceId": ab.id, "from": iso(start, self.rules.tz), "to": iso(end, self.rules.tz),
                   "affected": [a.id for a in affected]})
            return ab, affected
        return self._write(work)

    def delete_absence(self, doctor_id, absence_id, actor: Actor = SYSTEM) -> None:
        def work(repo: Repo, s):
            doc = self._doctor(repo, doctor_id)
            try:
                ab = s.get(DoctorAbsence, int(absence_id))
            except (TypeError, ValueError):
                ab = None
            if ab is None or ab.doctor_id != doc.id:
                raise AgendaError(NO_ENCONTRADO)
            s.delete(ab)
            audit(s, actor, "absence.delete", "doctor", doc.id, {"absenceId": ab.id})
        self._write(work)

    # ---- eventos personales del doctor ----
    def add_personal_event(self, doctor_id, title, notes, start: datetime, end: datetime,
                           actor: Actor = SYSTEM) -> PersonalEvent:
        """Crea un evento personal: el doctor deja de ofrecerse en esa franja (bot, personal y reprogramaciones) pero
        el consultorio queda libre para los demas doctores. NO se admite sobre una cita agendada del doctor
        (`evento_con_cita`): primero hay que mover la cita. En la bitacora solo quedan ids y horas, nunca el texto."""
        start, end = self._aware(start), self._aware(end)
        title, notes = self._clean_event_text(title, notes)
        self._check_event_span(start, end)

        def work(repo: Repo, s):
            # lo primero que lee la transaccion (ver Repo.lock_rooms): hace cola con las reservas, asi o la cita llega
            # antes (y este evento se rechaza) o el evento llega antes (y la reserva ve al doctor ocupado)
            repo.lock_rooms(None)
            doc = self._doctor(repo, doctor_id)
            self._reject_if_session(repo, doc, to_db(start), to_db(end))
            ev = PersonalEvent(doctor_id=doc.id, title=title, notes=notes, start_utc=to_db(start), end_utc=to_db(end))
            s.add(ev)
            s.flush()
            audit(s, actor, "personal_event.create", "doctor", doc.id,
                  {"eventId": ev.id, "from": iso(start, self.rules.tz), "to": iso(end, self.rules.tz)})
            return ev
        return self._write(work)

    def update_personal_event(self, doctor_id, event_id, *, title=UNSET, notes=UNSET, start: datetime | None = None,
                              end: datetime | None = None, actor: Actor = SYSTEM) -> PersonalEvent:
        """Cambia texto y/o horario de un evento PROPIO (ajeno o inexistente: 404). Si cambia el horario se vuelve a
        comprobar contra las citas. Es un parche: lo que no se manda no se toca."""
        def work(repo: Repo, s):
            repo.lock_rooms(None)
            doc = self._doctor(repo, doctor_id)
            ev = self._own_event(s, doc, event_id)
            new_title, new_notes = ev.title, ev.notes
            if title is not UNSET or notes is not UNSET:
                new_title, new_notes = self._clean_event_text(ev.title if title is UNSET else title,
                                                              ev.notes if notes is UNSET else notes)
            new_start = self._aware(start) if start is not None else ev.start_utc.replace(tzinfo=_UTC)
            new_end = self._aware(end) if end is not None else ev.end_utc.replace(tzinfo=_UTC)
            moved = (to_db(new_start), to_db(new_end)) != (ev.start_utc, ev.end_utc)
            if moved:
                self._check_event_span(new_start, new_end)
                self._reject_if_session(repo, doc, to_db(new_start), to_db(new_end))
            ev.title, ev.notes = new_title, new_notes
            ev.start_utc, ev.end_utc = to_db(new_start), to_db(new_end)
            audit(s, actor, "personal_event.update", "doctor", doc.id,
                  {"eventId": ev.id, "from": iso(new_start, self.rules.tz), "to": iso(new_end, self.rules.tz)})
            s.flush()
            return ev
        return self._write(work)

    def delete_personal_event(self, doctor_id, event_id, actor: Actor = SYSTEM) -> None:
        def work(repo: Repo, s):
            doc = self._doctor(repo, doctor_id)
            ev = self._own_event(s, doc, event_id)
            s.delete(ev)
            audit(s, actor, "personal_event.delete", "doctor", doc.id, {"eventId": ev.id})
        self._write(work)

    # ---- internos ----
    @staticmethod
    def _own_event(s, doc: Doctor, event_id) -> PersonalEvent:
        try:
            ev = s.get(PersonalEvent, int(event_id))
        except (TypeError, ValueError):
            ev = None
        if ev is None or ev.doctor_id != doc.id:      # ajeno o inexistente: igual (nunca se distingue)
            raise AgendaError(NO_ENCONTRADO)
        return ev

    @staticmethod
    def _clean_event_text(title, notes) -> tuple[str, str | None]:
        title = " ".join(str(title or "").split())
        if not title:
            raise AgendaError(VALIDACION, "el evento necesita un titulo")
        if len(title) > EVENT_TITLE_MAX:
            raise AgendaError(VALIDACION, f"titulo: maximo {EVENT_TITLE_MAX} caracteres")
        if notes is not None and not isinstance(notes, str):
            raise AgendaError(VALIDACION, "notas: debe ser texto")
        notes = (notes or "").strip() or None
        if notes is not None and len(notes) > EVENT_NOTES_MAX:
            raise AgendaError(VALIDACION, f"notas: maximo {EVENT_NOTES_MAX} caracteres")
        return title, notes

    def _check_event_span(self, start: datetime, end: datetime) -> None:
        if start >= end:
            raise AgendaError(VALIDACION, "el evento debe terminar despues de empezar")
        if end - start > timedelta(hours=EVENT_MAX_HOURS):
            raise AgendaError(VALIDACION, "un evento dura como maximo 24 horas; para varios dias marca una ausencia")
        now = self.now()
        window = timedelta(days=EVENT_WINDOW_DAYS)
        if not (now - window <= start <= now + window):
            raise AgendaError(VALIDACION, "fecha fuera de rango")

    def _reject_if_session(self, repo: Repo, doc: Doctor, start_u: datetime, end_u: datetime) -> None:
        if self._overlapping(repo, doc, start_u, end_u):
            raise AgendaError(EVENTO_CON_CITA,
                              "Ya tienes una cita agendada en ese horario. Pide a recepcion que la mueva y vuelve a intentarlo.")

    def _aware(self, dt: datetime) -> datetime:
        return dt.replace(tzinfo=self.rules.tz) if dt.tzinfo is None else dt.astimezone(self.rules.tz)

    def _validate(self, weekly) -> None:
        try:
            validate_weekly(weekly, self.rules)
        except ValueError as e:
            raise AgendaError(VALIDACION, str(e)) from None

    @staticmethod
    def _doctor(repo: Repo, doctor_id) -> Doctor:
        doc = repo.doctor(doctor_id)
        if doc is None:
            raise AgendaError(NO_ENCONTRADO)
        return doc

    def _future_sessions(self, repo: Repo, doc: Doctor, since_utc: datetime):
        q = (select(Appointment)
             .where(Appointment.doctor_id == doc.id, Appointment.kind == "session", Appointment.status == "agendada",
                    Appointment.start_utc >= since_utc)
             .order_by(Appointment.start_utc, Appointment.id))
        return list(repo.s.scalars(q).unique())

    def _outside(self, repo: Repo, doc: Doctor, sched: Schedule) -> list[Appointment]:
        """Citas futuras que ya no caben en el horario `sched`."""
        out = []
        for a in self._future_sessions(repo, doc, to_db(self.now())):
            start = a.start_utc.replace(tzinfo=_UTC)
            n = a.duration_minutes // self.rules.slot_minutes
            if not all(sched.has_slot(start + self.rules.slot * i) for i in range(n)):
                out.append(a)
        return out

    def _overlapping(self, repo: Repo, doc: Doctor, start_u: datetime, end_u: datetime) -> list[Appointment]:
        """Citas agendadas del doctor que se solapan con [start_u, end_u)."""
        return [a for a in self._future_sessions(repo, doc, start_u - timedelta(minutes=self.rules.max_duration_minutes))
                if a.start_utc < end_u and a.start_utc + timedelta(minutes=a.duration_minutes) > start_u]
