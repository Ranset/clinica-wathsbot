"""Sesion de personas: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`. Contrato: seccion `auth`."""
from __future__ import annotations

from flask import Blueprint, current_app, g, jsonify, make_response, request

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
