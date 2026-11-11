"""Motor y sesiones de SQLAlchemy 2 (sin Flask-SQLAlchemy) + utilidades de tiempo y errores de BD.

Convencion de tiempo: la BD guarda **UTC ingenuo** (DATETIME sin zona). Todo lo que sale de aqui hacia el
motor de agenda se convierte con `from_db`/`to_db`; la zona de la clinica solo se usa para mostrar y para
interpretar horarios de pared.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session, sessionmaker

UTC = timezone.utc

#: opcion de ejecucion que marca una transaccion como de escritura (SQLite: BEGIN IMMEDIATE; MySQL la ignora)
WRITE_OPTION = "clinica_write"


def utcnow() -> datetime:
    """Ahora, UTC ingenuo (como se guarda en la BD)."""
    return datetime.now(UTC).replace(tzinfo=None)


def iso_utc(dt: datetime) -> str:
    """UTC ingenuo de la BD -> `2026-11-12T18:30:00Z` (formato de los instantes de la API fuera del bot)."""
    return dt.replace(tzinfo=UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def to_db(dt: datetime) -> datetime:
    """Instante con zona -> UTC ingenuo para guardar/consultar. Sin zona: se toma como UTC ya ingenuo."""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(UTC).replace(tzinfo=None)


def from_db(dt: datetime) -> datetime:
    """UTC ingenuo de la BD -> instante con zona UTC."""
    return dt.replace(tzinfo=UTC)


def make_engine(url: str, *, echo: bool = False, pool_size: int | None = None) -> Engine:
    u = make_url(url)
    kw: dict = {"echo": echo}
    if u.get_backend_name() == "sqlite":
        if u.database and u.database != ":memory:":
            Path(u.database).parent.mkdir(parents=True, exist_ok=True)  # p. ej. server/instance/
        kw["connect_args"] = {"check_same_thread": False, "timeout": 30}
        if pool_size and u.database and u.database != ":memory:":  # archivo: QueuePool (en memoria no admite overflow)
            kw.update(pool_size=pool_size, max_overflow=pool_size)
    else:
        # PythonAnywhere (y otros) cierran las conexiones ociosas: renovar antes y comprobar al sacar del pool.
        kw.update(pool_pre_ping=True, pool_recycle=280)
        if pool_size:
            kw.update(pool_size=pool_size, max_overflow=pool_size)
    engine = create_engine(url, **kw)
    if u.get_backend_name() == "sqlite":
        _tune_sqlite(engine, in_memory=u.database in (None, "", ":memory:"))
    return engine


def _tune_sqlite(engine: Engine, *, in_memory: bool) -> None:
    """SQLite solo es para desarrollo y pruebas, pero debe portarse como una BD de verdad:
    claves foraneas, transacciones reales (BEGIN explicito: SAVEPOINT y ROLLBACK correctos) y escritores en serie
    (BEGIN IMMEDIATE, solo en transacciones de escritura: ver `WRITE_OPTION`) para que la carrera por el UNIQUE se
    resuelva sin 'database is locked'. Las lecturas usan BEGIN diferido y no bloquean a nadie (WAL)."""

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_conn, _rec):  # pragma: no cover - ejecutado por el pool
        dbapi_conn.isolation_level = None  # SQLAlchemy emite BEGIN/COMMIT, no sqlite3
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=30000")
        if not in_memory:
            cur.execute("PRAGMA journal_mode=WAL")
        cur.close()

    @event.listens_for(engine, "begin")
    def _on_begin(conn):
        immediate = conn.get_execution_options().get(WRITE_OPTION)
        conn.exec_driver_sql("BEGIN IMMEDIATE" if immediate else "BEGIN")


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)


# ---- clasificacion de errores (MySQL y SQLite) ----
def _orig_code(exc: DBAPIError) -> int | None:
    args = getattr(exc.orig, "args", ())
    return args[0] if args and isinstance(args[0], int) else None


def is_unique_violation(exc: IntegrityError) -> bool:
    """True si es una violacion de UNIQUE (no una clave foranea u otra restriccion)."""
    if _orig_code(exc) == 1062:  # MySQL/MariaDB: ER_DUP_ENTRY
        return True
    msg = str(exc.orig).lower()
    return "unique constraint failed" in msg or "duplicate entry" in msg


def is_retryable(exc: DBAPIError) -> bool:
    """La transaccion se puede repetir completa: interbloqueo (1213) o espera de bloqueo agotada (1205) en MySQL,
    'database is locked' en SQLite. Tambien 1305 ('SAVEPOINT ... does not exist'): cuando MySQL elige esta transaccion
    como victima de un interbloqueo la revierte ENTERA, y el ROLLBACK TO SAVEPOINT que SQLAlchemy intenta despues
    falla con 1305 y esconde el 1213 original."""
    if _orig_code(exc) in (1213, 1205, 1305):
        return True
    return "database is locked" in str(exc.orig).lower()
