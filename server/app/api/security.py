"""Seguridad de las rutas de personas: sesion por cookie, roles, CSRF y `Origin`. (El bot usa su propio token: `common.bot_required`.)

Orden de las comprobaciones, para que cada fallo diga lo correcto sin filtrar informacion:
  1. sin sesion valida                      -> 401 `no_autenticado` (y se borra una cookie vencida)
  2. rol no permitido                       -> 403 `sin_permiso`
  3. escritura sin `X-CSRF-Token` correcto  -> 403 `sin_permiso` (`detail: csrf`); lo mismo si el `Origin` no es el propio sitio
Un doctor que pide algo de otro doctor no llega aqui: lo ajeno se trata como inexistente (404) en cada ruta.
"""
from __future__ import annotations

import hmac
from functools import wraps
from urllib.parse import urlsplit

from flask import current_app, g, request

from ..auth import Principal
from .common import ApiError

COOKIE = "clinica_session"
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


def forbidden(detail: str | None = None) -> ApiError:
    return ApiError("sin_permiso", 403, detail)


def check_origin() -> None:
    """Si el navegador manda `Origin`, debe ser este mismo sitio (web de administracion y PWA van bajo el mismo origen)."""
    origin = request.headers.get("Origin")
    if origin is not None and urlsplit(origin).netloc != request.host:
        raise forbidden("csrf")


def set_session_cookie(resp, token: str) -> None:
    cfg = current_app.config
    resp.set_cookie(COOKIE, token, max_age=int(cfg["SESSION_MAX_DAYS"]) * 86400, path="/", httponly=True,
                    samesite="Lax", secure=bool(cfg["AUTH_COOKIE_SECURE"]))


def clear_session_cookie(resp) -> None:
    resp.delete_cookie(COOKIE, path="/", httponly=True, samesite="Lax", secure=bool(current_app.config["AUTH_COOKIE_SECURE"]))


def authenticate() -> Principal:
    token = request.cookies.get(COOKIE)
    principal = current_app.extensions["auth"].resolve(token) if token else None
    if principal is None:
        raise ApiError("no_autenticado", 401, clear_cookie=bool(token))
    return principal


def require(*roles: str):
    """Decorador: exige sesion y, si se indican, uno de esos roles. En escrituras exige CSRF y `Origin` propio.
    Deja el usuario en `g.principal`."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            p = authenticate()
            if roles and p.role not in roles:
                raise forbidden()
            if request.method not in SAFE_METHODS:
                check_origin()
                sent = request.headers.get("X-CSRF-Token", "")
                if not sent or not hmac.compare_digest(sent.encode("utf-8"), p.csrf_token.encode("utf-8")):
                    raise forbidden("csrf")
            g.principal = p
            return fn(*args, **kwargs)
        return wrapper
    return deco
