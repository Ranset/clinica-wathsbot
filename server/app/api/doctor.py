"""Agenda personal del doctor (`/api/doctor/*`, PWA). Contrato: seccion `doctor`.

SIEMPRE acotado al `doctor_id` de la sesion: no hay ninguna ruta que reciba el id de otro doctor, y una ausencia ajena
se trata como inexistente (404, no 403). Las citas salen SIN el telefono del paciente.
"""
from __future__ import annotations

from datetime import timedelta

from flask import Blueprint, current_app, g, jsonify

from ..agenda import UNSET, Actor, iso
from .inputs import bad, body, bookings_response, day, instant, opt_str, query_range
from .security import require
from .serializers import absence_json, doctor_json, personal_event_json, request_json

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


@bp.get("/personal-events")
@require("doctor")
def list_personal_events():
    start, end = query_range()
    return jsonify(items=[personal_event_json(e) for e in _x("availability").list_personal_events(_did(), start, end)])


@bp.post("/personal-events")
@require("doctor")
def create_personal_event():
    """Evento personal: el doctor no se ofrece en esa franja, pero el consultorio queda libre. Sobre una cita = 409."""
    b = body()
    ev = _x("availability").add_personal_event(
        _did(), opt_str(b, "title"), opt_str(b, "notes"), instant(b.get("startUtc"), "startUtc"),
        instant(b.get("endUtc"), "endUtc"), _actor())
    return jsonify(personal_event_json(ev)), 201


@bp.patch("/personal-events/<event_id>")
@require("doctor")
def update_personal_event(event_id):
    b = body()
    if not any(k in b for k in ("title", "notes", "startUtc", "endUtc")):
        raise bad("no hay nada que cambiar")
    ev = _x("availability").update_personal_event(
        _did(), event_id,
        title=opt_str(b, "title") if "title" in b else UNSET, notes=opt_str(b, "notes") if "notes" in b else UNSET,
        start=instant(b["startUtc"], "startUtc") if "startUtc" in b else None,
        end=instant(b["endUtc"], "endUtc") if "endUtc" in b else None, actor=_actor())
    return jsonify(personal_event_json(ev))


@bp.delete("/personal-events/<event_id>")
@require("doctor")
def delete_personal_event(event_id):
    _x("availability").delete_personal_event(_did(), event_id, _actor())     # ajeno o inexistente: 404
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


@bp.delete("/schedule-change-requests/<request_id>")
@require("doctor")
def delete_schedule_change(request_id):
    """Solo una solicitud PROPIA y pendiente (ajena o inexistente: 404; ya resuelta: 409)."""
    _x("directory").delete_schedule_change(_did(), request_id, _actor())
    return "", 204


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
