"""Modelo de datos. Los ids son enteros en la BD (cadenas en el JSON de la API, segun el contrato).

Todos los instantes son **UTC ingenuo** (ver `app.db`). Los horarios semanales son hora de pared de la
clinica (`TIME`), con `weekday` 0=lunes ... 6=domingo (igual que `datetime.weekday()`).
"""
from __future__ import annotations

from datetime import datetime, time

from sqlalchemy import (JSON, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, MetaData, String, Time,
                        UniqueConstraint)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .db import utcnow

NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

ROLES = ("admin", "staff", "doctor")
STATUSES = ("agendada", "realizada", "no_show", "cancelada")
KINDS = ("session", "block")
SOURCES = ("manual", "ai")
EVENT_STATUSES = ("pending", "claimed", "done", "failed", "skipped")


def _in(col: str, values: tuple[str, ...]) -> str:
    return f"{col} IN ({', '.join(repr(v) for v in values)})"


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


class Doctor(Base):
    __tablename__ = "doctors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    #: etiqueta/especialidad tal como se muestra ("Proctologia"); tambien se usa para reconocer la peticion del paciente.
    specialty: Mapped[str] = mapped_column(String(120))
    #: sinonimos ("proctologo", "usg"); con `specialty` forman los nombres que `find_doctor` reconoce.
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    #: True = usa el horario de la clinica (ignora `doctor_hours`). False = `doctor_hours` es su horario
    #: (puede estar vacio: no atiende ningun dia).
    uses_clinic_hours: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    hours: Mapped[list[DoctorHours]] = relationship(back_populates="doctor", cascade="all, delete-orphan",
                                                    order_by="DoctorHours.weekday, DoctorHours.start_time")


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(60), unique=True)
    #: orden en que se prueban los consultorios al reservar (el primero libre gana)
    position: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(_in("role", ROLES), name="role"),
        CheckConstraint("(role = 'doctor' AND doctor_id IS NOT NULL) OR (role <> 'doctor' AND doctor_id IS NULL)",
                        name="doctor_role"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(16))
    doctor_id: Mapped[int | None] = mapped_column(ForeignKey("doctors.id"))
    password_hash: Mapped[str] = mapped_column(String(255))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class ClinicHours(Base):
    """Horario general de la clinica. Varias filas por dia = varios intervalos (p. ej. con pausa)."""
    __tablename__ = "clinic_hours"
    __table_args__ = (CheckConstraint("weekday BETWEEN 0 AND 6", name="weekday"),
                      CheckConstraint("start_time < end_time", name="interval"))

    id: Mapped[int] = mapped_column(primary_key=True)
    weekday: Mapped[int] = mapped_column(Integer)
    start_time: Mapped[time] = mapped_column(Time)
    end_time: Mapped[time] = mapped_column(Time)


class DoctorHours(Base):
    """Horario semanal propio del doctor (solo cuenta si `Doctor.uses_clinic_hours` es False)."""
    __tablename__ = "doctor_hours"
    __table_args__ = (CheckConstraint("weekday BETWEEN 0 AND 6", name="weekday"),
                      CheckConstraint("start_time < end_time", name="interval"))

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id", ondelete="CASCADE"), index=True)
    weekday: Mapped[int] = mapped_column(Integer)
    start_time: Mapped[time] = mapped_column(Time)
    end_time: Mapped[time] = mapped_column(Time)

    doctor: Mapped[Doctor] = relationship(back_populates="hours")


class DoctorAbsence(Base):
    __tablename__ = "doctor_absences"
    __table_args__ = (CheckConstraint("start_utc < end_utc", name="interval"),
                      Index("ix_doctor_absences_doctor_id_start_utc", "doctor_id", "start_utc"))

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id", ondelete="CASCADE"))
    start_utc: Mapped[datetime] = mapped_column(DateTime)
    end_utc: Mapped[datetime] = mapped_column(DateTime)
    reason: Mapped[str | None] = mapped_column(String(200))
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Appointment(Base):
    """Una cita (`kind='session'`) o un bloqueo manual de consultorio (`kind='block'`).

    El hueco que ocupa vive en `appointment_blocks` (una fila por cada 30 min); ahi estan los UNIQUE que
    impiden el doble uso de doctor y consultorio.
    """
    __tablename__ = "appointments"
    __table_args__ = (
        CheckConstraint(_in("status", STATUSES), name="status"),
        CheckConstraint(_in("kind", KINDS), name="kind"),
        CheckConstraint(_in("source", SOURCES), name="source"),
        CheckConstraint("duration_minutes > 0 AND duration_minutes % 30 = 0", name="duration"),
        Index("ix_appointments_start_utc", "start_utc"),
        Index("ix_appointments_doctor_id_start_utc", "doctor_id", "start_utc"),
        Index("ix_appointments_phone_start_utc", "phone", "start_utc"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), default="session")
    status: Mapped[str] = mapped_column(String(16), default="agendada")
    source: Mapped[str] = mapped_column(String(8), default="manual")
    #: telefono de WhatsApp (digitos). Identidad del paciente; NULL en citas de mostrador sin telefono y en bloqueos.
    phone: Mapped[str | None] = mapped_column(String(20))
    patient_name: Mapped[str | None] = mapped_column(String(120))
    doctor_id: Mapped[int | None] = mapped_column(ForeignKey("doctors.id"))
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id"))
    start_utc: Mapped[datetime] = mapped_column(DateTime)
    duration_minutes: Mapped[int] = mapped_column(Integer, default=30)
    #: texto administrativo; nunca sintomas ni datos clinicos
    notes: Mapped[str | None] = mapped_column(String(500))
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime)

    doctor: Mapped[Doctor | None] = relationship(lazy="joined")
    room: Mapped[Room] = relationship(lazy="joined")
    blocks: Mapped[list[AppointmentBlock]] = relationship(back_populates="appointment", cascade="all, delete-orphan",
                                                          passive_deletes=True)


class AppointmentBlock(Base):
    """Un hueco de 30 min ocupado. Los UNIQUE son la exclusion mutua real (la decide la BD, no el codigo):

    - `UNIQUE(doctor_id, slot_start)`: un doctor no puede estar en dos citas a la vez.
    - `UNIQUE(room_id, slot_start)`: un consultorio no puede tener dos usos a la vez.

    Un bloqueo de consultorio usa `doctor_id = NULL` (los NULL no chocan entre si en un UNIQUE).
    Cancelar una cita borra sus filas.
    """
    __tablename__ = "appointment_blocks"
    __table_args__ = (
        UniqueConstraint("doctor_id", "slot_start", name="uq_block_doctor_slot"),
        UniqueConstraint("room_id", "slot_start", name="uq_block_room_slot"),
        Index("ix_appointment_blocks_slot_start", "slot_start"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    appointment_id: Mapped[int] = mapped_column(ForeignKey("appointments.id", ondelete="CASCADE"), index=True)
    doctor_id: Mapped[int | None] = mapped_column(ForeignKey("doctors.id"))
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id"))
    slot_start: Mapped[datetime] = mapped_column(DateTime)

    appointment: Mapped[Appointment] = relationship(back_populates="blocks")


class Setting(Base):
    """Pares clave/valor. `bot_active` es el interruptor del bot."""
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict | list | str | int | bool | None] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class WebhookEvent(Base):
    """Cola de eventos de Zernio (F3). Idempotente por `zernio_event_id`; el bot reclama con plazo (`claimed_until`)."""
    __tablename__ = "webhook_events"
    __table_args__ = (
        CheckConstraint(_in("status", EVENT_STATUSES), name="status"),
        Index("ix_webhook_events_status_id", "status", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    zernio_event_id: Mapped[str] = mapped_column(String(128), unique=True)
    event_type: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(10), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    claimed_until: Mapped[datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str | None] = mapped_column(String(500))
    outcome: Mapped[str | None] = mapped_column(String(32))
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime)


class AuditLog(Base):
    """Bitacora de cambios de agenda y de configuracion. No guarda nombres ni telefonos de pacientes."""
    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_log_entity_type_entity_id", "entity_type", "entity_id"),
                      Index("ix_audit_log_created_at", "created_at"))

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    actor_kind: Mapped[str] = mapped_column(String(8))  # user | bot | system
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(48))
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[str | None] = mapped_column(String(32))
    data: Mapped[dict | None] = mapped_column(JSON)
