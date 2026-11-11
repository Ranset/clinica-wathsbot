#!/usr/bin/env python3
"""Corre la suite del servidor contra un MySQL de pruebas SIN escribir la contrasena en la linea de comandos.

Pensado para la consola Bash de PythonAnywhere (venv activo, desde `server/`):

    python scripts/pa_run_tests.py                 # pregunta usuario, host y base (Enter = valor por defecto) y la contrasena (oculta)
    python scripts/pa_run_tests.py -k mysql        # lo que sigue se pasa tal cual a pytest (aqui: solo las variantes MySQL; ahorra CPU)

Por que existe: la contrasena no queda en el historial del shell, y el script la codifica bien para la URL (una clave con
`@`, `:`, `/`, `#` o `%` rompe una URL escrita a mano). Ademas comprueba la conexion ANTES de lanzar la suite (un error de
clave o de base cuesta un segundo, no la cuota de CPU de la cuenta).

SEGURIDAD: la suite VACIA la base (DROP de todas sus tablas). Por eso el script se niega si el nombre de la base no termina
en `_test` (p. ej. jamas `usuario$crud`), y si la base ya tiene tablas pide escribir SI.
"""
from __future__ import annotations

import getpass
import os
import sys
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL

SERVER_DIR = Path(__file__).resolve().parents[1]
PYTEST_OPTS = ["-q", "-rs", "--tb=short", "--maxfail=10", "-p", "no:cacheprovider"]  # --maxfail: si todo falla, no gastar CPU


def build_url(user: str, password: str, host: str, database: str) -> str:
    """URL de SQLAlchemy con usuario y clave codificados. `host` admite `host:puerto`."""
    port = None
    if ":" in host:
        host, p = host.rsplit(":", 1)
        port = int(p)
    url = URL.create("mysql+pymysql", username=user, password=password, host=host, port=port,
                     database=database, query={"charset": "utf8mb4"})
    return url.render_as_string(hide_password=False)


def probe(url: str) -> tuple[str, str, int, int]:
    """(version del servidor, base actual, numero de tablas existentes, limite de conexiones simultaneas del usuario; 0 = sin limite)."""
    engine = create_engine(url)
    try:
        with engine.connect() as c:
            version = c.execute(text("SELECT VERSION()")).scalar()
            db = c.execute(text("SELECT DATABASE()")).scalar()
            tables = len(c.execute(text("SHOW TABLES")).fetchall())
            maxconn = int(c.execute(text("SELECT @@max_user_connections")).scalar() or 0)
    finally:
        engine.dispose()
    return str(version), str(db), tables, maxconn


def main(argv=None, ask=input, ask_secret=getpass.getpass, run=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    default_user = os.environ.get("PA_MYSQL_USER") or getpass.getuser()
    user = ask(f"Usuario MySQL [{default_user}]: ").strip() or default_user
    default_host = f"{user}.mysql.pythonanywhere-services.com"
    host = ask(f"Host [{default_host}]: ").strip() or default_host
    default_db = f"{user}$clinica_test"
    database = ask(f"Base de pruebas [{default_db}]: ").strip() or default_db
    if not database.lower().endswith("_test"):
        print(f"ABORTADO: '{database}' no termina en '_test'. La suite VACIA la base; use una dedicada a pruebas.")
        return 2
    password = ask_secret("Contrasena de MySQL (no se muestra): ")

    url = build_url(user, password, host, database)
    try:
        version, db, tables, maxconn = probe(url)
    except Exception as e:  # noqa: BLE001 - se muestra el motivo, nunca la clave
        msg = f"{type(e).__name__}: {e}"
        print("No se pudo conectar -> " + (msg.replace(password, "***") if password else msg)[:500])
        return 1
    print(f"Conectado: MySQL {version}, base {db}, {tables} tabla(s) existente(s).")
    if maxconn and not os.environ.get("TEST_MYSQL_MAX_CONN"):
        os.environ["TEST_MYSQL_MAX_CONN"] = str(maxconn)  # lo lee tests/helpers.py: pool y procesos de concurrencia reducidos
    if os.environ.get("TEST_MYSQL_MAX_CONN"):
        print(f"Limite de conexiones simultaneas del usuario: {os.environ['TEST_MYSQL_MAX_CONN']} -> las pruebas de "
              "concurrencia usan pool y procesos reducidos (cierre otras consolas MySQL abiertas).")
    if tables and ask("La base tiene tablas y la suite las VACIARA. Escriba SI para continuar: ").strip().upper() != "SI":
        print("Cancelado; no se toco nada.")
        return 1

    os.environ["TEST_MYSQL_URL"] = url  # solo vive en este proceso
    os.chdir(SERVER_DIR)
    if run is None:
        import pytest
        run = pytest.main
    return int(run(PYTEST_OPTS + (argv or ["tests"])))  # sin argumentos: toda la suite


if __name__ == "__main__":
    sys.exit(main())
