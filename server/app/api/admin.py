"""Administracion: usuarios, doctores (alta/edicion), horario de la clinica, interruptor del bot y casos de atencion.
Contrato: secciones `admin` (y las operaciones de `agenda` reservadas al administrador)."""
from __future__ import annotations

from flask import Blueprint, current_app, g, jsonify, request

from ..agenda import Actor
from ..settings import get_bot_settings, set_bot_active
from .inputs import bad, body, opt_bool, query_int
from .security import require
from .serializers import attention_json, bot_settings_json, doctor_json, user_json

bp = Blueprint("admin", __name__)
STAFF = ("admin", "staff")
MAX_PAGE_SIZE = 100      # tope de `?limit=` en las listas paginadas


def _x(name):
    return current_app.extensions[name]


def _actor() -> Actor:
    return Actor.user(g.principal.user.id)


# --------------------------------------------------------------------------- horario de la clinica y doctores
@bp.put("/api/clinic-hours")
@require(*STAFF)  # recepcion tambien cambia el horario de la clinica (decidido el 2026-11-11); el doctor no
def set_clinic_hours():
    return jsonify(_x("availability").set_clinic_hours(body(), _actor()))


@bp.post("/api/doctors")
@require(*STAFF)  # recepcion tambien da de alta doctores (decidido el 2026-11-11)
def create_doctor():
    return jsonify(doctor_json(_x("directory").create_doctor(body(), _actor()))), 201


@bp.patch("/api/doctors/<doctor_id>")
@require(*STAFF)  # ...y los edita o da de baja (active=false)
def update_doctor(doctor_id):
    return jsonify(doctor_json(_x("directory").update_doctor(doctor_id, body(), _actor())))


@bp.delete("/api/doctors/<doctor_id>")
@require("admin")  # eliminar es irreversible: solo el administrador; recepcion da de baja (PATCH active=false)
def delete_doctor(doctor_id):
    _x("directory").delete_doctor(doctor_id, _actor())
    return "", 204


# --------------------------------------------------------------------------- interruptor del bot
@bp.get("/api/settings/bot")
@require(*STAFF)
def get_bot():
    with _x("db").session_factory() as s:
        return jsonify(bot_settings_json(get_bot_settings(s)))


@bp.put("/api/settings/bot")
@require(*STAFF)
def set_bot():
    active = body().get("active")
    if not isinstance(active, bool):
        raise bad('"active" debe ser verdadero o falso')
    with _x("db").session_factory() as s, s.begin():
        return jsonify(bot_settings_json(set_bot_active(s, active, _actor())))


# --------------------------------------------------------------------------- casos de atencion
@bp.get("/api/attention")
@require(*STAFF)
def list_attention():
    """Mas reciente primero. Sin `limit` salen todos (los pendientes son pocos); los atendidos se piden por paginas."""
    limit, offset = query_int("limit", 1, MAX_PAGE_SIZE), query_int("offset", 0)
    if offset and limit is None:
        raise bad("offset: solo se admite junto con limit")
    rows, total = _x("directory").attention(request.args.get("status", "open"), limit=limit, offset=offset or 0)
    return jsonify(items=[attention_json(c) for c in rows], total=total)


@bp.post("/api/attention/<attention_id>/resolve")
@require(*STAFF)
def resolve_attention(attention_id):
    return jsonify(attention_json(_x("directory").resolve_attention(attention_id, _actor())))


# --------------------------------------------------------------------------- usuarios
@bp.get("/api/users")
@require("admin")
def list_users():
    return jsonify(items=[user_json(u) for u in _x("auth").list_users()])


@bp.post("/api/users")
@require("admin")
def create_user():
    b = body()
    u = _x("auth").create_user(email=b.get("email"), name=b.get("name"), role=b.get("role"), password=b.get("password"),
                               doctor_id=b.get("doctorId"), actor=_actor())
    return jsonify(user_json(u)), 201


@bp.patch("/api/users/<user_id>")
@require("admin")
def update_user(user_id):
    b = body()
    patch = {k: b[k] for k in ("name", "role", "active", "password") if k in b}
    if "doctorId" in b:
        patch["doctor_id"] = b["doctorId"]
    return jsonify(user_json(_x("auth").update_user(user_id, patch, _actor())))
