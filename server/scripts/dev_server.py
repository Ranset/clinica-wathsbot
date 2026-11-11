#!/usr/bin/env python3
"""Servidor LOCAL de desarrollo (http://127.0.0.1:5000) sobre la base `server/instance/dev.db` (ver `dev_seed.py`).

Pone valores de DESARROLLO que el servidor real nunca debe usar: cookie sin `Secure` (el navegador no la manda por http), y un
token del bot y un secreto del webhook publicos. Solo escucha en 127.0.0.1 y se NIEGA a usar una base que no sea la SQLite de
desarrollo. En produccion NO se usa esto: ahi manda `wsgi.py` con las variables de entorno reales.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))
DEV_DB = SERVER_DIR / "instance" / "dev.db"
DEV_URL = "sqlite:///" + DEV_DB.as_posix()
DEV_BOT_TOKEN, DEV_WEBHOOK_SECRET = "token-de-desarrollo", "secreto-de-desarrollo"


def main() -> int:
    env_url = os.environ.get("DATABASE_URL")
    if env_url and env_url != DEV_URL:
        print("ABORTADO: DATABASE_URL apunta a otra base; este servidor solo es para server/instance/dev.db. "
              "Para otra base usa `flask --app wsgi run` con tus variables.")
        return 2
    if not DEV_DB.exists():
        print(f"No existe {DEV_DB}.\nCreala primero (una sola vez):  cd server && .venv/Scripts/python scripts/dev_seed.py")
        return 1
    os.environ["DATABASE_URL"] = DEV_URL
    os.environ.setdefault("AUTH_COOKIE_SECURE", "0")
    os.environ.setdefault("BOT_TOKEN", DEV_BOT_TOKEN)
    os.environ.setdefault("ZERNIO_WEBHOOK_SECRET", DEV_WEBHOOK_SECRET)

    from app import create_app
    app = create_app()
    print("\n  Servidor de DESARROLLO en http://127.0.0.1:5000  (base: server/instance/dev.db)")
    print(f"  Token del bot: {os.environ['BOT_TOKEN']}  |  secreto del webhook: {os.environ['ZERNIO_WEBHOOK_SECRET']}\n", flush=True)
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True, use_reloader=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
