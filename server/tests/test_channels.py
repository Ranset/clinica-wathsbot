"""Canales de mensajeria (WhatsApp, Messenger = `facebook`, Instagram): la identidad de quien escribe es (canal, id).

Cubre los criterios de aceptacion: compatibilidad con el cliente viejo (solo `telefono`), AISLAMIENTO total entre canales
(el mismo numero en dos canales son dos personas), validaciones 400, interruptor por canal, traspaso a una persona, cola de
eventos, migracion 0009 (sube y baja con datos), privacidad del doctor y concurrencia entre canales. Corren en SQLite (y en MySQL
si esta configurado: la migracion en su propio archivo SQLite).
"""
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta, timezone

import pytest
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from app.agenda import iso
from app.agenda.identity import Identity
from app.db import make_engine
from app.events import channel_of, routing
from app.migrate import downgrade, upgrade
from app.models import Appointment, AttentionCase, AuditLog, Setting
from app.settings import get_bot_settings, set_bot_active, set_bot_channels
from helpers import BOT_HEADERS, assert_schema, check_integrity, next_weekday, post_webhook, zernio_message

N = "529990000001"            # el MISMO numero, como telefono de WhatsApp y como id de Facebook / Instagram
FB_ID = "29894443490173495"   # un PSID de Messenger
IG_ID = "17841400000000000"   # un IGSID de Instagram
CONTACT = "9981234567"        # el telefono de contacto que da quien escribe por Messenger / Instagram
ALL = ("whatsapp", "facebook", "instagram")


# --------------------------------------------------------------------------- ayudas
def get(client, path, **params):
    return client.get(path, query_string=params, headers=BOT_HEADERS)


def post(client, path, body=None):
    return client.post(path, json=body if body is not None else {}, headers=BOT_HEADERS)


def who(canal, key):
    return {"telefono": key} if canal == "whatsapp" else {"canal": canal, "contacto_id": key}


def book(client, canal, key, when, nombre="Ana Lopez", esp="proctologia", **extra):
    body = {**who(canal, key), "nombre": nombre, "especialidad": esp, "inicio": iso(when)}
    if canal != "whatsapp":
        body["telefono_contacto"] = CONTACT
    body.update(extra)
    return post(client, "/api/bot/appointments", body)


def mine(client, canal, key):
    r = get(client, "/api/bot/appointments", **who(canal, key))
    assert r.status_code == 200, r.get_json()
    return r.get_json()["citas"]


def cancel(client, canal, key, cita_id):
    return post(client, f"/api/bot/appointments/{cita_id}/cancel", who(canal, key))


def reschedule(client, canal, key, cita_id, when):
    return post(client, f"/api/bot/appointments/{cita_id}/reschedule", {**who(canal, key), "inicio": iso(when)})


def utc_z(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def status(client):
    r = client.get("/api/bot/status", headers=BOT_HEADERS)
    assert r.status_code == 200
    assert_schema("BotSettings", r.get_json())
    return r.get_json()


# =========================================================================== 1. compatibilidad
def test_el_cliente_viejo_con_solo_telefono_sigue_igual(client, agenda):
    """Sin `canal` todo es WhatsApp, con los mismos campos y codigos de siempre (la cita solo gana `canal`)."""
    t = next_weekday(agenda, 0, 10)
    r = post(client, "/api/bot/appointments", {"telefono": N, "nombre": "Ana Lopez", "especialidad": "proctologia", "inicio": iso(t)})
    j = r.get_json()
    assert r.status_code == 201 and j["ok"] is True and j["canal"] == "whatsapp"
    assert set(j) == {"ok", "cita_id", "doctor", "especialidad", "consultorio", "inicio", "paciente", "canal"}
    assert_schema("BotBooked", j)
    citas = get(client, "/api/bot/appointments", telefono=N).get_json()["citas"]
    assert [c["cita_id"] for c in citas] == [j["cita_id"]] and citas[0]["canal"] == "whatsapp"
    # los errores de siempre de WhatsApp siguen siendo 422 (no 400)
    for body in ({"nombre": "Ana Lopez", "especialidad": "proctologia", "inicio": iso(t)},
                 {"telefono": "123", "nombre": "Ana Lopez", "especialidad": "proctologia", "inicio": iso(t)}):
        assert post(client, "/api/bot/appointments", body).status_code == 422
    assert get(client, "/api/bot/appointments").status_code == 422
    assert get(client, "/api/bot/appointments", telefono="abc").status_code == 422
    assert post(client, f"/api/bot/appointments/{j['cita_id']}/cancel", {}).status_code == 422
    assert post(client, "/api/bot/handoffs", {"conversationId": "c", "reason": "otro", "telefono": "abc"}).status_code == 422
    # `canal: whatsapp` explicito es lo mismo; `telefono_contacto` y `contacto_id` sueltos se ignoran en WhatsApp
    t2 = next_weekday(agenda, 1, 10)
    r = post(client, "/api/bot/appointments", {"telefono": N, "canal": "whatsapp", "contacto_id": "ignorado-1", "telefono_contacto": "1112223334",
                                               "nombre": "Ana Lopez", "especialidad": "proctologia", "inicio": iso(t2)})
    assert r.status_code == 201
    with client.application.extensions["db"].session_factory() as s:
        a = s.get(Appointment, int(r.get_json()["cita_id"]))
        assert (a.channel, a.phone, a.contact_id) == ("whatsapp", N, None)


# =========================================================================== 2. aislamiento
def test_el_mismo_numero_en_dos_canales_son_dos_personas(client, agenda):
    t_wa, t_fb, t_ig = next_weekday(agenda, 0, 10), next_weekday(agenda, 1, 10), next_weekday(agenda, 2, 10)
    ids = {}
    for canal, t in (("whatsapp", t_wa), ("facebook", t_fb), ("instagram", t_ig)):
        r = book(client, canal, N, t)
        assert r.status_code == 201, r.get_json()
        assert r.get_json()["canal"] == canal
        ids[canal] = r.get_json()["cita_id"]

    for canal in ALL:                                     # cada identidad ve SOLO la suya
        assert [c["cita_id"] for c in mine(client, canal, N)] == [ids[canal]]
        assert mine(client, canal, N)[0]["canal"] == canal

    t_new = next_weekday(agenda, 3, 11)
    for canal in ALL:
        for otro in (c for c in ALL if c != canal):       # la cruzada: 404, sin distinguir "no existe" de "es de otro"
            r = cancel(client, canal, N, ids[otro])
            assert r.status_code == 404 and r.get_json()["error"] == "cita_no_encontrada", (canal, otro)
            r = reschedule(client, canal, N, ids[otro], t_new)
            assert r.status_code == 404 and r.get_json()["error"] == "cita_no_encontrada", (canal, otro)
    for canal in ALL:                                     # y no se movio ni se cancelo nada
        assert [c["cita_id"] for c in mine(client, canal, N)] == [ids[canal]]

    # la propia SI se puede mover y cancelar (en cada canal)
    moved = reschedule(client, "facebook", N, ids["facebook"], t_new)
    assert moved.status_code == 200 and moved.get_json()["inicio"] == iso(t_new)
    for canal in ALL:
        assert cancel(client, canal, N, ids[canal]).status_code == 200
        assert mine(client, canal, N) == []


def test_el_telefono_de_contacto_de_messenger_no_es_una_identidad_de_whatsapp(client, agenda):
    """Una cita de Facebook guarda el telefono de contacto en `phone`, pero ese numero NO la hace visible ni cancelable desde WhatsApp."""
    r = book(client, "facebook", FB_ID, next_weekday(agenda, 0, 10), telefono_contacto=N)
    cita = r.get_json()["cita_id"]
    assert r.status_code == 201
    assert mine(client, "whatsapp", N) == []
    assert cancel(client, "whatsapp", N, cita).status_code == 404
    assert reschedule(client, "whatsapp", N, cita, next_weekday(agenda, 1, 10)).status_code == 404
    assert [c["cita_id"] for c in mine(client, "facebook", FB_ID)] == [cita]


def test_una_cita_del_personal_con_telefono_es_de_whatsapp_y_no_de_los_otros_canales(client, agenda):
    a = agenda.create_booking(start=next_weekday(agenda, 0, 10), patient_name="Maria Perez", phone=N, doctor_id=1)
    assert [c["cita_id"] for c in mine(client, "whatsapp", N)] == [str(a.id)]
    assert mine(client, "facebook", N) == [] and mine(client, "instagram", N) == []


def test_la_identidad_vacia_o_de_un_canal_desconocido_no_es_duena_de_nada(db, agenda):
    agenda.create_booking(start=next_weekday(agenda, 0, 10), patient_name="Mostrador Sinfono", doctor_id=1)   # phone NULL
    assert not Identity("whatsapp", "") and not Identity("telegram", "12345") and Identity.coerce(None) == Identity("whatsapp", "")
    assert agenda.mine(Identity("whatsapp", "")) == [] and agenda.mine("") == [] and agenda.mine(Identity("facebook", "")) == []
    assert agenda.mine(N) == []     # un texto suelto es un telefono de WhatsApp (como siempre)


# =========================================================================== 3. validaciones
@pytest.mark.parametrize("etiqueta,body", [
    ("telefono con canal facebook", {"telefono": N, "canal": "facebook", "contacto_id": FB_ID}),
    ("telefono con canal instagram", {"telefono": N, "canal": "instagram", "contacto_id": IG_ID}),
    ("canal desconocido", {"canal": "telegram", "contacto_id": FB_ID}),
    ("canal que no es texto", {"canal": 5, "contacto_id": FB_ID}),
    ("facebook sin contacto_id", {"canal": "facebook"}),
    ("contacto_id con caracteres raros", {"canal": "facebook", "contacto_id": "ab c!d"}),
    ("contacto_id con inyeccion", {"canal": "facebook", "contacto_id": "1'; DROP TABLE appointments;--"}),
    ("contacto_id muy corto", {"canal": "instagram", "contacto_id": "1234"}),
    ("contacto_id muy largo", {"canal": "instagram", "contacto_id": "1" * 65}),
    ("contacto_id que no es texto", {"canal": "instagram", "contacto_id": 12345678}),
])
def test_identidad_invalida_es_400_en_todas_las_rutas_del_bot(client, agenda, etiqueta, body):
    t = next_weekday(agenda, 0, 10)
    full = {**body, "nombre": "Ana Lopez", "especialidad": "proctologia", "inicio": iso(t), "telefono_contacto": CONTACT}
    respuestas = [post(client, "/api/bot/appointments", full),
                  post(client, "/api/bot/appointments/1/cancel", body),
                  post(client, "/api/bot/appointments/1/reschedule", {**body, "inicio": iso(t)}),
                  post(client, "/api/bot/handoffs", {**body, "conversationId": "conv-1", "reason": "otro"})]
    if all(isinstance(v, str) for v in body.values()):          # en la URL todo viaja como texto: un numero ya no es "no texto"
        respuestas.append(get(client, "/api/bot/appointments", **body))
    for r in respuestas:
        j = r.get_json()
        assert r.status_code == 400 and j["error"] == "validacion", (etiqueta, r.status_code, j)
        assert "29894443490173495" not in str(j) and "DROP" not in str(j)      # el mensaje no repite el id recibido
    assert get(client, "/api/bot/appointments", **who("whatsapp", N)).get_json() == {"citas": []}


@pytest.mark.parametrize("telefono_contacto", [None, "", "123", "12345678901234567", "99812345ab", 9981234567, "998 123 4567"])
@pytest.mark.parametrize("canal,key", [("facebook", FB_ID), ("instagram", IG_ID)])
def test_agendar_fuera_de_whatsapp_exige_telefono_de_contacto(client, agenda, canal, key, telefono_contacto):
    body = {**who(canal, key), "nombre": "Ana Lopez", "especialidad": "proctologia", "inicio": iso(next_weekday(agenda, 0, 10))}
    if telefono_contacto is not None:
        body["telefono_contacto"] = telefono_contacto
    r = post(client, "/api/bot/appointments", body)
    assert r.status_code == 400 and r.get_json() == {
        "error": "validacion", "detail": "se requiere telefono_contacto (8 a 15 digitos) para este canal"}
    assert mine(client, canal, key) == []                  # no se creo nada


def test_el_telefono_de_contacto_se_guarda_y_en_whatsapp_se_ignora(client, agenda, db):
    fb = book(client, "facebook", FB_ID, next_weekday(agenda, 0, 10), telefono_contacto="9981112233").get_json()
    wa = book(client, "whatsapp", N, next_weekday(agenda, 1, 10), telefono_contacto="9990001111").get_json()
    with db() as s:
        a_fb, a_wa = s.get(Appointment, int(fb["cita_id"])), s.get(Appointment, int(wa["cita_id"]))
        assert (a_fb.channel, a_fb.contact_id, a_fb.phone, a_fb.source) == ("facebook", FB_ID, "9981112233", "ai")
        assert (a_wa.channel, a_wa.contact_id, a_wa.phone) == ("whatsapp", None, N)      # el contacto de WhatsApp NO sustituye al telefono


def test_las_reglas_de_agenda_son_las_mismas_en_todos_los_canales(client, agenda):
    t = next_weekday(agenda, 0, 10)
    assert book(client, "facebook", FB_ID, t).status_code == 201
    r = book(client, "instagram", IG_ID, t)                # el mismo doctor a la misma hora
    assert r.status_code == 409 and r.get_json()["error"] == "horario_ocupado"
    r = book(client, "instagram", IG_ID, next_weekday(agenda, 1, 10), nombre="Ana")
    assert r.status_code == 422 and r.get_json()["error"] == "falta_nombre_completo"
    r = book(client, "instagram", IG_ID, next_weekday(agenda, 1, 10), esp="cardiologia")
    assert r.status_code == 422 and r.get_json()["error"] == "especialidad_no_encontrada"


# =========================================================================== 4. interruptor por canal
def test_el_estado_inicial_del_interruptor_es_todo_apagado(client, login):
    j = status(client)
    assert j["channels"] == {"whatsapp": False, "facebook": False, "instagram": False} and j["active"] is False
    j = login("staff").get("/api/settings/bot").get_json()
    assert j["channels"] == {"whatsapp": False, "facebook": False, "instagram": False}
    assert set(j["channelUpdates"]) == set(ALL) and j["channelUpdates"]["facebook"]["updatedBy"] is None


def test_put_por_canal_cambia_solo_ese_canal(client, login):
    staff = login("staff")
    r = staff.put("/api/settings/bot", {"channel": "facebook", "active": True})
    assert r.status_code == 200
    j = r.get_json()
    assert j["channels"] == {"whatsapp": False, "facebook": True, "instagram": False} and j["active"] is False
    assert j["channelUpdates"]["facebook"]["updatedBy"] == "Recepcion Prueba" and j["channelUpdates"]["instagram"]["updatedBy"] is None
    assert status(client)["channels"] == j["channels"]                 # lo que lee el bot (token) es lo mismo

    j = staff.put("/api/settings/bot", {"channel": "instagram", "active": True}).get_json()
    assert j["channels"] == {"whatsapp": False, "facebook": True, "instagram": True}
    j = staff.put("/api/settings/bot", {"channel": "facebook", "active": False}).get_json()
    assert j["channels"] == {"whatsapp": False, "facebook": False, "instagram": True}


def test_la_forma_vieja_del_put_solo_toca_whatsapp(client, login):
    staff = login("staff")
    staff.put("/api/settings/bot", {"channels": {"facebook": True, "instagram": True}})
    j = staff.put("/api/settings/bot", {"active": True}).get_json()
    assert j["channels"] == {"whatsapp": True, "facebook": True, "instagram": True} and j["active"] is True
    assert j["updatedBy"] == "Recepcion Prueba"
    j = login("admin").put("/api/settings/bot", {"active": False}).get_json()          # apagar WhatsApp NO apaga los otros
    assert j["channels"] == {"whatsapp": False, "facebook": True, "instagram": True} and j["updatedBy"] == "Admin Prueba"


def test_put_de_varios_canales_cambia_solo_los_que_vienen(client, login):
    staff = login("staff")
    staff.put("/api/settings/bot", {"channels": {"whatsapp": True, "facebook": True}})
    j = staff.put("/api/settings/bot", {"channels": {"instagram": True, "facebook": False}}).get_json()
    assert j["channels"] == {"whatsapp": True, "facebook": False, "instagram": True}


def test_active_siempre_es_igual_a_whatsapp(client, login):
    staff = login("staff")
    for body in ({"channel": "whatsapp", "active": True}, {"channel": "facebook", "active": True}, {"active": False},
                 {"channels": {"whatsapp": True, "instagram": True}}, {"channel": "whatsapp", "active": False}):
        j = staff.put("/api/settings/bot", body).get_json()
        assert j["active"] is j["channels"]["whatsapp"]
        assert status(client)["active"] is status(client)["channels"]["whatsapp"] is j["active"]
        assert staff.get("/api/settings/bot").get_json() == j


@pytest.mark.parametrize("body", [
    {"channel": "telegram", "active": True}, {"channel": 5, "active": True}, {"channel": "facebook", "active": "si"},
    {"channel": "facebook", "active": 1}, {"channel": "facebook"}, {"channel": "facebook", "active": None},
    {"channels": {"telegram": True}}, {"channels": {"facebook": 1}}, {"channels": {"facebook": "si"}}, {"channels": {}},
    {"channels": "todos"}, {"channels": [True]}, {"channels": {"facebook": True}, "active": True},
    {"channels": {"facebook": True}, "channel": "facebook"},
])
def test_put_invalido_en_las_formas_nuevas_es_400_y_no_cambia_nada(client, login, body):
    staff = login("staff")
    r = staff.put("/api/settings/bot", body)
    assert r.status_code == 400 and r.get_json()["error"] == "validacion", r.get_json()
    assert status(client)["channels"] == {"whatsapp": False, "facebook": False, "instagram": False}


@pytest.mark.parametrize("body", [{}, {"active": "si"}, {"active": 1}, {"active": None}])
def test_put_invalido_en_la_forma_vieja_sigue_siendo_422(login, body):
    assert login("staff").put("/api/settings/bot", body).status_code == 422


def test_solo_el_personal_cambia_los_interruptores(client, login):
    for who_ in (None, "doctor"):
        c = client if who_ is None else login(who_)
        r = c.put("/api/settings/bot", json={"channel": "facebook", "active": True}) if who_ is None else c.put(
            "/api/settings/bot", {"channel": "facebook", "active": True})
        assert r.status_code in (401, 403), (who_, r.status_code)
    assert login("doctor").get("/api/settings/bot").status_code == 403
    assert status(client)["channels"]["facebook"] is False


def test_el_interruptor_deja_una_entrada_de_bitacora_por_canal(login, db):
    login("staff").put("/api/settings/bot", {"channels": {"whatsapp": True, "instagram": True}})
    login("staff").put("/api/settings/bot", {"active": False})                 # la forma vieja: la de siempre, sin tocar el formato
    with db() as s:
        acts = [(a.action, a.entity_id, a.data) for a in s.scalars(select(AuditLog).order_by(AuditLog.id)) if a.action == "bot.set_active"]
    assert acts == [("bot.set_active", "bot_active", {"active": True}),
                    ("bot.set_active", "bot_active.instagram", {"active": True, "channel": "instagram"}),
                    ("bot.set_active", "bot_active", {"active": False})]


def test_el_interruptor_falla_cerrado_si_falta_el_dato(db, client):
    with db() as s, s.begin():
        set_bot_channels(s, {"whatsapp": True, "facebook": True, "instagram": True})
    with db() as s, s.begin():
        for key in ("bot_active", "bot_active.facebook", "bot_active.instagram"):
            s.delete(s.get(Setting, key))
    j = status(client)
    assert j["channels"] == {"whatsapp": False, "facebook": False, "instagram": False} and j["active"] is False
    with db() as s, s.begin():                              # un valor raro tampoco enciende
        s.add(Setting(key="bot_active.facebook", value="true"))
        s.add(Setting(key="bot_active.instagram", value=None))
    assert status(client)["channels"] == {"whatsapp": False, "facebook": False, "instagram": False}


def test_set_bot_active_y_get_bot_settings_siguen_siendo_de_whatsapp(db):
    with db() as s, s.begin():
        st = set_bot_active(s, True)
        assert st.active is True and st.channels == {"whatsapp": True, "facebook": False, "instagram": False}
        assert set_bot_active(s, True, channel="instagram").channels["instagram"] is True
        with pytest.raises(ValueError):
            set_bot_channels(s, {"telegram": True})
        with pytest.raises(ValueError):
            set_bot_channels(s, {"facebook": "si"})
    with db() as s:
        assert get_bot_settings(s).active is True and get_bot_settings(s).channels["instagram"] is True


# =========================================================================== 5. traspaso a una persona
def test_traspaso_de_instagram_guarda_canal_y_contacto_sin_telefono(client, login, db):
    r = post(client, "/api/bot/handoffs", {"conversationId": "conv-ig-1", "reason": "pidio_persona", "canal": "instagram",
                                           "contacto_id": IG_ID, "detail": "quiere hablar con alguien"})
    assert r.status_code == 201
    with db() as s:
        c = s.scalars(select(AttentionCase)).one()
        assert (c.kind, c.channel, c.contact_id, c.phone, c.conversation_id) == ("handoff", "instagram", IG_ID, None, "conv-ig-1")
    items = login("staff").get("/api/attention").get_json()["items"]
    assert len(items) == 1
    assert_schema("AttentionItem", items[0])
    assert (items[0]["channel"], items[0]["contactId"], items[0]["phone"], items[0]["conversationId"]) == (
        "instagram", IG_ID, None, "conv-ig-1")


def test_traspaso_de_whatsapp_es_igual_que_antes(client, login, db):
    r = post(client, "/api/bot/handoffs", {"conversationId": "conv-wa", "reason": "pidio_persona", "telefono": N})
    assert r.status_code == 201
    r2 = post(client, "/api/bot/handoffs", {"conversationId": "conv-wa-2", "reason": "modelo_fallo"})      # sin telefono, como antes
    assert r2.status_code == 201
    items = {i["conversationId"]: i for i in login("staff").get("/api/attention").get_json()["items"]}
    assert (items["conv-wa"]["channel"], items["conv-wa"]["phone"], items["conv-wa"]["contactId"]) == ("whatsapp", N, None)
    assert (items["conv-wa-2"]["channel"], items["conv-wa-2"]["phone"]) == ("whatsapp", None)
    for i in items.values():
        assert_schema("AttentionItem", i)


def test_el_traspaso_de_otro_canal_exige_su_identidad(client):
    base = {"conversationId": "c1", "reason": "otro"}
    assert post(client, "/api/bot/handoffs", {**base, "canal": "facebook"}).status_code == 400          # sin contacto_id
    assert post(client, "/api/bot/handoffs", {**base, "canal": "facebook", "contacto_id": "x"}).status_code == 400
    assert post(client, "/api/bot/handoffs", {**base, "canal": "facebook", "contacto_id": FB_ID, "telefono": N}).status_code == 400
    assert post(client, "/api/bot/handoffs", {**base, "canal": "instagram", "contacto_id": IG_ID, "reason": "inventado"}).status_code == 422


def test_atencion_se_filtra_por_canal(client, login, app):
    ev = app.extensions["events"]
    ev.handoff("c-wa", "pidio_persona", N)
    ev.handoff("c-fb", "pidio_persona", channel="facebook", contact_id=FB_ID)
    ev.handoff("c-ig", "otro", channel="instagram", contact_id=IG_ID)
    staff = login("staff")
    names = lambda r: sorted(i["conversationId"] for i in r.get_json()["items"])
    assert names(staff.get("/api/attention")) == ["c-fb", "c-ig", "c-wa"]
    for canal, esperado in (("whatsapp", ["c-wa"]), ("facebook", ["c-fb"]), ("instagram", ["c-ig"])):
        r = staff.get("/api/attention?channel=" + canal)
        assert names(r) == esperado and r.get_json()["total"] == 1
    assert staff.get("/api/attention?channel=telegram").status_code == 422


# =========================================================================== 6. cola de eventos
def _msg(event_id, platform, sender, conv=None, **md):
    return zernio_message(event_id, message={"id": "m-" + event_id, "conversationId": conv or "conv-" + event_id,
                                             "platform": platform, "direction": "incoming", "text": "Hola, quiero una cita",
                                             "sender": {"id": sender, "name": "Paciente"}, "metadata": md})


def test_la_cola_acepta_messenger_e_instagram_y_rechaza_otras_plataformas(client, db):
    for ev in (_msg("e-fb", "facebook", FB_ID), _msg("e-ig", "instagram", IG_ID), _msg("e-wa", "whatsapp", "5219981112222")):
        assert post_webhook(client, ev).get_json() == {"ok": True, "queued": True}, ev["id"]
    for ev in (_msg("e-tg", "telegram", "99999999"), _msg("e-sb", "facebook", FB_ID, standby=True),
               zernio_message("e-out", message={"conversationId": "c", "platform": "facebook", "direction": "outgoing", "text": "x",
                                                "sender": {"id": FB_ID}}),
               zernio_message("e-test", test=True, message={"conversationId": "c", "platform": "instagram", "direction": "incoming",
                                                            "text": "x", "sender": {"id": IG_ID}})):
        assert post_webhook(client, ev).get_json() == {"ok": True, "queued": False}, ev["id"]
    r = post(client, "/api/bot/events/claim", {"limit": 10})
    got = {e["zernioEventId"]: e["payload"]["message"]["platform"] for e in r.get_json()["events"]}
    assert got == {"e-fb": "facebook", "e-ig": "instagram", "e-wa": "whatsapp"}


def test_routing_y_canal_del_evento():
    fb, ig, wa = _msg("a", "facebook", FB_ID, "cv-fb"), _msg("b", "instagram", IG_ID, "cv-ig"), _msg("c", "whatsapp", "5219981112222", "cv-wa")
    assert routing(fb) == ("cv-fb", None) and channel_of(fb) == ("facebook", FB_ID)         # el telefono solo se rellena en WhatsApp
    assert routing(ig) == ("cv-ig", None) and channel_of(ig) == ("instagram", IG_ID)
    assert routing(wa) == ("cv-wa", "5219981112222") and channel_of(wa) == ("whatsapp", None)
    assert channel_of(_msg("d", "facebook", "no es un id!"))[1] is None                    # un id raro no se guarda
    assert routing(_msg("e", "facebook", "5219981112222"))[1] is None                      # aunque parezca un telefono: es de Meta


@pytest.mark.parametrize("platform,sender", [("facebook", FB_ID), ("instagram", IG_ID)])
def test_un_fallo_definitivo_de_otro_canal_deja_un_caso_con_canal_y_contacto(client, db, platform, sender):
    post_webhook(client, _msg("e-1", platform, sender, "cv-1"))
    ev = post(client, "/api/bot/events/claim", {"limit": 1}).get_json()["events"][0]
    r = post(client, f"/api/bot/events/{ev['id']}/fail", {"reason": "el modelo no respondio", "retry": False})
    assert r.status_code == 204
    with db() as s:
        c = s.scalars(select(AttentionCase)).one()
        assert (c.kind, c.channel, c.contact_id, c.phone, c.conversation_id) == ("event_failed", platform, sender, None, "cv-1")
        from app.models import WebhookEvent
        e = s.scalars(select(WebhookEvent)).one()
        assert e.status == "failed" and e.payload["message"]["platform"] == platform and "text" not in e.payload["message"]
        assert "Hola, quiero una cita" not in str(e.payload)                               # el texto del paciente se borra


def test_el_interruptor_de_un_canal_apagado_cierra_el_evento_sin_contestar(client, login, db):
    post_webhook(client, _msg("e-fb", "facebook", FB_ID))
    ev = post(client, "/api/bot/events/claim", {"limit": 1}).get_json()["events"][0]
    assert status(client)["channels"]["facebook"] is False                # apagado: el bot lo cierra asi
    assert post(client, f"/api/bot/events/{ev['id']}/ack", {"outcome": "skipped_bot_inactive"}).status_code == 204
    with db() as s:
        from app.models import WebhookEvent
        e = s.scalars(select(WebhookEvent)).one()
        assert (e.status, e.outcome) == ("skipped", "skipped_bot_inactive")


# =========================================================================== 7. migracion 0009
def _insert_base(engine):
    with engine.begin() as c:
        c.execute(text("INSERT INTO rooms (name, position, active) VALUES ('Consultorio 1', 1, 1)"))
        c.execute(text("INSERT INTO doctors (code, name, specialty, aliases, active, uses_clinic_hours, created_at) "
                       "VALUES ('1001', 'Dr. Existente', 'Proctologia', '[]', 1, 1, '2026-11-10 10:00:00')"))
        c.execute(text("INSERT INTO appointments (kind, status, source, phone, patient_name, doctor_id, room_id, start_utc, "
                       "duration_minutes, created_at, updated_at) VALUES ('session', 'agendada', 'ai', :p, 'Ana Lopez', 1, 1, "
                       "'2030-01-07 15:00:00', 30, '2026-11-10 10:00:00', '2026-11-10 10:00:00')"), {"p": N})
        c.execute(text("INSERT INTO attention_cases (kind, status, conversation_id, phone, reason, created_at) "
                       "VALUES ('handoff', 'open', 'conv-vieja', :p, 'pidio_persona', '2026-11-10 10:00:00')"), {"p": N})


@pytest.mark.parametrize("previo", [True, False])
def test_migracion_0009_sube_y_baja_sin_perder_datos_ni_cambiar_el_bot(tmp_path, previo):
    url = "sqlite:///" + (tmp_path / "vieja.db").as_posix()
    upgrade(url, "0008")
    engine = create_engine(url)
    assert "channel" not in {c["name"] for c in inspect(engine).get_columns("appointments")}
    _insert_base(engine)
    with engine.begin() as c:
        c.execute(text("INSERT INTO settings (key, value, updated_at) VALUES ('bot_active', :v, '2026-11-10 10:00:00')"),
                  {"v": "true" if previo else "false"})
    engine.dispose()

    upgrade(url)
    engine = create_engine(url)
    insp = inspect(engine)
    cols = {c["name"]: c for c in insp.get_columns("appointments")}
    assert cols["channel"]["nullable"] is False and cols["contact_id"]["nullable"] is True
    assert {c["name"] for c in insp.get_columns("attention_cases")} >= {"channel", "contact_id"}
    assert any(i["name"] == "ix_appointments_channel_contact_id_start_utc" and i["column_names"] == ["channel", "contact_id", "start_utc"]
               for i in insp.get_indexes("appointments"))
    assert any(c["name"] == "ck_appointments_channel" for c in insp.get_check_constraints("appointments"))
    with engine.begin() as c:
        assert tuple(c.execute(text("SELECT channel, contact_id, phone, patient_name FROM appointments")).one()) == ("whatsapp", None, N, "Ana Lopez")
        assert tuple(c.execute(text("SELECT channel, contact_id, phone FROM attention_cases")).one()) == ("whatsapp", None, N)
    with pytest.raises(IntegrityError), engine.begin() as c:                            # el CHECK de canales vale
        c.execute(text("UPDATE appointments SET channel = 'telegram'"))
    engine.dispose()

    eng = make_engine(url)
    with DbSession(eng) as s:
        st = get_bot_settings(s)
        # WhatsApp conserva su valor previo; Messenger e Instagram nacen apagados; la migracion no enciende ni apaga nada
        assert st.channels == {"whatsapp": previo, "facebook": False, "instagram": False} and st.active is previo
        assert s.get(Setting, "bot_active").value is previo
    eng.dispose()

    # una cita de Facebook creada despues, y luego se baja: el telefono de contacto pasa a las notas y NO queda como identidad
    engine = create_engine(url)
    with engine.begin() as c:
        c.execute(text("INSERT INTO appointments (kind, status, source, channel, contact_id, phone, patient_name, doctor_id, room_id, "
                       "start_utc, duration_minutes, notes, created_at, updated_at) VALUES ('session', 'agendada', 'ai', 'facebook', :c, :p, "
                       "'Luis Gomez', 1, 1, '2030-01-08 15:00:00', 30, 'llamar por la tarde', '2026-11-10 10:00:00', '2026-11-10 10:00:00')"),
                  {"c": FB_ID, "p": CONTACT})
    engine.dispose()
    downgrade(url, "0008")
    engine = create_engine(url)
    insp = inspect(engine)
    assert not {"channel", "contact_id"} & {c["name"] for c in insp.get_columns("appointments")}
    assert not {"channel", "contact_id"} & {c["name"] for c in insp.get_columns("attention_cases")}
    assert not any(i["name"] == "ix_appointments_channel_contact_id_start_utc" for i in insp.get_indexes("appointments"))
    with engine.begin() as c:
        rows = {r[0]: (r[1], r[2]) for r in c.execute(text("SELECT patient_name, phone, notes FROM appointments"))}
        assert rows["Ana Lopez"] == (N, None)                                                 # la de WhatsApp, intacta
        assert rows["Luis Gomez"] == (None, f"llamar por la tarde · Contacto: {CONTACT}")     # la de Facebook no es de ningun WhatsApp
        assert c.execute(text("SELECT conversation_id FROM attention_cases")).scalar_one() == "conv-vieja"
        keys = {r[0] for r in c.execute(text("SELECT key FROM settings"))}
        assert keys == {"bot_active"}                                                         # los dos nuevos se van; el de WhatsApp queda
        assert c.execute(text("SELECT value FROM settings WHERE key = 'bot_active'")).scalar_one() == ("true" if previo else "false")
    engine.dispose()
    upgrade(url)                                                                              # y vuelve a subir sin problema
    eng = make_engine(url)
    with DbSession(eng) as s:
        assert get_bot_settings(s).channels == {"whatsapp": previo, "facebook": False, "instagram": False}
    eng.dispose()


def test_migracion_0009_en_limpio_coincide_con_los_modelos_y_siembra_los_interruptores(tmp_path):
    from test_schema import diff_with_models
    url = "sqlite:///" + (tmp_path / "limpia.db").as_posix()
    upgrade(url)
    assert diff_with_models(url) == []
    eng = make_engine(url)
    with DbSession(eng) as s:
        assert {k: v.value for k, v in ((r.key, r) for r in s.scalars(select(Setting)))} == {
            "bot_active.facebook": False, "bot_active.instagram": False}
        assert get_bot_settings(s).channels == {"whatsapp": False, "facebook": False, "instagram": False}   # sin fila de WhatsApp = apagado
    eng.dispose()


# =========================================================================== 8. el doctor NUNCA recibe telefono ni ids de Meta
def test_el_doctor_no_recibe_telefono_ni_id_de_meta_de_ningun_canal(client, login, agenda):
    secretos = [N, CONTACT, FB_ID, IG_ID, "facebook:", "instagram:", "contactPhone", "contactId", "contacto"]
    t = [next_weekday(agenda, 0, 10), next_weekday(agenda, 0, 11), next_weekday(agenda, 0, 12)]
    assert book(client, "whatsapp", N, t[0]).status_code == 201
    assert book(client, "facebook", FB_ID, t[1], telefono_contacto=CONTACT).status_code == 201
    assert book(client, "instagram", IG_ID, t[2], telefono_contacto=CONTACT).status_code == 201
    a = agenda.create_booking(start=next_weekday(agenda, 1, 10), patient_name="Maria Perez", phone=N, doctor_id=1)   # del personal

    rango = {"from": utc_z(t[0] - timedelta(days=1)), "to": utc_z(t[0] + timedelta(days=8))}
    doctor = login("doctor")                                  # Dr. Cervantes: el doctor 1, el de las cuatro citas
    r = doctor.get("/api/doctor/appointments", query_string=rango)
    assert r.status_code == 200
    items = r.get_json()["items"]
    assert len(items) == 4
    cuerpo = r.get_data(as_text=True)
    for s in secretos:
        assert s not in cuerpo, s
    for it in items:                                          # el paciente solo lleva el id de la cita y su nombre
        assert it["patient"]["id"] == it["id"] and "phone" not in it["patient"] and "contactPhone" not in it
    assert {it["channel"] for it in items} == set(ALL)        # el canal SI se ve: no identifica a nadie

    # nada mas deja entrar a un doctor a las citas del personal
    assert doctor.get("/api/appointments", query_string=rango).status_code == 403
    assert doctor.get(f"/api/appointments/{a.id}").status_code == 403

    # el personal SI ve el telefono de contacto y una identidad estable que NO es el telefono
    staff = login("staff")
    mias = {it["channel"] + (it["patient"]["name"] if it["patient"] else ""): it
            for it in staff.get("/api/appointments", query_string=rango).get_json()["items"]}
    fb = next(it for it in mias.values() if it["channel"] == "facebook")
    assert fb["patient"] == {"id": f"facebook:{FB_ID}", "name": "Ana Lopez", "phone": CONTACT} and fb["contactPhone"] == CONTACT
    ig = next(it for it in mias.values() if it["channel"] == "instagram")
    assert ig["patient"]["id"] == f"instagram:{IG_ID}" and ig["patient"]["phone"] == CONTACT
    wa = next(it for it in mias.values() if it["channel"] == "whatsapp" and it["patient"]["name"] == "Ana Lopez")
    assert wa["patient"] == {"id": N, "name": "Ana Lopez", "phone": N} and wa["contactPhone"] == N        # WhatsApp: el telefono, como siempre
    for it in mias.values():
        assert_schema("Booking", it)
    assert staff.get(f"/api/appointments/{fb['id']}").get_json() == fb


def test_la_ausencia_del_doctor_no_filtra_identidades_de_otros_canales(client, login, agenda):
    t = next_weekday(agenda, 0, 10)
    assert book(client, "facebook", FB_ID, t).status_code == 201
    doctor = login("doctor")
    r = doctor.post("/api/doctor/absences", {"startUtc": utc_z(t), "endUtc": utc_z(t + timedelta(hours=1))})
    assert r.status_code == 201
    cuerpo = r.get_data(as_text=True)
    assert FB_ID not in cuerpo and CONTACT not in cuerpo and "facebook" not in cuerpo
    casos = login("staff").get("/api/attention").get_data(as_text=True)
    assert FB_ID not in casos and CONTACT not in casos                       # el aviso al personal tampoco lleva ids de Meta


# =========================================================================== 9. concurrencia entre canales
def test_reservas_simultaneas_del_mismo_horario_desde_canales_distintos_una_sola_gana(app, agenda, db):
    t = next_weekday(agenda, 0, 10)
    personas = [("whatsapp", "5219981110001"), ("whatsapp", "5219981110002"), ("facebook", FB_ID), ("facebook", "29894443490173496"),
                ("instagram", IG_ID), ("instagram", "17841400000000001")]
    barrera = threading.Barrier(len(personas))

    def reservar(p):
        canal, key = p
        c = app.test_client()
        barrera.wait(timeout=30)
        return book(c, canal, key, t, nombre=f"Persona {canal}").status_code

    with ThreadPoolExecutor(len(personas)) as pool:
        codigos = sorted(pool.map(reservar, personas))
    assert codigos == [201, 409, 409, 409, 409, 409]            # un doctor no puede estar en dos citas a la vez
    with db() as s:
        citas = list(s.scalars(select(Appointment).where(Appointment.kind == "session")))
    assert len(citas) == 1
    check_integrity(db)
    ganador = (citas[0].channel, citas[0].phone if citas[0].channel == "whatsapp" else citas[0].contact_id)
    assert ganador in personas
    for canal, key in personas:                                 # y solo la persona ganadora la ve
        assert len(mine(app.test_client(), canal, key)) == (1 if (canal, key) == ganador else 0)
