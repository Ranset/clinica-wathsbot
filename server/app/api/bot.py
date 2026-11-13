"""Endpoints del bot (`/api/bot/*`, token de servicio). Contrato: `docs/openapi.yaml`, seccion `bot`.

Son una capa delgada sobre el motor de agenda (`Agenda`) y la cola (`EventQueue`): validan la entrada, llaman al motor y
traducen su resultado al estado HTTP del contrato (409 conflicto, 404 no existe o no es tuya, 422 regla incumplida).
La identidad del paciente la manda el bot (el `message.sender.id` de Zernio), nunca texto del chat: es el `telefono` en WhatsApp
o `canal` + `contacto_id` en Messenger / Instagram, y el motor solo deja ver/cambiar/cancelar las citas de ESA identidad.
Identidad o canal invalidos en las rutas nuevas = 400; los errores de siempre de WhatsApp siguen en 422.
"""
from __future__ import annotations

from datetime import date

from flask import Blueprint, current_app, jsonify, request

from ..agenda import parse_dt
from ..agenda.errors import HTTP_STATUS
from ..agenda.identity import CONTACT_ID_RE, Identity
from ..events import HANDOFF_REASONS, OUTCOMES
from ..models import CHANNELS
from ..settings import get_bot_settings
from .common import bot_required, error, json_body, valid_phone
from .serializers import bot_settings_json

bp = Blueprint("bot", __name__, url_prefix="/api/bot")


def _agenda():
    return current_app.extensions["agenda"]


def _events():
    return current_app.extensions["events"]


def _bad(detail: str):
    return error("validacion", 422, detail)


def _bad400(detail: str):
    return error("validacion", 400, detail)


def _identity(src, *, optional_phone: bool = False):
    """Quien escribe, de un cuerpo JSON o de los parametros de la URL: `telefono` (WhatsApp) o `canal` + `contacto_id`, nunca mezcladas.

    Devuelve `(Identity, None)`; `(None, respuesta_400)` si el canal o el id de Meta son invalidos; o `(None, None)` si es WhatsApp y
    el telefono falta o esta mal formado (cada ruta responde entonces su 422 de siempre, igual que antes de que hubiera canales).
    `optional_phone`: el traspaso a una persona acepta WhatsApp sin telefono (devuelve `(Identity("whatsapp", ""), None)`).
    `canal` ausente = WhatsApp; en WhatsApp un `contacto_id` suelto se ignora (alli no se usa)."""
    canal = src.get("canal")
    if canal is None:
        canal = "whatsapp"
    if not isinstance(canal, str) or canal not in CHANNELS:
        return None, _bad400("canal debe ser " + " | ".join(CHANNELS))
    telefono = src.get("telefono")
    if canal == "whatsapp":
        if telefono is None and optional_phone:
            return Identity("whatsapp", ""), None
        phone = valid_phone(telefono)
        return (Identity("whatsapp", phone), None) if phone else (None, None)
    if telefono is not None:
        return None, _bad400("telefono solo aplica a whatsapp")
    cid = src.get("contacto_id")
    if not isinstance(cid, str) or not CONTACT_ID_RE.fullmatch(cid):
        return None, _bad400("contacto_id es obligatorio fuera de whatsapp (letras, digitos, - y _; de 5 a 64 caracteres)")
    return Identity(canal, cid), None


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
    return jsonify(bot_settings_json(st))


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
    """Accion `mis_citas`: solo las de la identidad indicada (telefono, o canal + contacto_id)."""
    ident, bad = _identity(request.args)
    if bad is not None:
        return bad
    if ident is None:
        return _bad("telefono invalido (8 a 15 digitos)")
    return jsonify(citas=_agenda().mine(ident))


@bp.post("/appointments")
@bot_required
def book():
    """Accion `agendar`: reserva atomica; el servidor elige consultorio."""
    b = json_body() or {}
    ident, bad = _identity(b)
    if bad is not None:
        return bad
    contact_phone = None
    if ident is not None and not ident.is_whatsapp:  # sin telefono real, la clinica no tendria como llamar al paciente
        contact_phone = valid_phone(b.get("telefono_contacto"))
        if not contact_phone:
            return _bad400("se requiere telefono_contacto (8 a 15 digitos) para este canal")
    nombre = b.get("nombre")
    especialidad, inicio = b.get("especialidad"), _when(b.get("inicio"))
    if ident is None or not isinstance(nombre, str) or not isinstance(especialidad, str) or inicio is None:
        return _bad("se requieren telefono (digitos), nombre, especialidad e inicio")
    res = _agenda().book(ident, nombre.strip(), especialidad, inicio, contact_phone=contact_phone)
    return (jsonify(res), 201) if res.get("ok") else _rule_error(res)


@bp.post("/appointments/<cita_id>/cancel")
@bot_required
def cancel(cita_id):
    """Accion `cancelar`: 404 si la cita no existe O es de otra identidad (otro telefono, otro id u otro canal: no se distingue)."""
    ident, bad = _identity(json_body() or {})
    if bad is not None:
        return bad
    if ident is None:
        return _bad("telefono invalido (8 a 15 digitos)")
    res = _agenda().cancel(ident, cita_id)
    return jsonify(res) if res.get("ok") else _rule_error(res)


@bp.post("/appointments/<cita_id>/reschedule")
@bot_required
def reschedule(cita_id):
    """Accion `reprogramar`: atomica; si el nuevo horario falla, la cita original se conserva."""
    b = json_body() or {}
    ident, bad = _identity(b)
    if bad is not None:
        return bad
    inicio = _when(b.get("inicio"))
    if ident is None or inicio is None:
        return _bad("se requieren telefono (digitos) e inicio")
    res = _agenda().reschedule(ident, cita_id, inicio)
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
    ident, bad = _identity(b, optional_phone=True)
    if bad is not None:
        return bad
    if (not isinstance(conv, str) or not conv.strip() or reason not in HANDOFF_REASONS
            or (phone is not None and not valid_phone(phone)) or (detail is not None and not isinstance(detail, str))):
        return _bad("se requieren conversationId y reason (" + " | ".join(HANDOFF_REASONS) + "); telefono y detail opcionales")
    if ident is None or ident.is_whatsapp:  # igual que siempre
        return jsonify(id=str(_events().handoff(conv, reason, phone, detail))), 201
    # Messenger / Instagram: sin telefono; el caso guarda el canal y el id de Meta (nunca el texto del paciente)
    return jsonify(id=str(_events().handoff(conv, reason, None, detail, channel=ident.channel, contact_id=ident.key))), 201
