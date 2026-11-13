"""Del modelo al JSON del contrato (`docs/openapi.yaml`). Los ids viajan como texto; los instantes en UTC (`...Z`).

Privacidad: para el rol `doctor` la cita NUNCA lleva el telefono del paciente, ni en `phone` ni en `patient.id` (alli va el
id de la cita), ni `contactPhone`, ni el id de Meta de Messenger / Instagram (que viaja en `patient.id` como `canal:contacto_id`
solo para el personal).
"""
from __future__ import annotations

from ..auth import UserView
from ..db import iso_utc
from ..directory import DoctorView, RequestView
from ..models import Appointment, AttentionCase, DoctorAbsence, PersonalEvent, Room
from ..settings import BotSettings


def _patient_id(a: Appointment, role: str) -> str:
    """Id estable del paciente para el personal. WhatsApp: el telefono (como siempre). Messenger / Instagram: `canal:contacto_id`,
    NUNCA el telefono de contacto (que no es su identidad). Sin identidad, o para el doctor: el id de la cita."""
    if role == "doctor":
        return str(a.id)
    if a.channel != "whatsapp":
        return f"{a.channel}:{a.contact_id}" if a.contact_id else str(a.id)
    return a.phone or str(a.id)


def booking_json(a: Appointment, role: str) -> dict:
    patient = None
    if a.kind == "session" and a.patient_name:
        patient = {"id": _patient_id(a, role), "name": a.patient_name}
        if a.phone and role != "doctor":
            patient["phone"] = a.phone
    out = {
        "id": str(a.id), "kind": a.kind, "status": a.status, "source": a.source, "channel": a.channel,
        "scheduledAtUtc": iso_utc(a.start_utc), "durationMinutes": a.duration_minutes, "patient": patient,
        "doctor": {"id": str(a.doctor.id), "name": a.doctor.name, "specialty": a.doctor.specialty, "color": a.doctor.color}
        if a.doctor else None,
        "room": {"id": str(a.room.id), "name": a.room.name} if a.room else None,
        "notes": a.notes,
    }
    if a.kind == "session" and a.phone and role != "doctor":
        out["contactPhone"] = a.phone  # el doctor nunca recibe un telefono, ni este
    return out


def doctor_json(d: DoctorView) -> dict:
    return {"id": str(d.id), "code": d.code, "name": d.name, "specialty": d.specialty, "aliases": d.aliases, "active": d.active,
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
            "doctorId": str(u.doctor_id) if u.doctor_id is not None else None, "active": u.active, "passwordSet": u.password_set}


def request_json(r: RequestView) -> dict:
    return {"id": str(r.id), "doctorId": str(r.doctor_id), "weeklyHours": r.weekly_hours,
            "effectiveFrom": r.effective_from.isoformat(), "note": r.note, "status": r.status,
            "createdAtUtc": iso_utc(r.created_at), "decidedBy": r.decided_by,
            "decidedAtUtc": iso_utc(r.decided_at) if r.decided_at else None}


def attention_json(c: AttentionCase) -> dict:
    return {"id": str(c.id), "kind": c.kind, "status": c.status, "createdAtUtc": iso_utc(c.created_at),
            "conversationId": c.conversation_id, "channel": c.channel, "contactId": c.contact_id, "phone": c.phone,
            "reason": c.reason, "detail": c.detail}


def bot_settings_json(st: BotSettings) -> dict:
    """Los tres interruptores. `active` (y `updatedAt` / `updatedBy`) son los de WhatsApp, para los clientes que solo lo conocen."""
    out = {"active": st.active, "channels": dict(st.channels)}
    if st.updated_at:
        out.update(updatedAt=iso_utc(st.updated_at), updatedBy=st.updated_by)
    out["channelUpdates"] = {c: {"updatedAt": iso_utc(u.updated_at) if u.updated_at else None, "updatedBy": u.updated_by}
                             for c, u in st.updates.items()}
    return out
