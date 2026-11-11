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
from ..models import Appointment, ClinicHours, Doctor, DoctorAbsence, DoctorHours
from .audit import SYSTEM, Actor, audit
from .errors import FUERA_DE_HORARIO, NO_ENCONTRADO, VALIDACION, AgendaError
from .hours import Schedule, validate_weekly
from .repo import Repo
from .uow import Unit
from .util import iso

_UTC = timezone.utc


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

    # ---- escritura ----
    def set_clinic_hours(self, weekly: dict, actor: Actor = SYSTEM) -> dict:
        self._validate(weekly)

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

        def work(repo: Repo, s):
            doc = self._doctor(repo, doctor_id)
            clinic = repo.clinic_schedule()
            if weekly is None:
                new = clinic
            else:
                new = Schedule.from_weekly(self.rules, weekly)
                for wd, a, b in new.rows():
                    if not any(ca <= a and b <= cb for ca, cb in clinic.by_weekday.get(wd, [])):
                        raise AgendaError(FUERA_DE_HORARIO, "el horario del doctor debe quedar dentro del de la clinica")
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
        return self._write(work)

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

    # ---- internos ----
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
