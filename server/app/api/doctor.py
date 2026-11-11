"""Agenda personal del doctor (`/api/doctor/*`, PWA). Contrato: seccion `doctor`.

SIEMPRE acotado al `doctor_id` de la sesion: no hay ninguna ruta que reciba el id de otro doctor, y una ausencia ajena
se trata como inexistente (404, no 403). Las citas salen SIN el telefono del paciente.
"""
from __future__ import annotations

from datetime import timedelta

from flask import Blueprint, current_app, g, jsonify

from ..agenda import Actor, iso
from .inputs import bad, body, bookings_response, day, instant, opt_str, query_range
from .security import require
from .serializers import absence_json, doctor_json, request_json

bp = Blueprint("doctor", __name__, url_prefix="/api/doctor")


def _x(name):
    return current_app.extensions[name]


def _actor() -> Actor:
    return Actor.user(g.principal.user.id)


def _did() -> int:
    return g.principal.doctor_id


@bp.get("/appointments")
@require("doctor")
def appointments():
    start, end = query_range()
    return bookings_response(_x("agenda").list_bookings(start, end, doctor_id=_did()), "doctor")


@bp.get("/hours")
@require("doctor")
def hours():
    return jsonify(doctor_json(_x("directory").get_doctor(_did())))


@bp.get("/absences")
@require("doctor")
def list_absences():
    return jsonify(items=[absence_json(a) for a in _x("availability").list_absences(_did())])


@bp.post("/absences")
@require("doctor")
def create_absence():
    """Surte efecto de inmediato. Las citas de ese rango NO se cancelan: se avisa al personal (sin datos de pacientes)."""
    b = body()
    start, end = instant(b.get("startUtc"), "startUtc"), instant(b.get("endUtc"), "endUtc")
    ab, affected = _x("availability").add_absence(_did(), start, end, opt_str(b, "reason"), _actor())
    if affected:
        tz, doctor = current_app.extensions["rules"].tz, _x("directory").get_doctor(_did())
        first, last = iso(start, tz)[:10], iso(end - timedelta(minutes=1), tz)[:10]   # el fin es exclusivo: 00:00 del dia siguiente
        span = f"el {first}" if first == last else f"entre el {first} y el {last}"
        _x("directory").add_attention(
            kind="absence_affects_appointments", reason="ausencia_con_citas",
            detail=f"{doctor.name} marco una ausencia con {len(affected)} cita(s) {span}: avisa a los pacientes.")
    return jsonify(absence=absence_json(ab), affectedCount=len(affected)), 201


@bp.delete("/absences/<absence_id>")
@require("doctor")
def delete_absence(absence_id):
    _x("availability").delete_absence(_did(), absence_id, _actor())      # ajena o inexistente: 404
    return "", 204


@bp.get("/schedule-change-requests")
@require("doctor")
def list_schedule_changes():
    return jsonify(items=[request_json(r) for r in _x("directory").schedule_changes(doctor_id=_did())])


@bp.post("/schedule-change-requests")
@require("doctor")
def create_schedule_change():
    b = body()
    weekly = b.get("weeklyHours")
    if not isinstance(weekly, dict):
        raise bad("weeklyHours: un horario semanal")
    r = _x("directory").create_schedule_change(_did(), weekly, day(b.get("effectiveFrom"), "effectiveFrom"),
                                               opt_str(b, "note"), _actor())
    return jsonify(request_json(r)), 201


@bp.post("/push-subscriptions")
@require("doctor")
def subscribe_push():
    b = body()
    keys = b.get("keys") if isinstance(b.get("keys"), dict) else {}
    _x("directory").subscribe_push(g.principal.user.id, b.get("endpoint"), keys.get("p256dh"), keys.get("auth"))
    return "", 204


@bp.delete("/push-subscriptions")
@require("doctor")
def unsubscribe_push():
    _x("directory").unsubscribe_push(g.principal.user.id, body().get("endpoint"))
    return "", 204
