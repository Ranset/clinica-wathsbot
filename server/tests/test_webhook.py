"""`POST /webhooks/zernio`: firma HMAC, idempotencia, filtrado y respuestas siempre JSON."""
import json
import threading

import pytest
from sqlalchemy import func, select

from app.models import WebhookEvent
from helpers import TEST_WEBHOOK_SECRET, assert_schema, post_webhook, sign, zernio_message


def rows(db):
    with db() as s:
        return list(s.scalars(select(WebhookEvent).order_by(WebhookEvent.id)))


def test_evento_valido_se_encola(client, db):
    ev = zernio_message("evt-1", text="Hola, quiero una cita de proctologia")
    r = post_webhook(client, ev)
    assert r.status_code == 200 and r.get_json() == {"ok": True, "queued": True}
    (row,) = rows(db)
    assert (row.zernio_event_id, row.event_type, row.status, row.attempts) == ("evt-1", "message.received", "pending", 0)
    assert row.payload["message"]["text"] == "Hola, quiero una cita de proctologia"      # el bot lo necesita completo


@pytest.mark.parametrize("header,mutar", [
    ("X-Zernio-Signature", lambda f: f),                       # lo normal
    ("X-Late-Signature", lambda f: f),                         # alias heredado
    ("X-Zernio-Signature", lambda f: f.upper()),               # mayusculas
    ("X-Zernio-Signature", lambda f: "sha256=" + f),           # con prefijo
], ids=["normal", "alias-heredado", "mayusculas", "prefijo"])
def test_formas_aceptadas_de_la_firma(client, db, header, mutar):
    raw = json.dumps(zernio_message("evt-1")).encode()
    r = post_webhook(client, raw=raw, header=header, sig=mutar(sign(raw)))
    assert r.status_code == 200 and r.get_json()["queued"] is True and len(rows(db)) == 1


def test_firma_invalida_o_ausente_es_401_y_no_encola(client, db):
    ev = zernio_message("evt-1")
    raw = json.dumps(ev).encode()
    casos = {
        "otro secreto": post_webhook(client, raw=raw, secret="otro-secreto"),
        "sin cabecera": post_webhook(client, raw=raw, secret=None),
        "vacia": post_webhook(client, raw=raw, sig=""),
        "basura": post_webhook(client, raw=raw, sig="no-es-un-hmac"),
        "cuerpo alterado": post_webhook(client, raw=raw + b" ", sig=sign(raw)),
        "firma de otro cuerpo": post_webhook(client, raw=raw, sig=sign(json.dumps(zernio_message("evt-2")).encode())),
        "firma truncada": post_webhook(client, raw=raw, sig=sign(raw)[:-2]),
        "firma con espacios internos": post_webhook(client, raw=raw, sig=sign(raw)[:10] + " " + sign(raw)[10:]),
    }
    for nombre, r in casos.items():
        assert r.status_code == 401 and r.get_json()["error"] == "firma_invalida", nombre
        assert_schema("ErrorBody", r.get_json())
    assert rows(db) == []


def test_sin_secreto_configurado_responde_503_reintentable(make_app):
    c = make_app(ZERNIO_WEBHOOK_SECRET="").test_client()
    raw = json.dumps(zernio_message("evt-1")).encode()
    for kw in ({"secret": None}, {"secret": ""}, {"sig": sign(raw, "")}):
        r = post_webhook(c, raw=raw, **kw)
        assert r.status_code == 503 and r.get_json()["error"] == "no_configurado"     # 5xx: Zernio reintenta


def test_entrega_duplicada_no_se_encola_dos_veces(client, db):
    ev = zernio_message("evt-1")
    assert post_webhook(client, ev).get_json() == {"ok": True, "queued": True}
    r = post_webhook(client, ev)
    assert r.status_code == 200 and r.get_json() == {"ok": True, "queued": False, "duplicate": True}
    assert len(rows(db)) == 1
    assert len(rows(db)) == 1 and post_webhook(client, zernio_message("evt-2")).get_json()["queued"] is True


def test_entregas_duplicadas_simultaneas_dejan_una_sola_fila(app, db):
    ev = zernio_message("evt-1")
    barrier, out = threading.Barrier(8), []

    def hit():
        c = app.test_client()
        barrier.wait(timeout=30)
        out.append(post_webhook(c, ev).get_json())
    th = [threading.Thread(target=hit) for _ in range(8)]
    [t.start() for t in th]
    [t.join(timeout=60) for t in th]
    assert len(out) == 8 and all(o["ok"] for o in out)
    assert sum(1 for o in out if o["queued"]) == 1 and sum(1 for o in out if o.get("duplicate")) == 7
    assert len(rows(db)) == 1


@pytest.mark.parametrize("nombre,evento", [
    ("webhook.test", {"id": "t1", "event": "webhook.test", "test": True, "message": "Prueba de Zernio"}),   # `message` es TEXTO
    ("prueba marcada", zernio_message("e1", test=True)),
    ("mensaje saliente", zernio_message("e2", message={"conversationId": "c", "platform": "whatsapp", "direction": "outgoing",
                                                      "text": "respuesta", "sender": {"id": "5219981112222"}})),
    ("standby", zernio_message("e3", message={"conversationId": "c", "platform": "whatsapp", "direction": "incoming",
                                              "text": "x", "sender": {"id": "5219981112222"}, "metadata": {"standby": True}})),
    ("otra plataforma", zernio_message("e4", message={"conversationId": "c", "platform": "telegram", "direction": "incoming",
                                                      "text": "x", "sender": {"id": "5219981112222"}})),
    ("otro evento", zernio_message("e5", event="message.sent")),
    ("message no es objeto", zernio_message("e6", message="texto suelto")),
    ("metadata no es objeto", zernio_message("e7", message={"conversationId": "c", "platform": "whatsapp",
                                                            "direction": "incoming", "text": "x", "sender": {"id": "5"},
                                                            "metadata": "raro"})),
], ids=lambda v: v if isinstance(v, str) else "")
def test_lo_que_no_es_un_mensaje_de_paciente_se_responde_200_y_se_descarta(client, db, nombre, evento):
    r = post_webhook(client, evento)
    if nombre == "metadata no es objeto":       # metadata rara pero mensaje real: SI se encola (no es standby)
        assert r.get_json() == {"ok": True, "queued": True}
        return
    assert r.status_code == 200 and r.get_json() == {"ok": True, "queued": False}, nombre
    assert rows(db) == []


def test_cuerpos_mal_formados_son_422_firmados(client, db):
    for raw in (b"no es json", b"[]", b"[1,2]", b'"texto"', b"{}", b'{"id": "x"}', b'{"event": "message.received"}',
                json.dumps({"id": "", "event": "message.received"}).encode(),
                json.dumps({"id": "x" * 129, "event": "message.received"}).encode(),
                json.dumps({"id": ["lista"], "event": "message.received"}).encode(),
                json.dumps({"id": "x", "event": 5}).encode()):
        r = post_webhook(client, raw=raw)
        assert r.status_code == 422 and r.get_json()["error"] == "validacion", raw
    assert rows(db) == []


def test_id_numerico_se_acepta_como_texto(client, db):
    assert post_webhook(client, zernio_message(12345)).get_json()["queued"] is True
    assert rows(db)[0].zernio_event_id == "12345"


def test_texto_con_emojis_y_acentos_se_guarda_tal_cual(client, db):
    texto = "Hola 😀, necesito cita con el doctor Peláez — ¿mañana?"
    assert post_webhook(client, zernio_message("evt-1", text=texto)).get_json()["queued"] is True
    assert rows(db)[0].payload["message"]["text"] == texto


def test_todas_las_respuestas_son_json(client, make_app):
    r = client.get("/webhooks/zernio")                          # metodo no permitido
    assert r.status_code == 405 and r.mimetype == "application/json" and "POST" in r.headers["Allow"]
    assert client.post("/webhooks/zernio", data=b"x").mimetype == "application/json"      # sin firma
    chico = make_app(MAX_CONTENT_LENGTH=100).test_client()
    r = post_webhook(chico, raw=json.dumps(zernio_message("evt-1", text="x" * 500)).encode())
    assert r.status_code == 413 and r.mimetype == "application/json"
    ok = post_webhook(client, zernio_message("evt-9"))
    assert ok.mimetype == "application/json" and ok.headers["Cache-Control"] == "no-store"


def test_el_secreto_y_el_cuerpo_no_aparecen_en_los_logs(client, caplog):
    caplog.set_level("DEBUG")
    post_webhook(client, zernio_message("evt-1", text="mi dolor es privado"), secret="otro")
    post_webhook(client, zernio_message("evt-2", text="mi dolor es privado"))
    log = "\n".join(r.getMessage() for r in caplog.records)
    assert TEST_WEBHOOK_SECRET not in log and "mi dolor es privado" not in log


def test_cuenta_de_eventos(client, db):
    for i in range(3):
        post_webhook(client, zernio_message(f"evt-{i}"))
    with db() as s:
        assert s.scalar(select(func.count()).select_from(WebhookEvent)) == 3
