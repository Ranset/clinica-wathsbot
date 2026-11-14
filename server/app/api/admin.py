"""Administracion: usuarios, doctores (alta/edicion), horario de la clinica, interruptor del bot y casos de atencion.
Contrato: secciones `admin` (y las operaciones de `agenda` reservadas al administrador)."""
from __future__ import annotations

from flask import Blueprint, current_app, g, jsonify, request

from ..agenda import Actor
from ..db import iso_utc
from ..models import CHANNELS
from ..settings import MODES, get_bot_settings, parse_schedule, set_bot_channel, set_bot_channels
from .common import ApiError
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


@bp.post("/api/doctors/<doctor_id>/password-link")
@require(*STAFF)  # recepcion tambien lo genera: el doctor nuevo no tiene como entrar hasta que lo reciba
def create_password_link(doctor_id):
    """Genera el enlace (de un solo uso, vence en 72 h) con el que el doctor establece su contrasena: la primera vez, o una nueva si
    olvido la suya. Crea la cuenta si ese doctor aun no la tiene. El enlace nuevo reemplaza al anterior."""
    url, expires = _x("auth").create_password_link(doctor_id, _actor())
    return jsonify(url=url, expiresAtUtc=iso_utc(expires))


@bp.delete("/api/doctors/<doctor_id>")
@require("admin")  # eliminar es irreversible: solo el administrador; recepcion da de baja (PATCH active=false)
def delete_doctor(doctor_id):
    _x("directory").delete_doctor(doctor_id, _actor())
    return "", 204


# --------------------------------------------------------------------------- interruptor del bot
@bp.get("/api/settings/bot")
@require(*STAFF)
def get_bot():
    now = _x("agenda").now()
    with _x("db").session_factory() as s:
        return jsonify(bot_settings_json(get_bot_settings(s, now=now), now))


def _bot_changes(b: dict) -> dict:
    """Lo que pide cambiar el cuerpo. Tres formas: `{"channel": c, ...}` (UN canal: su interruptor `active`, su `mode` y/o su `schedule`),
    `{"channels": {c: x, ...}}` (varios interruptores; solo los que vienen) y `{"active": x}` (la forma vieja, sin canal: SOLO WhatsApp).
    Devuelve `{"channels": {c: bool}}` o `{"channel": c, "active"?, "mode"?, "schedule"?}`. Un canal desconocido o un valor invalido en las
    formas nuevas es 400; en la forma vieja sigue siendo 422, como siempre."""
    def invalid(msg):
        return ApiError("validacion", 400, msg)

    if "channels" in b:
        if set(b) - {"channels"}:
            raise invalid('use "channels" solo, o "channel" con "active", "mode" o "schedule"')
        ch = b["channels"]
        if not isinstance(ch, dict) or not ch:
            raise invalid('"channels" debe ser un objeto con al menos un canal: ' + ", ".join(CHANNELS))
        for canal, value in ch.items():
            if canal not in CHANNELS:
                raise invalid(f"canal desconocido; debe ser uno de: {', '.join(CHANNELS)}")
            if not isinstance(value, bool):
                raise invalid(f'el valor de "{canal}" debe ser verdadero o falso')
        return {"channels": dict(ch)}
    if "channel" in b:
        canal = b["channel"]
        if not isinstance(canal, str) or canal not in CHANNELS:
            raise invalid(f"canal desconocido; debe ser uno de: {', '.join(CHANNELS)}")
        if not ({"active", "mode", "schedule"} & set(b)):
            raise invalid('con "channel" falta "active", "mode" o "schedule"')
        if set(b) - {"channel", "active", "mode", "schedule"}:
            raise invalid("campos desconocidos en la peticion")
        if "active" in b and not isinstance(b["active"], bool):
            raise invalid('"active" debe ser verdadero o falso')
        if "mode" in b and b["mode"] not in MODES:
            raise invalid('"mode" debe ser ' + " | ".join(MODES))
        if "schedule" in b and parse_schedule(b["schedule"]) is None:
            raise invalid('"schedule" necesita days (mon..sun, sin repetir), start y end (HH:MM, distintos)')
        return {"channel": canal, **{k: b[k] for k in ("active", "mode", "schedule") if k in b}}
    active = b.get("active")                     # forma vieja: sin canal = WhatsApp
    if not isinstance(active, bool):
        raise bad('"active" debe ser verdadero o falso')
    return {"channels": {"whatsapp": active}}


@bp.put("/api/settings/bot")
@require(*STAFF)
def set_bot():
    plan = _bot_changes(body())
    now = _x("agenda").now()
    with _x("db").session_factory() as s, s.begin():
        if "channels" in plan:
            st = set_bot_channels(s, plan["channels"], _actor(), now=now)
        else:
            try:
                st = set_bot_channel(s, plan["channel"], active=plan.get("active"), mode=plan.get("mode"), schedule=plan.get("schedule"),
                                     actor=_actor(), now=now)
            except ValueError as e:                  # p. ej. pasar a `schedule` sin horario: nada cambio
                raise ApiError("validacion", 400, str(e)) from None
        return jsonify(bot_settings_json(st, now))


# --------------------------------------------------------------------------- casos de atencion
@bp.get("/api/attention")
@require(*STAFF)
def list_attention():
    """Mas reciente primero. Sin `limit` salen todos (los pendientes son pocos); los atendidos se piden por paginas."""
    limit, offset = query_int("limit", 1, MAX_PAGE_SIZE), query_int("offset", 0)
    if offset and limit is None:
        raise bad("offset: solo se admite junto con limit")
    channel = request.args.get("channel")
    if channel is not None and channel not in CHANNELS:
        raise bad("channel: " + " | ".join(CHANNELS))
    rows, total = _x("directory").attention(request.args.get("status", "open"), limit=limit, offset=offset or 0, channel=channel)
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
    if b.get("role") == "doctor":     # la cuenta de un doctor nace con el doctor (sin correo ni contrasena): aqui solo personal y administrador
        raise bad("Aquí solo se crean usuarios de personal y administrador. La cuenta de un doctor se crea sola al darlo de alta; "
                  "en «Datos» del doctor se genera el enlace para que establezca su contraseña.")
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
