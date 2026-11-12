"""Catalogos y casos del personal (F4): consultorios, doctores, solicitudes de cambio de horario, casos de atencion y
suscripciones push. Las reglas de agenda (reservar, horarios, ausencias) viven en `app.agenda`; esto es lo que las rodea.

Los errores se lanzan como `AgendaError` (`validacion` 422, `no_encontrado` 404, `transicion_invalida` 409); la capa de
rutas los traduce. Nada de aqui guarda datos clinicos ni el texto de los pacientes.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Callable

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from .agenda import Availability
from .agenda.audit import SYSTEM, Actor, audit
from .agenda.errors import (DOCTOR_CON_CITAS, DOCTOR_CON_USUARIO, NO_ENCONTRADO, TRANSICION_INVALIDA, VALIDACION,
                            AgendaError)
from .agenda.repo import Repo
from .agenda.rules import Rules
from .agenda.uow import Unit
from .colors import HEX, is_readable_on_white
from .db import is_unique_violation, to_db
from .models import (ATTENTION_STATUSES, REQUEST_STATUSES, Appointment, AppointmentBlock, AttentionCase, Doctor,
                     DoctorAbsence, PushSubscription, Room, ScheduleChangeRequest, User)

MAX_ALIASES, MAX_PENDING_REQUESTS, MAX_PUSH_PER_USER = 20, 3, 10


@dataclass(frozen=True)
class DoctorView:
    id: int
    name: str
    specialty: str
    aliases: list
    active: bool
    weekly: dict
    uses_clinic_hours: bool
    color: str | None = None


@dataclass(frozen=True)
class RequestView:
    id: int
    doctor_id: int
    weekly_hours: dict
    effective_from: date
    note: str | None
    status: str
    created_at: datetime
    decided_by: str | None
    decided_at: datetime | None


def _bad(msg: str) -> AgendaError:
    return AgendaError(VALIDACION, msg)


def _text(value, field: str, maxlen: int, *, required=True) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise _bad(f"{field}: debe ser texto")
    v = " ".join(value.split())
    if required and not v:
        raise _bad(f"{field}: es obligatorio")
    if len(v) > maxlen:
        raise _bad(f"{field}: maximo {maxlen} caracteres")
    return v or None


def _color(value) -> str | None:
    """`None` = automatico; si no, `#rrggbb` (se guarda en minusculas) con texto blanco legible encima."""
    if value is None:
        return None
    if not isinstance(value, str) or not HEX.match(value):
        raise _bad("color: usa el formato #rrggbb (por ejemplo #1d4ed8) o null para el automatico")
    value = value.lower()
    if not is_readable_on_white(value):
        raise _bad("color: es demasiado claro, el texto blanco de las citas no se leeria; elige uno mas oscuro")
    return value


def _aliases(value) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_ALIASES:
        raise _bad(f"aliases: una lista de hasta {MAX_ALIASES} textos")
    out, seen = [], set()
    for a in value:
        a = _text(a, "alias", 60)
        if a.lower() not in seen:
            seen.add(a.lower())
            out.append(a)
    return out


class Directory(Unit):
    def __init__(self, session_factory: sessionmaker[Session], rules: Rules | None = None,
                 clock: Callable[[], datetime] | None = None, *, availability: Availability):
        super().__init__(session_factory, rules, clock)
        self.availability = availability

    def _utc(self) -> datetime:
        return to_db(self.now()).replace(microsecond=0)

    # ------------------------------------------------------------------ consultorios
    def rooms(self) -> list[Room]:
        with self._read() as repo:
            return repo.rooms()

    # ------------------------------------------------------------------ doctores
    @staticmethod
    def _doctor_view(repo: Repo, doc: Doctor, clinic) -> DoctorView:
        return DoctorView(doc.id, doc.name, doc.specialty, list(doc.aliases or []), bool(doc.active),
                          repo.doctor_schedule(doc, clinic).to_weekly(), bool(doc.uses_clinic_hours), doc.color)

    def doctors(self, only_id: int | None = None) -> list[DoctorView]:
        """Todos los doctores (activos o no) con su horario efectivo; `only_id` limita a uno."""
        with self._read() as repo:
            clinic = repo.clinic_schedule()
            return [self._doctor_view(repo, d, clinic) for d in repo.doctors(active_only=False)
                    if only_id is None or d.id == only_id]

    def get_doctor(self, doctor_id) -> DoctorView | None:
        with self._read() as repo:
            doc = repo.doctor(doctor_id)
            return self._doctor_view(repo, doc, repo.clinic_schedule()) if doc else None

    def create_doctor(self, data: dict, actor: Actor = SYSTEM) -> DoctorView:
        name, specialty = _text(data.get("name"), "name", 120), _text(data.get("specialty"), "specialty", 120)
        aliases = _aliases(data.get("aliases", []))
        active = data.get("active", True)
        if not isinstance(active, bool):
            raise _bad("active debe ser verdadero o falso")
        color = _color(data.get("color"))

        def work(repo, s):
            doc = Doctor(name=name, specialty=specialty, aliases=aliases, active=active, color=color, uses_clinic_hours=True)
            s.add(doc)
            s.flush()
            audit(s, actor, "doctor.create", "doctor", doc.id)
            return self._doctor_view(repo, doc, repo.clinic_schedule())
        return self._unique_name(work)

    def update_doctor(self, doctor_id, data: dict, actor: Actor = SYSTEM) -> DoctorView:
        if not data:
            raise _bad("no hay nada que cambiar")
        changes = {}
        if "name" in data:
            changes["name"] = _text(data["name"], "name", 120)
        if "specialty" in data:
            changes["specialty"] = _text(data["specialty"], "specialty", 120)
        if "aliases" in data:
            changes["aliases"] = _aliases(data["aliases"])
        if "active" in data:
            if not isinstance(data["active"], bool):
                raise _bad("active debe ser verdadero o falso")
            changes["active"] = data["active"]
        if "color" in data:                      # null = volver al color automatico
            changes["color"] = _color(data["color"])

        def work(repo, s):
            doc = repo.doctor(doctor_id)
            if doc is None:
                raise AgendaError(NO_ENCONTRADO)
            for k, v in changes.items():
                setattr(doc, k, v)
            s.flush()
            audit(s, actor, "doctor.update", "doctor", doc.id, {"changed": sorted(changes)})
            return self._doctor_view(repo, doc, repo.clinic_schedule())
        return self._unique_name(work)

    def delete_doctor(self, doctor_id, actor: Actor = SYSTEM) -> None:
        """Elimina DEFINITIVAMENTE un doctor. Solo si nunca tuvo citas (ni bloques de agenda) y no hay una cuenta de
        usuario ligada a el: asi no quedan citas huerfanas ni se pierde historial. En cualquier otro caso se da de baja
        (`active=false`). Sus horarios, ausencias y solicitudes de cambio de horario se van con el. Queda en la bitacora."""
        def work(repo, s):
            doc = repo.doctor(doctor_id)
            if doc is None:
                raise AgendaError(NO_ENCONTRADO)
            citas = (s.scalar(select(func.count()).select_from(Appointment).where(Appointment.doctor_id == doc.id)) or 0) \
                + (s.scalar(select(func.count()).select_from(AppointmentBlock).where(AppointmentBlock.doctor_id == doc.id)) or 0)
            if citas:
                raise AgendaError(DOCTOR_CON_CITAS,
                                  "Este doctor tiene citas en el historial: no se puede eliminar. Dalo de baja para que deje de ofrecerse.")
            if s.scalar(select(func.count()).select_from(User).where(User.doctor_id == doc.id)):
                raise AgendaError(DOCTOR_CON_USUARIO,
                                  "Hay una cuenta de usuario ligada a este doctor: elimínala o cámbiala primero en Usuarios.")
            audit(s, actor, "doctor.delete", "doctor", doc.id, {"name": doc.name, "specialty": doc.specialty})
            s.execute(delete(DoctorAbsence).where(DoctorAbsence.doctor_id == doc.id))
            s.execute(delete(ScheduleChangeRequest).where(ScheduleChangeRequest.doctor_id == doc.id))
            s.delete(doc)  # sus tramos de horario se borran en cascada
        self._write(work)

    def _unique_name(self, work):
        try:
            return self._write(work)
        except IntegrityError as e:
            if is_unique_violation(e):
                raise _bad("ya existe un doctor con ese nombre") from None
            raise

    # ------------------------------------------------------------------ solicitudes de cambio de horario
    def _request_view(self, s: Session, r: ScheduleChangeRequest) -> RequestView:
        by = s.get(User, r.decided_by_id).name if r.decided_by_id else None
        return RequestView(r.id, r.doctor_id, r.weekly_hours, r.effective_from, r.note, r.status, r.created_at, by,
                           r.decided_at)

    def create_schedule_change(self, doctor_id, weekly: dict, effective_from, note=None,
                               actor: Actor = SYSTEM) -> RequestView:
        """Un doctor pide un horario permanente nuevo. Se valida ya (forma y dentro del horario de la clinica) para no
        dejar al personal solicitudes que no se pueden aprobar."""
        self.availability.check_proposal(weekly)
        if not isinstance(effective_from, date) or isinstance(effective_from, datetime):
            raise _bad("effectiveFrom: una fecha AAAA-MM-DD")
        if effective_from < self.now().date():
            raise _bad("effectiveFrom no puede ser anterior a hoy")
        note = _text(note, "note", 500, required=False)

        def work(repo, s):
            doc = repo.doctor(doctor_id)
            if doc is None:
                raise AgendaError(NO_ENCONTRADO)
            pending = s.scalar(select(func.count()).select_from(ScheduleChangeRequest).where(
                ScheduleChangeRequest.doctor_id == doc.id, ScheduleChangeRequest.status == "pending"))
            if pending >= MAX_PENDING_REQUESTS:
                raise _bad(f"ya tienes {MAX_PENDING_REQUESTS} solicitudes pendientes; espera a que el personal las revise")
            r = ScheduleChangeRequest(doctor_id=doc.id, weekly_hours=weekly, effective_from=effective_from, note=note,
                                      status="pending", created_at=self._utc())
            s.add(r)
            s.flush()
            audit(s, actor, "schedule_change.create", "doctor", doc.id, {"requestId": r.id})
            return self._request_view(s, r)
        return self._write(work)

    def schedule_changes(self, status: str | None = None, doctor_id: int | None = None) -> list[RequestView]:
        if status is not None and status not in REQUEST_STATUSES:
            raise _bad("status: " + " | ".join(REQUEST_STATUSES))
        with self._read() as repo:
            q = select(ScheduleChangeRequest).order_by(ScheduleChangeRequest.id.desc())
            if status:
                q = q.where(ScheduleChangeRequest.status == status)
            if doctor_id is not None:
                q = q.where(ScheduleChangeRequest.doctor_id == doctor_id)
            return [self._request_view(repo.s, r) for r in repo.s.scalars(q)]

    def _pending_request(self, s: Session, request_id) -> ScheduleChangeRequest:
        r = s.get(ScheduleChangeRequest, int(request_id), with_for_update=True) if str(request_id).isdigit() else None
        if r is None:
            raise AgendaError(NO_ENCONTRADO)
        if r.status != "pending":
            raise AgendaError(TRANSICION_INVALIDA, "la solicitud ya fue resuelta")
        return r

    def approve_schedule_change(self, request_id, actor: Actor = SYSTEM) -> tuple[RequestView, list[Appointment]]:
        """Aplica el horario y marca la solicitud como aprobada en UNA transaccion (si el horario ya no es valido, la
        solicitud sigue pendiente). Devuelve tambien las citas agendadas que quedaron fuera del nuevo horario."""
        def work(repo, s):
            r = self._pending_request(s, request_id)
            _doc, affected = self.availability.apply_hours(repo, s, r.doctor_id, r.weekly_hours, actor)
            r.status, r.decided_by_id, r.decided_at = "approved", actor.user_id, self._utc()
            audit(s, actor, "schedule_change.approve", "doctor", r.doctor_id, {"requestId": r.id})
            return self._request_view(s, r), affected
        return self._write(work)

    def reject_schedule_change(self, request_id, note=None, actor: Actor = SYSTEM) -> RequestView:
        note = _text(note, "note", 500, required=False)

        def work(repo, s):
            r = self._pending_request(s, request_id)
            r.status, r.decided_by_id, r.decided_at = "rejected", actor.user_id, self._utc()
            if note:
                r.note = " · ".join(x for x in (r.note, "Respuesta: " + note) if x)[:500]
            audit(s, actor, "schedule_change.reject", "doctor", r.doctor_id, {"requestId": r.id})
            return self._request_view(s, r)
        return self._write(work)

    # ------------------------------------------------------------------ casos de atencion
    def attention(self, status: str = "open") -> list[AttentionCase]:
        if status not in ATTENTION_STATUSES:
            raise _bad("status: " + " | ".join(ATTENTION_STATUSES))
        with self._read() as repo:
            return list(repo.s.scalars(select(AttentionCase).where(AttentionCase.status == status)
                                       .order_by(AttentionCase.id.desc())))

    def resolve_attention(self, case_id, actor: Actor = SYSTEM) -> AttentionCase:
        def work(repo, s):
            c = s.get(AttentionCase, int(case_id), with_for_update=True) if str(case_id).isdigit() else None
            if c is None:
                raise AgendaError(NO_ENCONTRADO)
            if c.status != "resolved":
                c.status, c.resolved_at, c.resolved_by_id = "resolved", self._utc(), actor.user_id
                audit(s, actor, "attention.resolve", "attention", c.id)
            return c
        return self._write(work)

    def add_attention(self, *, kind: str, reason: str, detail: str | None = None) -> None:
        """Aviso al personal generado por el sistema (p. ej. un doctor marco una ausencia con citas). Sin datos de pacientes."""
        def work(repo, s):
            s.add(AttentionCase(kind=kind, status="open", reason=reason[:64], detail=(detail or None) and detail[:500],
                                created_at=self._utc()))
        self._write(work)

    # ------------------------------------------------------------------ notificaciones push
    def subscribe_push(self, user_id: int, endpoint, p256dh, auth) -> None:
        if (not isinstance(endpoint, str) or not endpoint.startswith("https://") or len(endpoint) > 512
                or not isinstance(p256dh, str) or not 0 < len(p256dh) <= 255
                or not isinstance(auth, str) or not 0 < len(auth) <= 255):
            raise _bad("suscripcion invalida (endpoint https de hasta 512 caracteres y claves p256dh/auth)")

        def work(repo, s):
            row = s.scalars(select(PushSubscription).where(PushSubscription.endpoint == endpoint)).first()
            if row is None:
                mine = s.scalar(select(func.count()).select_from(PushSubscription).where(PushSubscription.user_id == user_id))
                if mine >= MAX_PUSH_PER_USER:
                    raise _bad(f"maximo {MAX_PUSH_PER_USER} dispositivos por usuario")
                s.add(PushSubscription(user_id=user_id, endpoint=endpoint, p256dh=p256dh, auth=auth,
                                       created_at=self._utc()))
            else:                                   # el mismo dispositivo se registra de nuevo (o cambio de usuario)
                row.user_id, row.p256dh, row.auth = user_id, p256dh, auth
        try:
            self._write(work)
        except IntegrityError as e:                 # dos registros simultaneos del mismo endpoint
            if not is_unique_violation(e):
                raise

    def unsubscribe_push(self, user_id: int, endpoint) -> None:
        """Idempotente; solo borra suscripciones PROPIAS."""
        if not isinstance(endpoint, str):
            raise _bad("endpoint: debe ser texto")
        self._write(lambda repo, s: s.execute(delete(PushSubscription).where(
            PushSubscription.user_id == user_id, PushSubscription.endpoint == endpoint)))
