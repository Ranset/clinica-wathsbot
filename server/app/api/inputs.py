"""Lectura y validacion de entradas de las rutas del personal y del doctor. Todo lo invalido es `AgendaError(validacion)` (422)."""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta

from flask import current_app, jsonify, make_response, request

from ..agenda import parse_dt
from ..agenda.errors import RANGO_INVALIDO, VALIDACION, AgendaError
from ..db import iso_utc, to_db
from ..models import STATUSES
from .serializers import booking_json

MAX_RANGE_DAYS = 92          # `MAX_RANGE_DAYS` de shared/calendar: la vista Lista pide EXACTAMENTE 92 dias


def bad(msg: str) -> AgendaError:
    return AgendaError(VALIDACION, msg)


def body() -> dict:
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        raise bad("se esperaba un objeto JSON")
    return data


def instant(value, field: str) -> datetime:
    """Fecha-hora ISO con zona (`...Z`) o sin ella (= hora de Cancun)."""
    if not isinstance(value, str):
        raise bad(f"{field}: se requiere una fecha-hora ISO")
    try:
        return parse_dt(value, current_app.extensions["rules"].tz)
    except ValueError:
        raise bad(f"{field}: fecha-hora invalida") from None


def day(value, field: str) -> date:
    if not isinstance(value, str):
        raise bad(f"{field}: se requiere una fecha AAAA-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise bad(f"{field}: fecha invalida (AAAA-MM-DD)") from None


def opt_str(b: dict, key: str):
    v = b.get(key)
    if v is not None and not isinstance(v, str):
        raise bad(f"{key}: debe ser texto")
    return v


def opt_bool(b: dict, key: str, default: bool = False) -> bool:
    v = b.get(key, default)
    if not isinstance(v, bool):
        raise bad(f"{key}: debe ser verdadero o falso")
    return v


def opt_int(b: dict, key: str):
    v = b.get(key)
    if v is not None and (isinstance(v, bool) or not isinstance(v, int)):
        raise bad(f"{key}: debe ser un entero")
    return v


def query_id(name: str):
    """Filtro `?doctorId=` / `?roomId=`: entero o None."""
    raw = request.args.get(name)
    if raw is None or raw == "":
        return None
    if not raw.isdigit():
        raise bad(f"{name}: debe ser un id")
    return int(raw)


def query_int(name: str, lo: int, hi: int | None = None):
    """Parametro `?limit=` / `?offset=`: un entero entre `lo` y `hi` (o `lo` en adelante), o None si no viene."""
    raw = request.args.get(name)
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except ValueError:
        raise bad(f"{name}: debe ser un entero") from None
    if value < lo or (hi is not None and value > hi):
        raise bad(f"{name}: debe estar entre {lo} y {hi}" if hi is not None else f"{name}: debe ser {lo} o mas")
    return value


def query_range() -> tuple[datetime, datetime]:
    """`[from, to)` obligatorio; `to - from` no puede pasar de 92 dias (justo 92 si cabe)."""
    start, end = instant(request.args.get("from"), "from"), instant(request.args.get("to"), "to")
    if end <= start:
        raise AgendaError(RANGO_INVALIDO, "to debe ser posterior a from")
    if end - start > timedelta(days=MAX_RANGE_DAYS):
        raise AgendaError(RANGO_INVALIDO, f"el rango maximo es de {MAX_RANGE_DAYS} dias")
    return start, end


def query_status():
    st = request.args.get("status")
    if st is not None and st not in STATUSES:
        raise bad("status: " + " | ".join(STATUSES))
    return st


def bookings_response(bookings, role: str):
    """Lista de citas con `ETag` (si coincide con `If-None-Match`, 304 sin cuerpo): el refresco periodico del calendario
    cuesta poco y no hace falta WebSockets."""
    items = [booking_json(a, role) for a in bookings]
    etag = 'W/"' + hashlib.sha1(json.dumps(items, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:24] + '"'
    sent = [t.strip() for t in request.headers.get("If-None-Match", "").split(",")]
    if etag in sent:
        resp = make_response("", 304)
    else:
        now = current_app.extensions["agenda"].now()
        resp = jsonify(items=items, serverTimeUtc=iso_utc(to_db(now).replace(microsecond=0)))
    resp.headers["ETag"] = etag
    return resp
