"""Rutas HTTP. En F2 solo existe `GET /api/health`; el resto llega en F3/F4."""
from flask import Flask

from .health import bp as health_bp


def register_routes(app: Flask) -> None:
    app.register_blueprint(health_bp)
