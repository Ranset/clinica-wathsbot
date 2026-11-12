"""Del modelo al JSON del contrato (`docs/openapi.yaml`). Los ids viajan como texto; los instantes en UTC (`...Z`).

Privacidad: para el rol `doctor` la cita NUNCA lleva el telefono del paciente, ni en `phone` ni en `patient.id` (alli va el
id de la cita).
"""
from __future__ import annotations

from ..auth import UserView
from ..db import iso_utc
from ..directory import DoctorView, RequestView
from ..models import Appointment, AttentionCase, DoctorAbsence, PersonalEvent, Room
from ..settings import BotSettings


def booking_json(a: Appointment, role: str) -> dict:
    patient = None
    if a.kind == "session" and a.patient_name:
        hide = role == "doctor" or not a.phone
        patient = {"id": str(a.id) if hide else a.phone, "name": a.patient_name}
        if a.phone and role != "doctor":
            patient["phone"] = a.phone
    return {
        "id": str(a.id), "kind": a.kind, "status": a.status, "source": a.source,
        "scheduledAtUtc": iso_utc(a.start_utc), "durationMinutes": a.duration_minutes, "patient": patient,
        "doctor": {"id": str(a.doctor.id), "name": a.doctor.name, "specialty": a.doctor.specialty, "color": a.doctor.color}
        if a.doctor else None,
        "room": {"id": str(a.room.id), "name": a.room.name} if a.room else None,
        "notes": a.notes,
    }


def doctor_json(d: DoctorView) -> dict:
    return {"id": str(d.id), "name": d.name, "specialty": d.specialty, "aliases": d.aliases, "active": d.active,
            "weeklyHours": d.weekly, "usesClinicHours": d.uses_clinic_hours, "color": d.color}


def room_json(r: Room) -> dict:
    return {"id": str(r.id), "name": r.name}


def absence_json(a: DoctorAbsence) -> dict:
    return {"id": str(a.id), "doctorId": str(a.doctor_id), "startUtc": iso_utc(a.start_utc), "endUtc": iso_utc(a.end_utc),
            "reason": a.reason}


def personal_event_json(e: PersonalEvent) -> dict:
    """El evento COMPLETO (con titulo y notas): solo lo usa la API del doctor, siempre de su propio doctor."""
    return {"id": str(e.id), "title": e.title, "notes": e.notes, "startUtc": iso_utc(e.start_utc),
            "endUtc": iso_utc(e.end_utc)}


def busy_json(row) -> dict:
    """Lo que ve el personal de un evento personal: SOLO que el doctor esta ocupado. `row` es `(id, doctor_id, start, end)`
    (la consulta del personal nunca carga el titulo ni las notas)."""
    event_id, doctor_id, start, end = row
    return {"id": str(event_id), "doctorId": str(doctor_id), "startUtc": iso_utc(start), "endUtc": iso_utc(end)}


def user_json(u: UserView) -> dict:
    return {"id": str(u.id), "email": u.email, "name": u.name, "role": u.role,
            "doctorId": str(u.doctor_id) if u.doctor_id is not None else None, "active": u.active}


def request_json(r: RequestView) -> dict:
    return {"id": str(r.id), "doctorId": str(r.doctor_id), "weeklyHours": r.weekly_hours,
            "effectiveFrom": r.effective_from.isoformat(), "note": r.note, "status": r.status,
            "createdAtUtc": iso_utc(r.created_at), "decidedBy": r.decided_by,
            "decidedAtUtc": iso_utc(r.decided_at) if r.decided_at else None}


def attention_json(c: AttentionCase) -> dict:
    return {"id": str(c.id), "kind": c.kind, "status": c.status, "createdAtUtc": iso_utc(c.created_at),
            "conversationId": c.conversation_id, "phone": c.phone, "reason": c.reason, "detail": c.detail}


def bot_settings_json(st: BotSettings) -> dict:
    out = {"active": st.active}
    if st.updated_at:
        out.update(updatedAt=iso_utc(st.updated_at), updatedBy=st.updated_by)
    return out
