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
  BOT_TOKEN            token de servicio del bot (`Authorization: Bearer ...` en /api/bot/*). Sin el, TODO /api/bot/* responde 401.
                       Generar uno: `flask --app wsgi gen-token`. Nunca en el repo ni en los logs.
  ZERNIO_WEBHOOK_SECRET secreto del webhook de Zernio (HMAC-SHA256 del cuerpo). Sin el, /webhooks/zernio responde 503
                       (Zernio reintenta los 5xx; un 4xx mandaria el evento a su cola de eventos muertos).
  SESSION_IDLE_MINUTES (480) / SESSION_MAX_DAYS (7)   caducidad de la sesion por inactividad / absoluta
  LOGIN_MAX_FAILURES (5) / LOGIN_LOCK_MINUTES (15)    bloqueo de un usuario tras contrasenas erroneas seguidas
  DOCTOR_APP_URL       donde vive la app del doctor (la PWA), p. ej. https://clinica.example.com/doctor/ : los enlaces para establecer la
                       contrasena de un doctor apuntan ahi. Sin ella, generar el enlace responde 503 `no_configurado`.
  AUTH_COOKIE_SECURE   1 (defecto): la cookie de sesion solo viaja por HTTPS. 0 solo para desarrollo local con http.
  PASSWORD_HASH_METHOD metodo de werkzeug para guardar contrasenas (vacio = scrypt; pbkdf2 si el Python no lo trae)
  EVENT_MAX_ATTEMPTS   intentos de la cola antes de marcar un evento como fallido (5)
  EVENT_RETRY_BACKOFF_SECONDS espera base entre reintentos; crece con el numero de intentos (30)
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
    "BOT_TOKEN": "",
    "DOCTOR_APP_URL": "",
    "ZERNIO_WEBHOOK_SECRET": "",
    "EVENT_MAX_ATTEMPTS": 5,
    "EVENT_RETRY_BACKOFF_SECONDS": 30,
    "MAX_CONTENT_LENGTH": 1_000_000,  # clave de Flask: los webhooks y las llamadas del bot son pequenos
    "SESSION_IDLE_MINUTES": 480,      # una sesion sin actividad caduca a las 8 h...
    "SESSION_MAX_DAYS": 7,            # ...y en cualquier caso a los 7 dias
    "LOGIN_MAX_FAILURES": 5,          # contrasenas erroneas seguidas antes de bloquear al usuario...
    "LOGIN_LOCK_MINUTES": 15,         # ...durante este tiempo
    "AUTH_COOKIE_SECURE": True,       # la cookie solo viaja por HTTPS (poner 0 solo en desarrollo local con http)
    "PASSWORD_HASH_METHOD": "",       # "" = scrypt (o pbkdf2 si el Python no lo trae); las pruebas usan uno barato
}

_ENV_INT = ("SLOT_MINUTES", "MIN_NOTICE_MINUTES", "HORIZON_DAYS", "MAX_DURATION_MINUTES", "POOL_SIZE",
            "EVENT_MAX_ATTEMPTS", "EVENT_RETRY_BACKOFF_SECONDS", "SESSION_IDLE_MINUTES", "SESSION_MAX_DAYS",
            "LOGIN_MAX_FAILURES", "LOGIN_LOCK_MINUTES")
_ENV_STR = ("TIMEZONE", "BOT_TOKEN", "ZERNIO_WEBHOOK_SECRET", "PASSWORD_HASH_METHOD", "DOCTOR_APP_URL")


def default_database_url() -> str:
    return "sqlite:///" + (INSTANCE_DIR / "clinica.db").as_posix()


def load_config(overrides: dict | None = None, environ: dict | None = None) -> dict:
    env = os.environ if environ is None else environ
    cfg = dict(DEFAULTS)
    if env.get("DATABASE_URL"):
        cfg["DATABASE_URL"] = env["DATABASE_URL"]
    for k in _ENV_STR:
        if env.get(k):
            cfg[k] = env[k].strip()
    for k in _ENV_INT:
        if env.get(k):
            cfg[k] = int(env[k])
    if env.get("SQL_ECHO"):
        cfg["SQL_ECHO"] = env["SQL_ECHO"] not in ("0", "false", "False", "")
    if env.get("AUTH_COOKIE_SECURE"):
        cfg["AUTH_COOKIE_SECURE"] = env["AUTH_COOKIE_SECURE"] not in ("0", "false", "False", "")
    cfg.update(overrides or {})
    if not cfg.get("DATABASE_URL"):
        cfg["DATABASE_URL"] = default_database_url()
    return cfg


def resolve_database_url(environ: dict | None = None) -> str:
    """URL de la BD con la misma regla que la app (la usa Alembic)."""
    return load_config(environ=environ)["DATABASE_URL"]
