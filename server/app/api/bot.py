"""Endpoints del bot de WhatsApp (`/api/bot/*`, token de servicio). Contrato: `docs/openapi.yaml`, seccion `bot`.

Son una capa delgada sobre el motor de agenda (`Agenda`) y la cola (`EventQueue`): validan la entrada, llaman al motor y
traducen su resultado al estado HTTP del contrato (409 conflicto, 404 no existe o no es tuya, 422 regla incumplida).
La identidad del paciente es el `telefono` que manda el bot (el `message.sender.id` de Zernio), nunca texto del chat:
el motor solo deja ver/cambiar/cancelar las citas de ESE telefono.
"""
from __future__ import annotations

from datetime import date

from flask import Blueprint, current_app, jsonify, request

from ..agenda import parse_dt
from ..agenda.errors import HTTP_STATUS
from ..db import iso_utc
from ..events import HANDOFF_REASONS, OUTCOMES
from ..settings import get_bot_settings
from .common import bot_required, error, json_body, valid_phone

bp = Blueprint("bot", __name__, url_prefix="/api/bot")


def _agenda():
    return current_app.extensions["agenda"]


def _events():
    return current_app.extensions["events"]


def _bad(detail: str):
    return error("validacion", 422, detail)


def _rule_error(res: dict):
    """Resultado de error del motor (`{"error": codigo, ...}`) -> su estado HTTP, con el cuerpo tal cual."""
    return jsonify(res), HTTP_STATUS.get(res.get("error"), 422)


def _when(value):
    """Instante de la peticion; sin desfase = hora de la clinica. None si no se entiende."""
    if not isinstance(value, str):
        return None
    try:
        return parse_dt(value, current_app.extensions["rules"].tz)
    except ValueError:
        return None


def _num(value, lo, hi, cast=float):
    """`cast(value)` dentro de [lo, hi]; ValueError si no. `value` None = ausente."""
    if value is None:
        return None
    n = cast(value)
    if not lo <= n <= hi:
        raise ValueError(value)
    return n


def _strict_int(v):
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(v)
    return v


# --------------------------------------------------------------------------- estado y configuracion
@bp.get("/status")
@bot_required
def status():
    """Interruptor del bot. El bot lo consulta antes de contestar cada evento. (F4 anade el acceso con sesion de personal.)"""
    with current_app.extensions["db"].session_factory() as s:
        st = get_bot_settings(s)
    out = {"active": st.active}
    if st.updated_at:
        out.update(updatedAt=iso_utc(st.updated_at), updatedBy=st.updated_by)
    return jsonify(out)


@bp.get("/config")
@bot_required
def config():
    return jsonify(_agenda().bot_config())


# --------------------------------------------------------------------------- agenda
@bp.get("/availability")
@bot_required
def availability():
    """Accion `horarios`."""
    a = request.args
    especialidad = (a.get("especialidad") or "").strip()
    if not especialidad:
        return _bad("falta especialidad")
    try:
        desde = date.fromisoformat(a["desde"]) if a.get("desde") else None
        hora_min, hora_max = _num(a.get("hora_min"), 0, 24), _num(a.get("hora_max"), 0, 24)
        dias = _num(a.get("dias", "7"), 1, 60, int)
    except ValueError:
        return _bad("desde, hora_min, hora_max o dias invalidos")
    res = _agenda().free_slots(especialidad, from_day=desde, days=dias, hora_min=hora_min, hora_max=hora_max)
    return _rule_error(res) if "error" in res else jsonify(res)


@bp.get("/nearest")
@bot_required
def nearest():
    """Accion `cercanos`."""
    especialidad = (request.args.get("especialidad") or "").strip()
    target = _when(request.args.get("fecha_hora"))
    if not especialidad or target is None:
        return _bad("faltan especialidad o fecha_hora (AAAA-MM-DDTHH:MM)")
    res = _agenda().nearest(especialidad, target)
    return _rule_error(res) if "error" in res else jsonify(res)


@bp.get("/appointments")
@bot_required
def my_appointments():
    """Accion `mis_citas`: solo las del telefono indicado."""
    phone = valid_phone(request.args.get("telefono"))
    if not phone:
        return _bad("telefono invalido (8 a 15 digitos)")
    return jsonify(citas=_agenda().mine(phone))


@bp.post("/appointments")
@bot_required
def book():
    """Accion `agendar`: reserva atomica; el servidor elige consultorio."""
    b = json_body() or {}
    phone, nombre = valid_phone(b.get("telefono")), b.get("nombre")
    especialidad, inicio = b.get("especialidad"), _when(b.get("inicio"))
    if not phone or not isinstance(nombre, str) or not isinstance(especialidad, str) or inicio is None:
        return _bad("se requieren telefono (digitos), nombre, especialidad e inicio")
    res = _agenda().book(phone, nombre.strip(), especialidad, inicio)
    return (jsonify(res), 201) if res.get("ok") else _rule_error(res)


@bp.post("/appointments/<cita_id>/cancel")
@bot_required
def cancel(cita_id):
    """Accion `cancelar`: 404 si la cita no existe O es de otro telefono (no se distingue)."""
    phone = valid_phone((json_body() or {}).get("telefono"))
    if not phone:
        return _bad("telefono invalido (8 a 15 digitos)")
    res = _agenda().cancel(phone, cita_id)
    return jsonify(res) if res.get("ok") else _rule_error(res)


@bp.post("/appointments/<cita_id>/reschedule")
@bot_required
def reschedule(cita_id):
    """Accion `reprogramar`: atomica; si el nuevo horario falla, la cita original se conserva."""
    b = json_body() or {}
    phone, inicio = valid_phone(b.get("telefono")), _when(b.get("inicio"))
    if not phone or inicio is None:
        return _bad("se requieren telefono (digitos) e inicio")
    res = _agenda().reschedule(phone, cita_id, inicio)
    return jsonify(res) if res.get("ok") else _rule_error(res)


# --------------------------------------------------------------------------- cola de eventos
@bp.post("/events/claim")
@bot_required
def claim():
    if request.get_data().strip():
        b = json_body()
        if b is None:
            return _bad("cuerpo JSON invalido")
    else:
        b = {}
    try:  # un valor presente debe ser entero (ni null, ni texto, ni booleano); ausente = el valor por defecto
        limit = _num(_strict_int(b.get("limit", 5)), 1, 20, int)
        lease = _num(_strict_int(b.get("leaseSeconds", 120)), 10, 600, int)
    except ValueError:
        return _bad("limit (1-20) o leaseSeconds (10-600) invalidos")
    return jsonify(events=_events().claim(limit, lease))


@bp.post("/events/<event_id>/ack")
@bot_required
def ack(event_id):
    outcome = (json_body() or {}).get("outcome")
    if not isinstance(outcome, str) or outcome not in OUTCOMES:
        return _bad("outcome debe ser " + " | ".join(OUTCOMES))
    return ("", 204) if _events().ack(event_id, outcome) else error("no_encontrado", 404)


@bp.post("/events/<event_id>/fail")
@bot_required
def fail(event_id):
    b = json_body() or {}
    reason, retry = b.get("reason"), b.get("retry", True)
    if not isinstance(reason, str) or not isinstance(retry, bool):
        return _bad("se requiere reason (texto) y, opcional, retry (booleano)")
    return ("", 204) if _events().fail(event_id, reason, retry) else error("no_encontrado", 404)


@bp.post("/handoffs")
@bot_required
def handoff():
    """El bot pasa la conversacion a una persona (aparece en `/api/attention`, F4)."""
    b = json_body() or {}
    conv, reason, detail = b.get("conversationId"), b.get("reason"), b.get("detail")
    phone = b.get("telefono")
    if (not isinstance(conv, str) or not conv.strip() or reason not in HANDOFF_REASONS
            or (phone is not None and not valid_phone(phone)) or (detail is not None and not isinstance(detail, str))):
        return _bad("se requieren conversationId y reason (" + " | ".join(HANDOFF_REASONS) + "); telefono y detail opcionales")
    return jsonify(id=str(_events().handoff(conv, reason, phone, detail))), 201
