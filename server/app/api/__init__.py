"""Rutas HTTP: bot (token de servicio), webhook de Zernio (firma HMAC) y personas (sesion por cookie, roles y CSRF)."""
from flask import Flask

from .admin import bp as admin_bp
from .authn import bp as authn_bp
from .bot import bp as bot_bp
from .doctor import bp as doctor_bp
from .errors import register_error_handlers
from .health import bp as health_bp
from .staff import bp as staff_bp
from .webhook import bp as webhook_bp


def register_routes(app: Flask) -> None:
    register_error_handlers(app)
    for bp in (health_bp, bot_bp, webhook_bp, authn_bp, staff_bp, admin_bp, doctor_bp):
        app.register_blueprint(bp)
