"""Repositorio SQL: reemplaza al backend de Google Calendar (`list_events` / `insert` / `delete`).

La lectura trae lo ocupado de TODO un rango en una sola consulta (`busy`), para que ofrecer horarios no haga
una consulta por hueco.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, lazyload

from ..db import to_db
from ..models import (Appointment, AppointmentBlock, ClinicHours, Doctor, DoctorAbsence, DoctorHours, PersonalEvent, Room)
from .hours import Schedule
from .rules import Rules


@dataclass
class Busy:
    """Huecos ocupados de un rango (UTC ingenuo): por consultorio y por doctor."""
    rooms: dict[int, set[datetime]] = field(default_factory=dict)
    doctors: dict[int, set[datetime]] = field(default_factory=dict)

    def room_taken(self, room_id: int, slot_utc: datetime) -> bool:
        return slot_utc in self.rooms.get(room_id, ())

    def doctor_taken(self, doctor_id: int, slot_utc: datetime) -> bool:
        return slot_utc in self.doctors.get(doctor_id, ())


class Repo:
    def __init__(self, s: Session, rules: Rules):
        self.s = s
        self.rules = rules

    # ---- catalogos ----
    def doctors(self, active_only: bool = True) -> list[Doctor]:
        q = select(Doctor).order_by(Doctor.id)
        if active_only:
            q = q.where(Doctor.active.is_(True))
        return list(self.s.scalars(q))

    def doctor(self, doctor_id) -> Doctor | None:
        try:
            return self.s.get(Doctor, int(doctor_id))
        except (TypeError, ValueError):
            return None

    def rooms(self, active_only: bool = True) -> list[Room]:
        q = select(Room).order_by(Room.position, Room.id)
        if active_only:
            q = q.where(Room.active.is_(True))
        return list(self.s.scalars(q))

    def lock_rooms(self, room_ids=None) -> None:
        """Bloquea (SELECT ... FOR UPDATE) las filas de consultorios por las que van a competir las reservas, SIEMPRE en
        orden de id. Debe ser lo PRIMERO que lee la transaccion de escritura:

        - Las reservas que compiten por un hueco hacen cola aqui en vez de lanzarse a insertar a la vez. Sin esto, varios
          INSERT simultaneos que chocan con un UNIQUE dejan bloqueos residuales en el indice primario y MySQL los resuelve
          con interbloqueos (1213) que descartan transacciones validas.
        - Un bloqueo de lectura no fija la instantanea de REPEATABLE READ, asi que la lectura de ocupacion que viene
          despues ya ve lo que confirmo la reserva anterior.
        Los UNIQUE de `appointment_blocks` siguen siendo la decision final (red de seguridad). En SQLite no hace nada
        (las escrituras ya van en serie con BEGIN IMMEDIATE)."""
        q = select(Room.id).order_by(Room.id).with_for_update()
        if room_ids is not None:
            q = q.where(Room.id.in_([int(i) for i in room_ids]))
        else:
            q = q.where(Room.active.is_(True))
        self.s.execute(q).all()

    def room(self, room_id) -> Room | None:
        try:
            r = self.s.get(Room, int(room_id))
        except (TypeError, ValueError):
            return None
        return r if r is not None and r.active else None

    # ---- horarios ----
    def clinic_schedule(self) -> Schedule:
        return Schedule.from_rows(self.rules, self.s.scalars(select(ClinicHours)))

    def doctor_schedule(self, doctor: Doctor, clinic: Schedule) -> Schedule:
        if doctor.uses_clinic_hours:
            return clinic
        rows = self.s.scalars(select(DoctorHours).where(DoctorHours.doctor_id == doctor.id))
        return Schedule.from_rows(self.rules, rows)

    def absences(self, doctor_id: int, start_utc: datetime, end_utc: datetime) -> list[tuple[datetime, datetime]]:
        """Ausencias del doctor que se solapan con [start_utc, end_utc)."""
        q = select(DoctorAbsence.start_utc, DoctorAbsence.end_utc).where(
            DoctorAbsence.doctor_id == doctor_id, DoctorAbsence.start_utc < end_utc, DoctorAbsence.end_utc > start_utc)
        return [(a, b) for a, b in self.s.execute(q)]

    def personal_events(self, doctor_id: int, start_utc: datetime, end_utc: datetime) -> list[tuple[datetime, datetime]]:
        """Franjas de los eventos personales del doctor que se solapan con [start_utc, end_utc). SOLO las horas: el texto
        del evento es privado y el motor de agenda nunca lo necesita."""
        q = select(PersonalEvent.start_utc, PersonalEvent.end_utc).where(
            PersonalEvent.doctor_id == doctor_id, PersonalEvent.start_utc < end_utc, PersonalEvent.end_utc > start_utc)
        return [(a, b) for a, b in self.s.execute(q)]

    # ---- ocupacion ----
    def busy(self, start_utc: datetime, end_utc: datetime, ignore_appointment_id: int | None = None) -> Busy:
        """Todos los huecos ocupados con inicio en [start_utc, end_utc): UNA consulta. `ignore_appointment_id` deja fuera los
        huecos de esa cita (la que se esta moviendo: su propio horario cuenta como libre para ella)."""
        q = select(AppointmentBlock.doctor_id, AppointmentBlock.room_id, AppointmentBlock.slot_start).where(
            AppointmentBlock.slot_start >= start_utc, AppointmentBlock.slot_start < end_utc)
        if ignore_appointment_id is not None:
            q = q.where(AppointmentBlock.appointment_id != ignore_appointment_id)
        b = Busy()
        for doctor_id, room_id, slot in self.s.execute(q):
            b.rooms.setdefault(room_id, set()).add(slot)
            if doctor_id is not None:
                b.doctors.setdefault(doctor_id, set()).add(slot)
        return b

    def delete_blocks(self, appointment_id: int) -> None:
        """Libera los huecos de una cita. Se ejecuta de inmediato (antes de reinsertar en la misma transaccion)."""
        self.s.execute(delete(AppointmentBlock).where(AppointmentBlock.appointment_id == appointment_id))

    # ---- citas ----
    def appointment(self, appointment_id, lock: bool = False) -> Appointment | None:
        try:
            aid = int(appointment_id)
        except (TypeError, ValueError):
            return None
        q = select(Appointment).where(Appointment.id == aid)
        if lock:
            # Serializa cancelar/mover/cambiar estado de la MISMA cita (no-op en SQLite). Sin JOIN: asi solo se bloquea
            # la fila de la cita y no las de doctores/consultorios (y funciona igual en MySQL y MariaDB).
            q = q.options(lazyload(Appointment.doctor), lazyload(Appointment.room)).with_for_update()
        return self.s.scalars(q).unique().first()

    def own_appointment(self, phone, appointment_id, lock: bool = False) -> Appointment | None:
        """Cita agendada y futura-o-en-curso de ESE telefono. Un telefono vacio no es dueno de nada
        (evita que `phone IS NULL` empareje citas de mostrador sin telefono)."""
        phone = (str(phone).strip() if phone is not None else "")
        if not phone:
            return None
        a = self.appointment(appointment_id, lock=lock)
        if a is None or a.kind != "session" or a.status != "agendada" or a.phone != phone:
            return None
        return a

    def upcoming_for_phone(self, phone, now_utc: datetime, until_utc: datetime) -> list[Appointment]:
        phone = (str(phone).strip() if phone is not None else "")
        if not phone:
            return []
        earliest_start = now_utc - timedelta(minutes=self.rules.max_duration_minutes)
        q = (select(Appointment)
             .where(Appointment.phone == phone, Appointment.kind == "session", Appointment.status == "agendada",
                    Appointment.start_utc >= earliest_start, Appointment.start_utc <= until_utc)
             .order_by(Appointment.start_utc, Appointment.id))
        # en curso o futura: su fin (inicio + duracion) es posterior a ahora
        return [a for a in self.s.scalars(q).unique()
                if a.start_utc + timedelta(minutes=a.duration_minutes) > now_utc]

    def list_range(self, start, end, *, doctor_id=None, room_id=None, status=None) -> list[Appointment]:
        """Citas y bloqueos que se solapan con [start, end) (instantes con zona)."""
        lo, hi = to_db(start), to_db(end)
        q = select(Appointment).where(Appointment.start_utc < hi,
                                      Appointment.start_utc > lo - timedelta(minutes=self.rules.max_duration_minutes))
        if doctor_id is not None:
            q = q.where(Appointment.doctor_id == int(doctor_id))
        if room_id is not None:
            q = q.where(Appointment.room_id == int(room_id))
        if status is not None:
            q = q.where(Appointment.status == status)
        q = q.order_by(Appointment.start_utc, Appointment.id)
        return [a for a in self.s.scalars(q).unique()
                if a.start_utc + timedelta(minutes=a.duration_minutes) > lo]
