"""Ayudas comunes de las rutas: cuerpos de error del contrato, lectura de JSON y autenticacion del bot."""
from __future__ import annotations

import hmac
import re
from functools import wraps

from flask import current_app, jsonify, request

PHONE_RE = re.compile(r"[0-9]{8,15}")


class ApiError(Exception):
    """Error de la API con su cuerpo del contrato (`{"error": codigo, "detail": ...}`) y estado HTTP.
    `clear_cookie`: ademas, borra la cookie de sesion (la que llego ya no sirve)."""

    def __init__(self, code: str, status: int, detail: str | None = None, *, clear_cookie: bool = False):
        super().__init__(code)
        self.code, self.status, self.detail, self.clear_cookie = code, status, detail, clear_cookie


def error(code: str, status: int, detail: str | None = None, **extra):
    """Respuesta de error del contrato: `{"error": codigo, "detail": ...}`."""
    body = {"error": code}
    if detail:
        body["detail"] = detail
    body.update(extra)
    return jsonify(body), status


def json_body() -> dict | None:
    """Cuerpo JSON como diccionario, o None si falta o no es un objeto. No exige la cabecera Content-Type."""
    data = request.get_json(force=True, silent=True)
    return data if isinstance(data, dict) else None


def valid_phone(value) -> str | None:
    """Telefono de WhatsApp: 8 a 15 digitos (contrato `Phone`). None si no lo es."""
    return value if isinstance(value, str) and PHONE_RE.fullmatch(value) else None


def bot_required(fn):
    """Exige `Authorization: Bearer <BOT_TOKEN>`. Falla CERRADO: sin BOT_TOKEN configurado nadie entra.
    El token se compara en tiempo constante y nunca se registra."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        expected = current_app.config.get("BOT_TOKEN") or ""
        scheme, _, token = request.headers.get("Authorization", "").partition(" ")
        if not expected or scheme.lower() != "bearer" or not hmac.compare_digest(
                token.strip().encode("utf-8"), expected.encode("utf-8")):
            resp, status = error("no_autenticado", 401)
            resp.headers["WWW-Authenticate"] = "Bearer"
            return resp, status
        return fn(*args, **kwargs)
    return wrapper
