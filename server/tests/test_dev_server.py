"""La defensa de `scripts/dev_server.py` cuando un tunel expone el servidor de desarrollo a internet."""
import importlib.util
from pathlib import Path

import pytest
from flask import Flask

SPEC = importlib.util.spec_from_file_location("dev_server", Path(__file__).resolve().parents[1] / "scripts" / "dev_server.py")
dev_server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev_server)


def make_client(bot_open):
    app = Flask(__name__)
    dev_server.install_remote_guard(app, bot_open)

    @app.get("/api/bot/status")
    def bot():
        return {"active": True}

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.post("/api/auth/login")
    def login():
        return {"ok": True}

    return app.test_client()


EXTERNO = [{"Host": "cmcash.dpdns.org"},                                   # el tunel conserva el Host publico
           {"Host": "127.0.0.1:5000", "Cf-Ray": "abc-MIA"},                 # tunel con Host reescrito a localhost
           {"Host": "localhost:5000", "Cf-Connecting-Ip": "203.0.113.9"},
           {"Host": "127.0.0.1:5000", "X-Forwarded-Host": "cmcash.dpdns.org"}]
LOCAL = [{"Host": "127.0.0.1:5000"}, {"Host": "localhost:5000"}, {"Host": "[::1]:5000"}]


@pytest.mark.parametrize("headers", LOCAL)
@pytest.mark.parametrize("bot_open", [False, True])
def test_desde_la_propia_maquina_todo_funciona(headers, bot_open):
    c = make_client(bot_open)
    assert c.get("/api/health", headers=headers).status_code == 200
    assert c.post("/api/auth/login", headers=headers).status_code == 200
    assert c.get("/api/bot/status", headers=headers).status_code == 200


@pytest.mark.parametrize("headers", EXTERNO)
def test_desde_un_tunel_sin_token_propio_no_se_alcanza_nada(headers):
    c = make_client(bot_open=False)
    for method, path in (("get", "/api/bot/status"), ("get", "/api/health"), ("post", "/api/auth/login"), ("get", "/")):
        r = getattr(c, method)(path, headers=headers)
        assert r.status_code == 404 and r.get_json() == {"error": "no_encontrado"}, (headers, path)


@pytest.mark.parametrize("headers", EXTERNO)
def test_desde_un_tunel_con_token_propio_solo_se_alcanza_la_api_del_bot(headers):
    c = make_client(bot_open=True)
    assert c.get("/api/bot/status", headers=headers).status_code == 200
    for method, path in (("get", "/api/health"), ("post", "/api/auth/login"), ("get", "/api/botx"), ("get", "/api/bot")):
        assert getattr(c, method)(path, headers=headers).status_code == 404, (headers, path)
