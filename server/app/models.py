"""Modelo de datos. Los ids son enteros en la BD (cadenas en el JSON de la API, segun el contrato).

Todos los instantes son **UTC ingenuo** (ver `app.db`). Los horarios semanales son hora de pared de la
clinica (`TIME`), con `weekday` 0=lunes ... 6=domingo (igual que `datetime.weekday()`).
"""
from __future__ import annotations

from datetime import date, datetime, time

from sqlalchemy import (JSON, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, LargeBinary, MetaData, String,
                        Time, UniqueConstraint)
from sqlalchemy.dialects import mysql
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
#: Canales de mensajeria. `facebook` = Messenger. WhatsApp es el de siempre (la identidad es el telefono).
CHANNELS = ("whatsapp", "facebook", "instagram")
EVENT_STATUSES = ("pending", "claimed", "done", "failed", "skipped")
ATTENTION_KINDS = ("handoff", "event_failed", "absence_affects_appointments")
ATTENTION_STATUSES = ("open", "resolved")
REQUEST_STATUSES = ("pending", "approved", "rejected")


def _in(col: str, values: tuple[str, ...]) -> str:
    return f"{col} IN ({', '.join(repr(v) for v in values)})"


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


class Doctor(Base):
    __tablename__ = "doctors"

    id: Mapped[int] = mapped_column(primary_key=True)
    #: Codigo de acceso de 4 digitos ("1003"), asignado al darlo de alta (`app/doctor_codes.py`). Es el «usuario» con el que el
    #: doctor entra a su app; no se edita.
    code: Mapped[str] = mapped_column(String(4), unique=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    #: etiqueta/especialidad tal como se muestra ("Proctologia"); tambien se usa para reconocer la peticion del paciente.
    specialty: Mapped[str] = mapped_column(String(120))
    #: sinonimos ("proctologo", "usg"); con `specialty` forman los nombres que `find_doctor` reconoce.
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    #: Color elegido para verlo en el calendario, `#rrggbb` en minusculas. NULL = automatico (la paleta segun su id, que
    #: calcula el cliente). Solo se guardan colores con texto blanco legible (ver `app/colors.py`).
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
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
    #: NULL en la cuenta de un doctor: entra con su codigo, no con correo (varios NULL no chocan en el UNIQUE).
    email: Mapped[str | None] = mapped_column(String(254), unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(16))
    doctor_id: Mapped[int | None] = mapped_column(ForeignKey("doctors.id"))
    #: NULL = todavia sin contrasena (la cuenta de un doctor nace asi: la establece con un enlace). Nadie entra sin ella.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: SHA-256 del enlace vigente para establecer/cambiar la contrasena (el enlace en si nunca se guarda) y cuando vence.
    #: Un enlace nuevo reemplaza al anterior; al usarlo se borran los dos.
    setup_token_hash: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    setup_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
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


class PersonalEvent(Base):
    """Evento personal de un doctor (lo crea el en la PWA). Bloquea su agenda igual que una ausencia, pero el detalle
    (`title`, `notes`) es PRIVADO del doctor: solo la API del doctor lo devuelve; el personal y el bot solo saben que
    esa franja esta ocupada (nunca se carga el texto en esa ruta, ver `Availability.busy_between`)."""
    __tablename__ = "doctor_personal_events"
    __table_args__ = (CheckConstraint("start_utc < end_utc", name="interval"),
                      Index("ix_doctor_personal_events_doctor_id_start_utc", "doctor_id", "start_utc"))

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(String(1000))
    start_utc: Mapped[datetime] = mapped_column(DateTime)
    end_utc: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


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
        CheckConstraint(_in("channel", CHANNELS), name="channel"),
        CheckConstraint("duration_minutes > 0 AND duration_minutes % 30 = 0", name="duration"),
        Index("ix_appointments_start_utc", "start_utc"),
        Index("ix_appointments_doctor_id_start_utc", "doctor_id", "start_utc"),
        Index("ix_appointments_phone_start_utc", "phone", "start_utc"),
        Index("ix_appointments_channel_contact_id_start_utc", "channel", "contact_id", "start_utc"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), default="session")
    status: Mapped[str] = mapped_column(String(16), default="agendada")
    source: Mapped[str] = mapped_column(String(8), default="manual")
    #: Telefono (digitos). En WhatsApp es la IDENTIDAD del paciente; en Messenger / Instagram es solo el telefono de CONTACTO que
    #: dio al agendar (la identidad es `channel` + `contact_id`). NULL en citas de mostrador sin telefono y en bloqueos.
    phone: Mapped[str | None] = mapped_column(String(20))
    #: Canal por el que llego (`whatsapp`, `facebook`, `instagram`). Toda consulta por identidad filtra por canal Y contacto.
    channel: Mapped[str] = mapped_column(String(12), default="whatsapp", server_default="whatsapp")
    #: Id de Meta (PSID / IGSID) de quien escribio; NULL en WhatsApp, donde la identidad es `phone`. No es un telefono ni un dato verificado.
    contact_id: Mapped[str | None] = mapped_column(String(64))
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


class ClinicLogo(Base):
    """El logotipo de la clinica (una sola fila, `id = 1`): la imagen CUADRADA que subio el administrador, tal cual. Se guarda en
    la BD (no en archivos) para que viaje con los respaldos. `sha256` identifica la version (cache y `ETag`). MEDIUMBLOB en MySQL:
    el BLOB normal solo admite 64 KB. El nombre de la clinica vive en `settings` (`clinic_name`)."""
    __tablename__ = "clinic_logo"

    id: Mapped[int] = mapped_column(primary_key=True)
    content_type: Mapped[str] = mapped_column(String(20))
    data: Mapped[bytes] = mapped_column(LargeBinary().with_variant(mysql.MEDIUMBLOB(), "mysql"))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
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
    #: `claimed`: fin del plazo del bot. `pending` con valor: no volver a ofrecerlo antes de esa hora (espera entre reintentos).
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


class AttentionCase(Base):
    """Algo que una PERSONA debe atender: el bot paso la conversacion (`handoff`), un mensaje no se pudo contestar tras
    varios intentos (`event_failed`) o una ausencia afecta citas (`absence_affects_appointments`, F4). Lo lista
    `/api/attention` (F4). Guarda telefono y conversacion para poder contactar; nunca el texto del paciente."""
    __tablename__ = "attention_cases"
    __table_args__ = (
        CheckConstraint(_in("kind", ATTENTION_KINDS), name="kind"),
        CheckConstraint(_in("status", ATTENTION_STATUSES), name="status"),
        Index("ix_attention_cases_status_id", "status", "id"),
        Index("ix_attention_cases_conversation_id", "conversation_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(10), default="open")
    conversation_id: Mapped[str | None] = mapped_column(String(64))
    phone: Mapped[str | None] = mapped_column(String(20))
    #: Canal de la conversacion y, fuera de WhatsApp, el id de Meta de quien escribio (sin telefono: se contesta desde el inbox de Zernio).
    channel: Mapped[str] = mapped_column(String(12), default="whatsapp", server_default="whatsapp")
    contact_id: Mapped[str | None] = mapped_column(String(64))
    #: codigo corto (`pidio_persona`, `mensaje_sin_atender`, ...)
    reason: Mapped[str] = mapped_column(String(64))
    detail: Mapped[str | None] = mapped_column(String(500))
    event_id: Mapped[int | None] = mapped_column(ForeignKey("webhook_events.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)
    resolved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class UserSession(Base):
    """Sesion de una persona (cookie `clinica_session`). La cookie lleva un token aleatorio; aqui solo se guarda su hash
    SHA-256, asi que una copia de la BD no sirve para entrar. El token CSRF es estable durante toda la sesion. Se cierra
    al vencer (`expires_at` absoluto o inactividad desde `last_seen_at`), al salir, o al desactivar al usuario."""
    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user_id", "user_id"), Index("ix_sessions_expires_at", "expires_at"))

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class ScheduleChangeRequest(Base):
    """Solicitud de un doctor para cambiar su horario semanal de forma permanente; la decide el personal."""
    __tablename__ = "schedule_change_requests"
    __table_args__ = (
        CheckConstraint(_in("status", REQUEST_STATUSES), name="status"),
        Index("ix_schedule_change_requests_status_id", "status", "id"),
        Index("ix_schedule_change_requests_doctor_id", "doctor_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id", ondelete="CASCADE"))
    weekly_hours: Mapped[dict] = mapped_column(JSON)
    #: informativa: el servidor guarda un solo horario semanal, asi que al aprobar se aplica de inmediato
    effective_from: Mapped[date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(10), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    decided_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime)


class PushSubscription(Base):
    """Suscripcion Web Push de un dispositivo del doctor (el envio llega en F7)."""
    __tablename__ = "push_subscriptions"
    __table_args__ = (Index("ix_push_subscriptions_user_id", "user_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    endpoint: Mapped[str] = mapped_column(String(512), unique=True)
    p256dh: Mapped[str] = mapped_column(String(255))
    auth: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
