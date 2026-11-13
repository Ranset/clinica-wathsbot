"""Sesion de personas: `POST /api/auth/login` (correo), `POST /api/auth/doctor-login` (codigo del doctor) con su lista publica
`GET /api/auth/doctors`, el enlace para establecer la contrasena (`POST /api/auth/password-link/check|use`), `POST /api/auth/logout`,
`GET /api/me`. Contrato: seccion `auth`."""
from __future__ import annotations

from flask import Blueprint, current_app, g, jsonify, make_response, request

from ..db import iso_utc
from .inputs import bad, body
from .security import COOKIE, check_origin, clear_session_cookie, require, set_session_cookie
from .serializers import user_json

bp = Blueprint("authn", __name__)


@bp.post("/api/auth/login")
def login():
    check_origin()                                   # el login no lleva CSRF (aun no hay sesion), pero si `Origin` propio
    b = body()
    email, password = b.get("email"), b.get("password")
    if not isinstance(email, str) or not email.strip() or not isinstance(password, str) or not password:
        raise bad("se requieren email y password")
    user, token, csrf = current_app.extensions["auth"].login(email, password)
    resp = jsonify(user=user_json(user), csrfToken=csrf)
    set_session_cookie(resp, token)
    return resp


@bp.get("/api/auth/doctors")
def login_doctors():
    """PUBLICO (aun no hay sesion): la lista de la pantalla de entrada del doctor. Solo codigo y nombre de quienes tienen cuenta activa."""
    resp = jsonify(items=[{"code": code, "name": name} for code, name in current_app.extensions["auth"].login_doctors()])
    resp.headers["Cache-Control"] = "no-store"          # un doctor nuevo o dado de baja se nota de inmediato
    return resp


@bp.post("/api/auth/doctor-login")
def doctor_login():
    """Entrada del doctor con su codigo de 4 digitos y su contrasena (sin correo). Mismas reglas, bloqueo y cookie que `login`."""
    check_origin()
    b = body()
    code, password = b.get("doctorCode"), b.get("password")
    if not isinstance(code, str) or not code.strip() or not isinstance(password, str) or not password:
        raise bad("se requieren doctorCode y password")
    user, token, csrf = current_app.extensions["auth"].login_doctor(code, password)
    resp = jsonify(user=user_json(user), csrfToken=csrf)
    set_session_cookie(resp, token)
    return resp


@bp.post("/api/auth/password-link/check")
def check_password_link():
    """PUBLICO: para la pagina del enlace, de quien es (codigo y nombre del doctor) y hasta cuando vale. Un enlace desconocido,
    vencido o ya usado es el mismo 404 `enlace_invalido`. El enlace viaja en el CUERPO (no en la URL): no queda en bitacoras de acceso."""
    check_origin()
    code, name, expires = current_app.extensions["auth"].check_password_link(body().get("token"))
    return jsonify(doctorCode=code, doctorName=name, expiresAtUtc=iso_utc(expires))


@bp.post("/api/auth/password-link/use")
def use_password_link():
    """PUBLICO: el doctor establece su contrasena con el enlace (un solo uso) y entra de una vez, con la misma cookie que el login."""
    check_origin()
    b = body()
    if not isinstance(b.get("token"), str) or not b["token"] or not isinstance(b.get("password"), str):
        raise bad("se requieren token y password")
    user, token, csrf = current_app.extensions["auth"].use_password_link(b["token"], b["password"])
    resp = jsonify(user=user_json(user), csrfToken=csrf)
    set_session_cookie(resp, token)
    return resp


@bp.post("/api/auth/logout")
@require()
def logout():
    current_app.extensions["auth"].logout(request.cookies.get(COOKIE))
    resp = make_response("", 204)
    clear_session_cookie(resp)
    return resp


@bp.get("/api/me")
@require()
def me():
    p = g.principal
    return jsonify(user=user_json(p.user), csrfToken=p.csrf_token)
