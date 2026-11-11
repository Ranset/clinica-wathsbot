"""Errores y cabeceras comunes: TODA respuesta de /api y /webhooks es JSON (el cliente del bot trata un cuerpo que no es
JSON como API caida, y Zernio reintenta un 2xx con HTML). Nada de paginas HTML de error de Flask."""
from __future__ import annotations

from flask import Flask, current_app, jsonify, request
from werkzeug.exceptions import HTTPException

from ..agenda.errors import AgendaError
from ..auth import AuthError
from .common import ApiError

_CODES = {401: "no_autenticado", 403: "sin_permiso", 404: "no_encontrado"}


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(ApiError)
    def api_error(e: ApiError):
        body = {"error": e.code}
        if e.detail:
            body["detail"] = e.detail
        resp = jsonify(body)
        resp.status_code = e.status
        if e.clear_cookie:
            from .security import clear_session_cookie
            clear_session_cookie(resp)
        return resp

    @app.errorhandler(AgendaError)
    def agenda_error(e: AgendaError):
        resp = jsonify(e.body())
        resp.status_code = e.http_status
        return resp

    @app.errorhandler(AuthError)
    def auth_error(e: AuthError):
        resp = jsonify(error=e.code)
        resp.status_code = e.status
        if e.retry_after:
            resp.headers["Retry-After"] = str(e.retry_after)
        return resp

    @app.errorhandler(HTTPException)
    def http_error(e: HTTPException):
        status = e.code or 500
        code = _CODES.get(status, "validacion" if status < 500 else "error_interno")
        resp = jsonify(error=code, detail=e.description)
        resp.status_code = status
        if status == 405 and getattr(e, "valid_methods", None):
            resp.headers["Allow"] = ", ".join(e.valid_methods)
        return resp

    @app.errorhandler(Exception)
    def unexpected(e: Exception):
        if current_app.testing or current_app.debug:
            raise e  # en pruebas y desarrollo se quiere ver el traceback
        current_app.logger.exception("error no controlado en %s %s", request.method, request.path)
        return jsonify(error="error_interno"), 500

    @app.after_request
    def no_store(resp):
        # datos de pacientes y sesiones: que ningun intermediario ni navegador los guarde
        if request.path.startswith(("/api/", "/webhooks/")):
            resp.headers.setdefault("Cache-Control", "no-store")
        return resp
