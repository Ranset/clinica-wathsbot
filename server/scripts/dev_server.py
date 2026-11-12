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
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
PROXY_HEADERS = ("Cf-Connecting-Ip", "Cf-Ray", "X-Forwarded-Host", "Forwarded")  # los pone un tunel/proxy inverso


def install_remote_guard(app, bot_open: bool) -> None:
    """Defensa para cuando un tunel (cloudflared, ngrok...) expone ESTE servidor a internet: todo lo que no llegue por
    127.0.0.1/localhost recibe 404, salvo `/api/bot/*` si `bot_open` (solo cuando el usuario fijo su propio BOT_TOKEN: el de
    desarrollo es publico). Asi el login con las claves de desarrollo y la web de administracion NO quedan alcanzables desde fuera.
    Una peticion cuenta como externa si su `Host` no es local O trae cabeceras de proxy/tunel."""
    from urllib.parse import urlsplit
    from flask import jsonify, request

    @app.before_request
    def _solo_bot_desde_fuera():
        host = (urlsplit("//" + (request.host or "")).hostname or "").lower()
        external = host not in LOCAL_HOSTS or any(h in request.headers for h in PROXY_HEADERS)
        if external and not (bot_open and request.path.startswith("/api/bot/")):
            return jsonify(error="no_encontrado"), 404
        return None


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
    # Al arrancar se aplican las migraciones pendientes de la base de DESARROLLO (idempotente; conserva sus datos): asi una
    # columna nueva no obliga a borrarla con `dev_seed.py --reset`. Solo aqui, porque este script solo toca dev.db.
    from app.migrate import upgrade
    upgrade(DEV_URL)
    os.environ.setdefault("AUTH_COOKIE_SECURE", "0")
    custom_token = bool(os.environ.get("BOT_TOKEN")) and os.environ["BOT_TOKEN"] != DEV_BOT_TOKEN
    os.environ.setdefault("BOT_TOKEN", DEV_BOT_TOKEN)
    os.environ.setdefault("ZERNIO_WEBHOOK_SECRET", DEV_WEBHOOK_SECRET)

    from app import create_app
    app = create_app()
    install_remote_guard(app, bot_open=custom_token)
    print("\n  Servidor de DESARROLLO en http://127.0.0.1:5000  (base: server/instance/dev.db)")
    if custom_token:
        print("  Token del bot: PERSONALIZADO (oculto). Si lo expones con un tunel, desde fuera SOLO se alcanza /api/bot/* "
              "(todo lo demas da 404).\n", flush=True)
    else:
        print(f"  Token del bot: {os.environ['BOT_TOKEN']}  |  secreto del webhook: {os.environ['ZERNIO_WEBHOOK_SECRET']}")
        print("  Con el token de desarrollo (publico) NADA de este servidor es alcanzable desde fuera: un tunel recibe 404 en todo.\n",
              flush=True)
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True, use_reloader=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
