"""Agenda para administrador y personal: citas, consultorios, doctores (lectura), horarios, ausencias y solicitudes de
cambio de horario. Contrato: secciones `agenda` (menos lo que es solo del administrador, que esta en `admin.py`).

Todo pasa por el motor (`Agenda`, `Availability`, `Directory`): aqui solo se valida la entrada y se da forma al JSON.
"""
from __future__ import annotations

from flask import Blueprint, current_app, g, jsonify, request

from ..agenda import UNSET, Actor
from ..agenda.errors import NO_ENCONTRADO, AgendaError
from .inputs import (bad, body, bookings_response, instant, opt_bool, opt_int, opt_str, query_id, query_range,
                     query_status)
from .common import valid_phone
from .security import require
from .serializers import (absence_json, booking_json, busy_json, doctor_json, request_json, room_json)

bp = Blueprint("staff", __name__)
STAFF = ("admin", "staff")


def _x(name):
    return current_app.extensions[name]


def _actor() -> Actor:
    return Actor.user(g.principal.user.id)


def _items(rows, fn):
    return jsonify(items=[fn(r) for r in rows])


# --------------------------------------------------------------------------- citas
@bp.get("/api/appointments")
@require(*STAFF)
def list_appointments():
    start, end = query_range()
    rows = _x("agenda").list_bookings(start, end, doctor_id=query_id("doctorId"), room_id=query_id("roomId"),
                                      status=query_status())
    return bookings_response(rows, g.principal.role)


@bp.post("/api/appointments")
@require(*STAFF)
def create_appointment():
    b = body()
    phone = opt_str(b, "phone")
    if phone is not None and not valid_phone(phone):
        raise bad("phone: de 8 a 15 digitos")
    a = _x("agenda").create_booking(
        start=instant(b.get("scheduledAtUtc"), "scheduledAtUtc"), kind=b.get("kind", "session"),
        duration_minutes=opt_int(b, "durationMinutes"), patient_name=opt_str(b, "patientName"), phone=phone,
        doctor_id=opt_str(b, "doctorId"), room_id=opt_str(b, "roomId"), notes=opt_str(b, "notes"),
        allow_short_notice=opt_bool(b, "allowShortNotice"), source="manual", actor=_actor())
    return jsonify(booking_json(a, g.principal.role)), 201


@bp.get("/api/appointments/<appointment_id>")
@require(*STAFF)
def get_appointment(appointment_id):
    a = _x("agenda").get_booking(appointment_id)
    if a is None:
        raise AgendaError(NO_ENCONTRADO)
    return jsonify(booking_json(a, g.principal.role))


@bp.patch("/api/appointments/<appointment_id>")
@require(*STAFF)
def update_appointment(appointment_id):
    b = body()
    if not any(k in b for k in ("status", "scheduledAtUtc", "roomId", "notes", "allowShortNotice")):
        raise bad("no hay nada que cambiar")
    a = _x("agenda").update_booking(
        appointment_id, status=opt_str(b, "status"),
        start=instant(b["scheduledAtUtc"], "scheduledAtUtc") if "scheduledAtUtc" in b else None,
        room_id=opt_str(b, "roomId"), notes=opt_str(b, "notes") if "notes" in b else UNSET,
        allow_short_notice=opt_bool(b, "allowShortNotice"), actor=_actor())
    return jsonify(booking_json(a, g.principal.role))


# --------------------------------------------------------------------------- catalogos (lectura)
@bp.get("/api/rooms")
@require()
def list_rooms():
    return _items(_x("directory").rooms(), room_json)


@bp.get("/api/clinic-hours")
@require()
def get_clinic_hours():
    return jsonify(_x("availability").clinic_weekly())


@bp.get("/api/doctors")
@require()
def list_doctors():
    p = g.principal
    return _items(_x("directory").doctors(only_id=p.doctor_id if p.role == "doctor" else None), doctor_json)


# --------------------------------------------------------------------------- horarios y ausencias de un doctor
@bp.put("/api/doctors/<doctor_id>/weekly-hours")
@require(*STAFF)
def set_doctor_weekly_hours(doctor_id):
    b = body()
    if "weeklyHours" not in b:
        raise bad('falta "weeklyHours" (un horario o null)')
    weekly = b["weeklyHours"]
    if weekly is not None and not isinstance(weekly, dict):
        raise bad("weeklyHours: un horario semanal o null")
    _doc, affected = _x("availability").set_doctor_hours(doctor_id, weekly, _actor())
    return jsonify(doctor=doctor_json(_x("directory").get_doctor(doctor_id)),
                   affectedAppointments=[booking_json(a, g.principal.role) for a in affected])


def _absence_range():
    lo = instant(request.args["from"], "from") if request.args.get("from") else None
    hi = instant(request.args["to"], "to") if request.args.get("to") else None
    return lo, hi


@bp.get("/api/doctors/<doctor_id>/absences")
@require(*STAFF)
def list_doctor_absences(doctor_id):
    lo, hi = _absence_range()
    return _items(_x("availability").list_absences(doctor_id, lo, hi), absence_json)


@bp.post("/api/doctors/<doctor_id>/absences")
@require(*STAFF)
def create_doctor_absence(doctor_id):
    b = body()
    ab, affected = _x("availability").add_absence(
        doctor_id, instant(b.get("startUtc"), "startUtc"), instant(b.get("endUtc"), "endUtc"), opt_str(b, "reason"), _actor())
    return jsonify(absence=absence_json(ab),
                   affectedAppointments=[booking_json(a, g.principal.role) for a in affected]), 201


@bp.delete("/api/doctors/<doctor_id>/absences/<absence_id>")
@require(*STAFF)
def delete_doctor_absence(doctor_id, absence_id):
    _x("availability").delete_absence(doctor_id, absence_id, _actor())
    return "", 204


@bp.get("/api/absences")
@require(*STAFF)
def list_all_absences():
    """Ausencias de TODOS los doctores que se solapan con `[from, to)` (para sombrear el calendario)."""
    start, end = query_range()
    return _items(_x("availability").absences_between(start, end), absence_json)


@bp.get("/api/busy-times")
@require(*STAFF)
def list_busy_times():
    """Franjas en que cada doctor esta ocupado por un evento PERSONAL (sombrean el calendario como «No disponible»).
    Solo id, doctor y horas: el titulo y las notas son privados del doctor y no salen por aqui."""
    start, end = query_range()
    return _items(_x("availability").busy_between(start, end), busy_json)


# --------------------------------------------------------------------------- solicitudes de cambio de horario
@bp.get("/api/schedule-change-requests")
@require(*STAFF)
def list_schedule_changes():
    return _items(_x("directory").schedule_changes(request.args.get("status")), request_json)


@bp.post("/api/schedule-change-requests/<request_id>/approve")
@require(*STAFF)
def approve_schedule_change(request_id):
    view, affected = _x("directory").approve_schedule_change(request_id, _actor())
    out = request_json(view)
    out["affectedAppointments"] = [booking_json(a, g.principal.role) for a in affected]
    return jsonify(out)


@bp.post("/api/schedule-change-requests/<request_id>/reject")
@require(*STAFF)
def reject_schedule_change(request_id):
    raw = request.get_data().strip()
    note = opt_str(body(), "note") if raw else None
    return jsonify(request_json(_x("directory").reject_schedule_change(request_id, note, _actor())))
