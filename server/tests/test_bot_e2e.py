"""El codigo REAL del bot (`bot/api_client.py`, `run_action` y `agenda_prompt` de `bot/server.py`, `bot/poller.py`) contra el
servidor Flask real, por HTTP de verdad (un servidor werkzeug en un hilo). Es la prueba de integracion que le faltaba a
la F5: hasta ahora el cliente solo se habia probado contra una API falsa.

No usa el modelo (LLM) ni Zernio: `handle` es una funcion falsa. Se salta si no estan los archivos del bot (por ejemplo,
en la copia de pruebas que se sube a PythonAnywhere).
"""
import importlib
import importlib.util
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.agenda import iso
from app.models import AttentionCase, WebhookEvent
from app.settings import set_bot_active
from helpers import TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET, next_weekday, sign, zernio_message

BOT_DIR = Path(__file__).resolve().parents[2] / "bot"
pytestmark = pytest.mark.skipif(
    not all((BOT_DIR / f).exists() for f in ("api_client.py", "poller.py", "server.py", "system_prompt.md")),
    reason="no estan los archivos del bot (bot/api_client.py, poller.py, server.py)")

PHONE, OTHER = "5219981112222", "5219981113333"
MODS = ("api_client", "poller", "wathsbot_server")


@pytest.fixture
def stack(make_app):
    """App Flask (reintentos sin espera y 3 intentos) sirviendo en un puerto libre de 127.0.0.1."""
    from werkzeug.serving import make_server
    app = make_app(EVENT_RETRY_BACKOFF_SECONDS=0, EVENT_MAX_ATTEMPTS=3)
    srv = make_server("127.0.0.1", 0, app, threaded=True)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield SimpleNamespace(app=app, url=f"http://127.0.0.1:{srv.server_port}", agenda=app.extensions["agenda"],
                          sf=app.extensions["db"].session_factory, srv=srv)
    srv.shutdown()
    th.join(timeout=10)


@pytest.fixture
def bot(stack, monkeypatch):
    """Modulos del bot recien importados, apuntando al servidor de la prueba."""
    monkeypatch.syspath_prepend(str(BOT_DIR))
    for k, v in {"ZERNIO_API_KEY": "clave-falsa", "WATHSBOT_BACKEND": "api", "WATHSBOT_DRY_RUN": "1",
                 "CLINICA_API_URL": stack.url, "CLINICA_BOT_TOKEN": TEST_BOT_TOKEN, "CLINICA_API_TIMEOUT": "20"}.items():
        monkeypatch.setenv(k, v)
    for n in MODS:
        sys.modules.pop(n, None)
    api_client, poller = importlib.import_module("api_client"), importlib.import_module("poller")
    spec = importlib.util.spec_from_file_location("wathsbot_server", BOT_DIR / "server.py")
    srv = importlib.util.module_from_spec(spec)
    sys.modules["wathsbot_server"] = srv
    spec.loader.exec_module(srv)
    yield SimpleNamespace(api_client=api_client, poller=poller, server=srv, client=srv.get_agenda())
    for n in MODS:
        sys.modules.pop(n, None)


def webhook(stack, payload, secret=TEST_WEBHOOK_SECRET):
    raw = json.dumps(payload).encode()
    req = urllib.request.Request(stack.url + "/webhooks/zernio", data=raw, method="POST",
                                 headers={"Content-Type": "application/json", "X-Zernio-Signature": sign(raw, secret)})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def event_row(stack, zernio_id):
    with stack.sf() as s:
        return s.scalars(select(WebhookEvent).where(WebhookEvent.zernio_event_id == zernio_id)).one()


def cases(stack):
    with stack.sf() as s:
        return list(s.scalars(select(AttentionCase).order_by(AttentionCase.id)))


def wait_until(cond, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def processor(bot, handle):
    return bot.poller.Processor(bot.client, handle, bot.server.FALLBACK, log=lambda *a: None)


# ------------------------------------------------------------------ las acciones del modelo
def test_las_seis_acciones_del_modelo_funcionan_contra_el_servidor_real(bot, stack):
    run = bot.server.run_action
    t = next_weekday(stack.agenda, 1, 10)
    asked = t.strftime("%Y-%m-%dT%H:%M")
    assert run({"name": "horarios", "especialidad": "proctologia"}, PHONE)["horarios"]
    cerca = run({"name": "cercanos", "especialidad": "proctologia", "fecha_hora": asked}, PHONE)
    assert cerca["exacto"] is True and iso(t) in cerca["horarios"]

    r = run({"name": "agendar", "especialidad": "proctologia", "nombre": "Ana Lopez", "inicio": asked}, PHONE)
    assert r["ok"] and r["event_id"] == r["cita_id"] and r["inicio"] == iso(t) and r["paciente"] == "Ana Lopez"
    cid = r["event_id"]
    (mia,) = run({"name": "mis_citas"}, PHONE)["citas"]
    assert mia["event_id"] == cid and mia["doctor"] and mia["consultorio"]

    # otro paciente no puede ver, cancelar ni mover la cita
    assert run({"name": "mis_citas"}, OTHER) == {"citas": []}
    assert run({"name": "cancelar", "event_id": cid}, OTHER)["error"] == "cita_no_encontrada"
    assert run({"name": "reprogramar", "event_id": cid, "inicio": asked}, OTHER)["error"] == "cita_no_encontrada"

    mov = run({"name": "reprogramar", "event_id": cid, "inicio": (t + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M")}, PHONE)
    assert mov["ok"] and mov["reprogramada_desde"] == iso(t) and mov["event_id"] == cid
    can = run({"name": "cancelar", "event_id": cid}, PHONE)
    assert can["ok"] and can["cancelada"]["event_id"] == cid
    assert run({"name": "mis_citas"}, PHONE) == {"citas": []}


def test_los_errores_de_negocio_llegan_como_diccionario_igual_que_antes(bot, stack):
    run = bot.server.run_action
    t = next_weekday(stack.agenda, 1, 10).strftime("%Y-%m-%dT%H:%M")
    casos = [({"name": "agendar", "especialidad": "proctologia", "nombre": "Beto", "inicio": t}, "falta_nombre_completo"),
             ({"name": "agendar", "especialidad": "cardiologia", "nombre": "Beto Ruiz", "inicio": t}, "especialidad_no_encontrada"),
             ({"name": "horarios", "especialidad": "cardiologia"}, "especialidad_no_encontrada"),
             ({"name": "cancelar", "event_id": "999999"}, "cita_no_encontrada"),
             ({"name": "cancelar", "event_id": "abc"}, "cita_no_encontrada"),
             ({"name": "inventada"}, "accion_desconocida")]
    for accion, codigo in casos:
        assert run(accion, PHONE)["error"] == codigo, accion
    # horario ocupado: 2 consultorios llenos, un tercer paciente
    assert run({"name": "agendar", "especialidad": "proctologia", "nombre": "Ana Lopez", "inicio": t}, PHONE)["ok"]
    assert run({"name": "agendar", "especialidad": "ginecologia", "nombre": "Beto Ruiz", "inicio": t}, OTHER)["ok"]
    assert run({"name": "agendar", "especialidad": "reumatologia", "nombre": "Carla Mena", "inicio": t}, "5219981114444")["error"] == "horario_ocupado"


def test_el_prompt_se_arma_con_los_doctores_de_la_api(bot):
    p = bot.server.agenda_prompt()
    assert p.count("\n- ") >= 7 and "Cervantes" in p and "Reumatolog" in p and "Citas de 30 minutos" in p
    assert "al menos 60 minutos de antelacion" in p and "hasta 60 dias" in p


# ------------------------------------------------------------------ el cliente ante fallos reales
def test_credenciales_malas_o_servidor_caido_son_api_no_disponible_nunca_un_dict_de_negocio(bot, stack):
    Unavailable = bot.api_client.ApiUnavailable
    malo = bot.api_client.ApiAgenda(stack.url, "token-equivocado")
    with pytest.raises(Unavailable) as e:
        malo.bot_active()
    assert e.value.status == 401
    with pytest.raises(Unavailable):
        malo.free_slots("proctologia")
    assert bot.client.bot_active() is False                            # el bueno si entra: el seed lo deja apagado
    stack.srv.shutdown()                                               # cae el servidor...
    stack.srv.server_close()                                           # ...y su puerto rechaza conexiones, como una API caida de verdad
    # una lectura (se reintenta una vez) y una escritura (nunca se reintenta); en Windows cada intento a un puerto cerrado tarda ~2 s
    for call in (bot.client.bot_active, lambda: bot.client.claim()):
        with pytest.raises(Unavailable):
            call()


# ------------------------------------------------------------------ webhook -> cola -> bot -> ack
def test_mensaje_de_punta_a_punta_con_el_interruptor_apagado_y_encendido(bot, stack):
    llamadas = []
    proc = processor(bot, lambda ev: llamadas.append(ev["message"]["text"]) or "Hola, soy el asistente")

    assert webhook(stack, zernio_message("evt-1", text="Hola 😀 primera"))["queued"] is True
    (e,) = bot.client.claim()
    proc.process(e)                                                    # bot apagado: no contesta
    assert llamadas == [] and event_row(stack, "evt-1").outcome == "skipped_bot_inactive"

    with stack.sf() as s, s.begin():
        set_bot_active(s, True)
    assert webhook(stack, zernio_message("evt-2", text="Hola segunda", conv="conv-2"))["queued"] is True
    (e,) = bot.client.claim()
    proc.process(e)                                                    # encendido: contesta y cierra
    assert llamadas == ["Hola segunda"]
    fila = event_row(stack, "evt-2")
    assert (fila.status, fila.outcome) == ("done", "replied")
    assert "segunda" not in json.dumps(fila.payload) and fila.payload["redacted"] is True    # texto del paciente borrado
    assert bot.client.claim() == []
    assert webhook(stack, zernio_message("evt-2"))["duplicate"] is True


def test_el_bucle_del_poller_atiende_los_mensajes_que_llegan(bot, stack):
    with stack.sf() as s, s.begin():
        set_bot_active(s, True)
    vistos, lock = [], threading.Lock()

    def handle(ev):
        with lock:
            vistos.append(ev["message"]["conversationId"])
        return "ok"
    stop = threading.Event()
    th = threading.Thread(target=bot.poller.run, args=(bot.client, processor(bot, handle), stop, 3, 0.05, 60, lambda *a: None))
    th.start()
    try:
        for i in range(6):
            webhook(stack, zernio_message(f"evt-{i}", conv=f"conv-{i}", phone=f"52199911100{i:02d}"))
        assert wait_until(lambda: len(vistos) == 6), vistos
        assert wait_until(lambda: all(event_row(stack, f"evt-{i}").status == "done" for i in range(6)))
    finally:
        stop.set()
        th.join(timeout=30)
    assert sorted(vistos) == [f"conv-{i}" for i in range(6)]            # cada mensaje se atendio una sola vez


def test_si_el_modelo_falla_el_evento_vuelve_a_la_cola_y_al_final_avisa_a_una_persona(bot, stack):
    with stack.sf() as s, s.begin():
        set_bot_active(s, True)
    intentos = []

    def handle(ev):
        intentos.append(1)
        if len(intentos) < 2:
            raise RuntimeError("el modelo no respondio")
        return "ahora si"
    proc = processor(bot, handle)
    webhook(stack, zernio_message("evt-1"))
    proc.process(bot.client.claim()[0])                                # 1er intento: revienta -> fail(retry) -> pendiente
    assert event_row(stack, "evt-1").status == "pending" and "no respondio" in event_row(stack, "evt-1").last_error
    (e,) = bot.client.claim()
    assert e["attempts"] == 2
    proc.process(e)                                                    # 2o intento: funciona
    assert event_row(stack, "evt-1").status == "done" and cases(stack) == []

    webhook(stack, zernio_message("evt-2", conv="conv-9", phone=OTHER))
    siempre_falla = processor(bot, lambda ev: (_ for _ in ()).throw(RuntimeError("caido")))
    for _ in range(3):                                                 # EVENT_MAX_ATTEMPTS=3
        siempre_falla.process(bot.client.claim()[0])
    assert event_row(stack, "evt-2").status == "failed" and bot.client.claim() == []
    (caso,) = cases(stack)
    assert (caso.kind, caso.conversation_id, caso.phone, caso.status) == ("event_failed", "conv-9", OTHER, "open")


def test_el_mensaje_de_respaldo_del_bot_pasa_la_conversacion_a_una_persona(bot, stack):
    with stack.sf() as s, s.begin():
        set_bot_active(s, True)
    webhook(stack, zernio_message("evt-1", conv="conv-7", phone=PHONE))
    processor(bot, lambda ev: bot.server.FALLBACK).process(bot.client.claim()[0])
    assert event_row(stack, "evt-1").status == "done"
    (caso,) = cases(stack)
    assert (caso.kind, caso.conversation_id, caso.phone, caso.reason) == ("handoff", "conv-7", PHONE, "otro")
