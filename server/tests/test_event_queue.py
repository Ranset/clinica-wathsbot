"""Cola de eventos: reclamo con plazo, reintentos con espera, intentos agotados, privacidad y concurrencia.
Usa un reloj falso (`Clock`) para los plazos."""
import threading

import pytest
from sqlalchemy import select

from app.models import AttentionCase, WebhookEvent
from helpers import BOT_HEADERS, Clock, assert_schema, zernio_message


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def qapp(make_app, clock):
    return make_app(clock=clock)


@pytest.fixture
def q(qapp):
    return qapp.extensions["events"]


def fill(q, n, prefix="e"):
    for i in range(n):
        assert q.enqueue(zernio_message(f"{prefix}{i}", phone=f"52199911100{i:02d}", conv=f"c{i}", text=f"mensaje {i}"))


def ids(events):
    return [e["zernioEventId"] for e in events]


def row(db, zernio_id):
    with db() as s:
        return s.scalars(select(WebhookEvent).where(WebhookEvent.zernio_event_id == zernio_id)).one()


def cases(db):
    with db() as s:
        return list(s.scalars(select(AttentionCase).order_by(AttentionCase.id)))


# ------------------------------------------------------------------ reclamo
def test_claim_entrega_en_orden_de_llegada_y_respeta_el_limite(q):
    fill(q, 5)
    assert ids(q.claim(limit=2)) == ["e0", "e1"]
    assert ids(q.claim(limit=10)) == ["e2", "e3", "e4"]          # los reclamados no se vuelven a ofrecer
    assert q.claim() == []


def test_claim_cumple_el_contrato(q):
    fill(q, 1)
    (e,) = q.claim()
    assert_schema("BotEvent", e)
    assert e["attempts"] == 1 and e["payload"]["message"]["text"] == "mensaje 0" and e["receivedAtUtc"].endswith("Z")


def test_un_evento_reclamado_vuelve_a_ofrecerse_al_vencer_el_plazo(q, clock):
    fill(q, 1)
    assert len(q.claim(lease_seconds=60)) == 1
    clock.advance(seconds=59)
    assert q.claim() == []                                       # aun dentro del plazo
    clock.advance(seconds=2)
    (e,) = q.claim(lease_seconds=60)                             # el bot murio: se reofrece
    assert e["zernioEventId"] == "e0" and e["attempts"] == 2


def test_plazo_vencido_con_intentos_agotados_pasa_a_fallido_y_avisa(make_app, clock, db):
    q = make_app(clock=clock, EVENT_MAX_ATTEMPTS=2).extensions["events"]
    fill(q, 1)
    for _ in range(2):                                           # 2 intentos, ambos sin respuesta del bot
        assert len(q.claim(lease_seconds=60)) == 1
        clock.advance(seconds=61)
    assert q.claim() == []                                       # no se ofrece una tercera vez
    r = row(db, "e0")
    assert r.status == "failed" and "2 intentos" in r.last_error
    (caso,) = cases(db)
    assert (caso.kind, caso.status, caso.conversation_id, caso.phone, caso.event_id) == (
        "event_failed", "open", "c0", "5219991110000", r.id)


# ------------------------------------------------------------------ ack
@pytest.mark.parametrize("outcome,estado", [("replied", "done"), ("skipped_bot_inactive", "skipped"),
                                            ("skipped_ignored", "skipped")])
def test_ack_cierra_el_evento_y_borra_el_texto_del_paciente(q, db, outcome, estado):
    fill(q, 1)
    (e,) = q.claim()
    assert q.ack(e["id"], outcome) is True
    r = row(db, "e0")
    assert (r.status, r.outcome, r.claimed_until) == (estado, outcome, None) and r.processed_at
    # privacidad: no queda el texto ni el nombre; solo lo necesario para reconocer/contactar
    assert r.payload == {"id": "e0", "event": "message.received", "timestamp": "2026-11-12T15:00:00.000Z", "redacted": True,
                         "message": {"conversationId": "c0", "platform": "whatsapp", "direction": "incoming",
                                     "sender": {"id": "52199911100" + "00"}},
                         "account": {"accountId": "acc-1"}}
    assert "mensaje 0" not in str(r.payload) and "Paciente Prueba" not in str(r.payload)
    assert q.claim() == []


def test_ack_es_idempotente_y_no_resucita_eventos(q, db):
    fill(q, 1)
    (e,) = q.claim()
    assert q.ack(e["id"], "replied") and q.ack(e["id"], "replied")            # el ack se repitio: sigue cerrado
    assert q.ack(e["id"], "skipped_ignored") and row(db, "e0").outcome == "replied"   # no cambia lo ya cerrado
    assert q.fail(e["id"], "tarde", True) and row(db, "e0").status == "done"   # un fail tardio no lo reabre
    assert q.ack("999999", "replied") is False and q.ack("abc", "replied") is False
    assert cases(db) == []


# ------------------------------------------------------------------ fail y reintentos
def test_fail_con_reintento_espera_mas_cada_vez(q, clock, db):
    fill(q, 1)
    (e,) = q.claim()
    assert q.fail(e["id"], "el modelo no respondio", True)
    r = row(db, "e0")
    assert (r.status, r.last_error) == ("pending", "el modelo no respondio")
    assert q.claim() == []                                       # espera 30 s * intento 1
    clock.advance(seconds=29)
    assert q.claim() == []
    clock.advance(seconds=1)
    (e,) = q.claim()
    assert e["attempts"] == 2
    q.fail(e["id"], "otra vez", True)
    clock.advance(seconds=59)
    assert q.claim() == []                                       # ahora 30 s * intento 2 = 60 s
    clock.advance(seconds=1)
    assert ids(q.claim()) == ["e0"]


def test_intentos_agotados_pasan_a_fallido_con_caso_de_atencion(make_app, clock, db):
    q = make_app(clock=clock, EVENT_MAX_ATTEMPTS=2).extensions["events"]
    fill(q, 1)
    (e,) = q.claim()
    q.fail(e["id"], "falla 1", True)
    clock.advance(seconds=30)
    (e,) = q.claim()
    q.fail(e["id"], "falla 2", True)                             # ya van 2 intentos: no hay un tercero
    r = row(db, "e0")
    assert r.status == "failed" and r.last_error == "falla 2" and r.processed_at
    clock.advance(hours=1)
    assert q.claim() == []
    (caso,) = cases(db)
    assert (caso.kind, caso.reason, caso.detail, caso.conversation_id, caso.phone) == (
        "event_failed", "mensaje_sin_atender", "falla 2", "c0", "5219991110000")
    assert "mensaje 0" not in str(r.payload) and "mensaje 0" not in str(caso.detail)    # sin el texto del paciente


def test_fail_sin_reintento_falla_de_inmediato(q, db):
    fill(q, 1)
    (e,) = q.claim()
    assert q.fail(e["id"], "contenido no soportado", False)
    assert row(db, "e0").status == "failed" and len(cases(db)) == 1
    assert q.fail(e["id"], "otra vez", False) and len(cases(db)) == 1       # repetirlo no duplica el aviso
    assert q.fail("999999", "x", True) is False


def test_fail_recorta_el_motivo(q, db):
    fill(q, 1)
    (e,) = q.claim()
    q.fail(e["id"], "x" * 900, True)
    assert len(row(db, "e0").last_error) == 500


# ------------------------------------------------------------------ traspaso a una persona
def test_handoff_registra_un_caso_y_no_lo_duplica(q, db):
    a = q.handoff("conv-1", "pidio_persona", "5219981112222", "quiere hablar con alguien")
    assert q.handoff("conv-1", "otro", None, None) == a                     # misma conversacion abierta: el mismo caso
    b = q.handoff("conv-2", "modelo_fallo")
    assert b != a
    primero, segundo = cases(db)
    assert (primero.kind, primero.status, primero.reason, primero.phone, primero.detail) == (
        "handoff", "open", "pidio_persona", "5219981112222", "quiere hablar con alguien")
    assert (segundo.conversation_id, segundo.phone, segundo.detail) == ("conv-2", None, None)


# ------------------------------------------------------------------ concurrencia
def test_reclamos_simultaneos_no_entregan_un_evento_dos_veces(q):
    fill(q, 12)
    got, lock = [], threading.Lock()

    def worker():
        while True:
            lote = q.claim(limit=2)
            if not lote:
                return
            with lock:
                got.extend(lote)
    th = [threading.Thread(target=worker) for _ in range(6)]
    [t.start() for t in th]
    [t.join(timeout=120) for t in th]
    assert sorted(ids(got)) == sorted(f"e{i}" for i in range(12))            # ni uno perdido ni uno repetido
    assert all(e["attempts"] == 1 for e in got)


# ------------------------------------------------------------------ por HTTP (lo que ve el bot)
def post(client, path, body=None):
    return client.post(path, json=body, headers=BOT_HEADERS)


def test_claim_ack_fail_por_http(client, db):
    ev = zernio_message("evt-1")
    from helpers import post_webhook
    post_webhook(client, ev)
    r = post(client, "/api/bot/events/claim")                                # sin cuerpo: valores por defecto
    (e,) = r.get_json()["events"]
    assert r.status_code == 200 and e["attempts"] == 1
    assert post(client, "/api/bot/events/claim", {"limit": 5}).get_json() == {"events": []}
    r = post(client, f"/api/bot/events/{e['id']}/ack", {"outcome": "replied"})
    assert r.status_code == 204 and r.data == b""
    assert row(db, "evt-1").status == "done"
    assert post(client, "/api/bot/events/999999/ack", {"outcome": "replied"}).status_code == 404
    assert post(client, "/api/bot/events/999999/fail", {"reason": "x"}).status_code == 404
    assert post(client, "/api/bot/events/abc/ack", {"outcome": "replied"}).get_json()["error"] == "no_encontrado"


@pytest.mark.parametrize("body", [{"limit": 0}, {"limit": 21}, {"limit": "5"}, {"limit": True}, {"limit": 2.5},
                                  {"leaseSeconds": 9}, {"leaseSeconds": 601}, {"leaseSeconds": None}])
def test_claim_valida_sus_limites(client, body):
    r = post(client, "/api/bot/events/claim", body)
    assert r.status_code == 422 and r.get_json()["error"] == "validacion", body


def test_claim_con_cuerpo_que_no_es_json_es_422(client):
    r = client.post("/api/bot/events/claim", data="esto no es json", headers=BOT_HEADERS)
    assert r.status_code == 422


def test_ack_y_fail_validan_el_cuerpo(client, q):
    for body in ({}, {"outcome": "hecho"}, {"outcome": None}, {"outcome": ["replied"]}):
        assert post(client, "/api/bot/events/1/ack", body).status_code == 422, body
    for body in ({}, {"reason": 5}, {"reason": "x", "retry": "si"}, {"reason": "x", "retry": 1}):
        assert post(client, "/api/bot/events/1/fail", body).status_code == 422, body


def test_handoff_por_http(client, db):
    r = post(client, "/api/bot/handoffs", {"conversationId": "conv-1", "reason": "pidio_persona", "telefono": "5219981112222",
                                           "detail": "pidio hablar con una persona"})
    assert r.status_code == 201 and r.get_json()["id"].isdigit()
    again = post(client, "/api/bot/handoffs", {"conversationId": "conv-1", "reason": "otro"})
    assert again.status_code == 201 and again.get_json() == r.get_json()
    for body in ({}, {"conversationId": "c"}, {"conversationId": "", "reason": "otro"}, {"conversationId": "c", "reason": "inventado"},
                 {"conversationId": "c", "reason": "otro", "telefono": "abc"}, {"conversationId": 5, "reason": "otro"},
                 {"conversationId": "c", "reason": "otro", "detail": 5}):
        assert post(client, "/api/bot/handoffs", body).status_code == 422, body
    assert len(cases(db)) == 1
