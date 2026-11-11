"""Configuracion por entorno.

Orden de prioridad (de menor a mayor): valores por defecto < variables de entorno < el diccionario
que se pasa a `create_app(...)` (lo usan las pruebas).

Variables de entorno reconocidas:
  DATABASE_URL         p. ej. mysql+pymysql://usuario:clave@host/base?charset=utf8mb4
                       (sin ella: SQLite en server/instance/clinica.db, solo para desarrollo)
  TIMEZONE             zona de la clinica (America/Cancun, UTC-5 sin horario de verano)
  SLOT_MINUTES         duracion de una cita (30)
  MIN_NOTICE_MINUTES   antelacion minima para agendar (60)
  HORIZON_DAYS         maximo de dias a futuro (60)
  MAX_DURATION_MINUTES duracion maxima de una cita/bloqueo manual (1440)
  POOL_SIZE            conexiones permanentes del pool de MySQL (se permiten hasta el DOBLE con rafagas). Sin ella SQLAlchemy
                       usa 5 (+10). El MySQL GRATUITO de PythonAnywhere solo deja 3 conexiones simultaneas por usuario
                       (error 1226): ahi usar POOL_SIZE=1 (maximo 2) para dejar una a la consola/migraciones.
  SQL_ECHO             1 para ver el SQL
"""
from __future__ import annotations

import os
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
INSTANCE_DIR = SERVER_DIR / "instance"

DEFAULTS: dict = {
    "TIMEZONE": "America/Cancun",
    "SLOT_MINUTES": 30,
    "MIN_NOTICE_MINUTES": 60,
    "HORIZON_DAYS": 60,
    "MAX_DURATION_MINUTES": 24 * 60,
    "SQL_ECHO": False,
}

_ENV_INT = ("SLOT_MINUTES", "MIN_NOTICE_MINUTES", "HORIZON_DAYS", "MAX_DURATION_MINUTES", "POOL_SIZE")


def default_database_url() -> str:
    return "sqlite:///" + (INSTANCE_DIR / "clinica.db").as_posix()


def load_config(overrides: dict | None = None, environ: dict | None = None) -> dict:
    env = os.environ if environ is None else environ
    cfg = dict(DEFAULTS)
    if env.get("DATABASE_URL"):
        cfg["DATABASE_URL"] = env["DATABASE_URL"]
    if env.get("TIMEZONE"):
        cfg["TIMEZONE"] = env["TIMEZONE"]
    for k in _ENV_INT:
        if env.get(k):
            cfg[k] = int(env[k])
    if env.get("SQL_ECHO"):
        cfg["SQL_ECHO"] = env["SQL_ECHO"] not in ("0", "false", "False", "")
    cfg.update(overrides or {})
    if not cfg.get("DATABASE_URL"):
        cfg["DATABASE_URL"] = default_database_url()
    return cfg


def resolve_database_url(environ: dict | None = None) -> str:
    """URL de la BD con la misma regla que la app (la usa Alembic)."""
    return load_config(environ=environ)["DATABASE_URL"]
