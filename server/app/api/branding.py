"""Marca de la clinica (nombre y logotipo). Contrato: seccion `branding`.

- `GET /api/branding` y `GET /api/branding/logo` son PUBLICOS: el login ya muestra el nombre y el logotipo (aun no hay sesion).
  No son datos privados: es la marca de la clinica.
- Cambiarlos (`PUT /api/settings/branding`, `PUT|DELETE /api/settings/branding/logo`) es SOLO del administrador.
- El logotipo viaja como bytes de la imagen (PNG, JPG o WebP, cuadrada). Se valida por sus BYTES (`app/images.py`), no por el
  nombre ni por `Content-Type`; SVG no se acepta.
"""
from __future__ import annotations

from flask import Blueprint, Response, current_app, g, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from ..agenda import Actor
from ..branding import Branding, BrandingError, clean_name, delete_logo, get_branding, read_logo, set_logo, set_name
from ..images import MAX_BYTES, ImageError
from .common import ApiError
from .inputs import bad, body
from .security import require

bp = Blueprint("branding", __name__)


def _sf():
    return current_app.extensions["db"].session_factory


def _actor() -> Actor:
    return Actor.user(g.principal.user.id)


def _json(b: Branding) -> dict:
    # `?v=` es la huella de la imagen: al cambiar el logotipo cambia la URL y ningun cache muestra el anterior
    return {"name": b.name, "logoUrl": f"/api/branding/logo?v={b.logo_sha256[:12]}" if b.logo_sha256 else None}


@bp.get("/api/branding")
def get_branding_info():
    with _sf()() as s:
        b = get_branding(s)
    resp = jsonify(_json(b))
    resp.headers["Cache-Control"] = "no-cache"          # el nombre se puede cambiar: que siempre se confirme
    return resp


@bp.get("/api/branding/logo")
def get_logo():
    with _sf()() as s:
        row = read_logo(s)
        if row is None:
            raise ApiError("no_encontrado", 404)
        data, content_type, sha = row.data, row.content_type, row.sha256
    etag = f'"{sha}"'
    headers = {"ETag": etag, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff",
               "Content-Security-Policy": "default-src 'none'"}
    if etag in [t.strip() for t in request.headers.get("If-None-Match", "").split(",")]:
        return Response(status=304, headers=headers)
    return Response(data, mimetype=content_type, headers=headers)


@bp.put("/api/settings/branding")
@require("admin")
def put_name():
    b = body()
    if "name" not in b:
        raise bad('falta "name"')
    try:
        name = clean_name(b["name"])
    except BrandingError as e:
        raise bad(str(e)) from None
    with _sf()() as s, s.begin():
        return jsonify(_json(set_name(s, name, _actor())))


@bp.put("/api/settings/branding/logo")
@require("admin")
def put_logo():
    # El tope general de peticiones (`MAX_CONTENT_LENGTH`, ~1 MB, pensado para los webhooks) dejaria fuera un logotipo de justo
    # 1 MB: para esta ruta se sube a «1 MB + 1 byte». Se lee COMO MUCHO eso: un archivo enorme no se carga entero en memoria.
    request.max_content_length = MAX_BYTES + 1
    try:
        data = request.stream.read(MAX_BYTES + 1)
    except RequestEntityTooLarge:
        raise bad(f"La imagen pesa más de {MAX_BYTES // (1024 * 1024)} MB.") from None
    try:
        with _sf()() as s, s.begin():
            return jsonify(_json(set_logo(s, data, _actor())))
    except ImageError as e:
        raise bad(str(e)) from None


@bp.delete("/api/settings/branding/logo")
@require("admin")
def remove_logo():
    with _sf()() as s, s.begin():
        return jsonify(_json(delete_logo(s, _actor())))
