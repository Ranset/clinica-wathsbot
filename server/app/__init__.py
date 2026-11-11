"""App factory de Flask. Servicios (motor de agenda, BD) viven en `app.extensions`."""
from __future__ import annotations

from dataclasses import dataclass

from flask import Flask
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from .agenda import Agenda, Availability, Rules
from .config import load_config
from .db import make_engine, make_session_factory
from .auth import AuthService
from .directory import Directory
from .events import EventQueue


@dataclass
class Database:
    engine: Engine
    session_factory: sessionmaker[Session]


def create_app(config: dict | None = None, *, clock=None) -> Flask:
    """`config` sobrescribe variables de entorno y valores por defecto (ver `app/config.py`).
    `clock` (opcional) es una funcion sin argumentos que devuelve el "ahora" con zona; solo para pruebas."""
    app = Flask(__name__)
    cfg = load_config(config)
    app.config.update(cfg)

    engine = make_engine(cfg["DATABASE_URL"], echo=bool(cfg["SQL_ECHO"]), pool_size=cfg.get("POOL_SIZE"))
    sf = make_session_factory(engine)
    rules = Rules.from_config(cfg)
    app.extensions["db"] = Database(engine, sf)
    app.extensions["rules"] = rules
    app.extensions["agenda"] = Agenda(sf, rules, clock)
    app.extensions["availability"] = Availability(sf, rules, clock)
    app.extensions["auth"] = AuthService(
        sf, rules, clock, idle_minutes=int(cfg["SESSION_IDLE_MINUTES"]), max_days=int(cfg["SESSION_MAX_DAYS"]),
        max_failures=int(cfg["LOGIN_MAX_FAILURES"]), lock_minutes=int(cfg["LOGIN_LOCK_MINUTES"]),
        hash_method=cfg["PASSWORD_HASH_METHOD"])
    app.extensions["directory"] = Directory(sf, rules, clock, availability=app.extensions["availability"])
    app.extensions["events"] = EventQueue(sf, rules, clock, max_attempts=int(cfg["EVENT_MAX_ATTEMPTS"]),
                                          backoff_seconds=int(cfg["EVENT_RETRY_BACKOFF_SECONDS"]))

    from .api import register_routes
    from .cli import register_cli
    register_routes(app)
    register_cli(app)
    return app
