"""Pruebas del modo DIRECTO del bot con la API de la clinica: Zernio -> `server.py` (WATHSBOT_BACKEND=api,
WATHSBOT_INGRESS=webhook) y de `clinic_info.py`. API falsa local; sin Zernio, sin modelo, sin Google.
Ejecutar: python test_bot_direct.py (solo libreria estandar).
"""
import hashlib, hmac, json, os, sys, threading, time, urllib.error, urllib.request
from contextlib import contextmanager
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ZERNIO_API_KEY", "x")
os.environ["WATHSBOT_BACKEND"] = "api"
os.environ.pop("WATHSBOT_INGRESS", None)

import clinic_info
import server
from api_client import ApiUnavailable
from test_api_client import FakeApi, ApiAgenda, TOKEN

tests = []


def test(f):
    tests.append(f)
    return f


H1 = [{"start": "09:00", "end": "18:00"}]
H2 = [{"start": "09:00", "end": "13:00"}]
WEEK = {"mon": H1, "tue": H1, "wed": H1, "thu": H1, "fri": H1, "sat": H2}
CONFIG = {"timezone": "America/Cancun", "slotMinutes": 30, "minNoticeMinutes": 60, "horizonDays": 60, "clinicHours": WEEK,
          "doctors": [
              {"name": "Dr. Cervantes Pelaez", "specialty": "Proctologia", "weeklyHours": WEEK, "usesClinicHours": True},
              {"name": "Dra. Geydi", "specialty": "Anestesiologia", "weeklyHours": {"tue": [{"start": "10:00", "end": "12:00"}]},
               "usesClinicHours": False}]}
PHONE = "529988908000"


# ------------------------------------------------------------------ clinic_info
@test
def resumen_de_horario():
    # los datos de la API vienen en 24 h; al paciente se le dicen en 12 h con AM/PM
    assert clinic_info.summarize_hours(WEEK) == "lunes a viernes 9:00 AM a 6:00 PM, sabados 9:00 AM a 1:00 PM"
    assert clinic_info.summarize_hours({"mon": H1, "wed": H1, "fri": H1}) == "lunes, miercoles y viernes 9:00 AM a 6:00 PM"
    assert clinic_info.summarize_hours({"mon": H1, "tue": H1}) == "lunes y martes 9:00 AM a 6:00 PM"
    assert clinic_info.summarize_hours({"sat": [{"start": "09:00", "end": "12:00"}, {"start": "15:00", "end": "18:30"}]}) \
        == "sabados 9:00 AM a 12:00 PM y 3:00 PM a 6:30 PM"
    # dias salteados con las mismas horas se juntan; el orden sigue al primer dia de cada grupo
    assert clinic_info.summarize_hours({"mon": H2, "tue": H1, "wed": H1, "thu": H2}) == \
        "lunes y jueves 9:00 AM a 1:00 PM, martes y miercoles 9:00 AM a 6:00 PM"
    assert clinic_info.summarize_hours({}) == "" and clinic_info.summarize_hours(None) == ""
    assert clinic_info.summarize_hours({"mon": []}) == ""


@test
def compose_system_pone_los_datos_vigentes_y_conserva_el_resto():
    out = clinic_info.compose_system(server.SYSTEM, CONFIG)
    assert "- Horario: lunes a viernes 9:00 AM a 6:00 PM, sabados 9:00 AM a 1:00 PM." in out
    assert "proctologia (Dr. Cervantes Pelaez), anestesiologia (Dra. Geydi)" in out
    assert "Dr. Molina" not in out and "reumatologia" not in out, "no deben quedar los doctores fijos del .md"
    assert "Dra. Geydi: martes 10:00 AM a 12:00 PM" in out, "el horario propio de un doctor debe aparecer"
    assert "ejemplo de prueba" not in out and "vigentes" in out
    # lo que no es dato de agenda se conserva
    assert "Av. Nichupte" in out and "$750" in out and "NO des diagnosticos" in out
    assert out.count("- Horario:") == 1 and out.count("- Especialidades y doctores:") == 1


@test
def compose_system_con_un_servidor_viejo_o_sin_doctores():
    sin_horario = {k: v for k, v in CONFIG.items() if k != "clinicHours"}
    out = clinic_info.compose_system(server.SYSTEM, sin_horario)
    assert "- Horario: lunes a viernes 9:00 AM a 6:00 PM, sabados 9:00 AM a 1:00 PM." in out  # el del .md, sin tocar
    assert "proctologia (Dr. Cervantes Pelaez)" in out
    assert clinic_info.compose_system("hola", None) == "hola"
    vacio = clinic_info.compose_system(server.SYSTEM, dict(CONFIG, doctors=[], clinicHours={}))
    assert "no hay doctores disponibles" in vacio and "no disponible por ahora" in vacio
    # si el .md no trae las lineas, se agregan
    assert "- Horario: lunes a viernes" in clinic_info.compose_system("# Wathsbot\n", CONFIG)


# ------------------------------------------------------------------ horas en 12 h (AM/PM) para el paciente
@test
def time12_pasa_de_24_h_a_12_h_con_meridiano():
    t = clinic_info.time12
    assert [t(0, 0), t(0, 30), t(9, 0), t(11, 59), t(12, 0), t(12, 30), t(13, 30), t(18, 0), t(23, 5)] == \
        ["12:00 AM", "12:30 AM", "9:00 AM", "11:59 AM", "12:00 PM", "12:30 PM", "1:30 PM", "6:00 PM", "11:05 PM"]
    assert t("09", "05") == "9:05 AM" and t(24, 0) == "12:00 AM"


@test
def to_12h_corrige_solo_las_horas_de_24_h_sin_ambiguedad():
    f = clinic_info.to_12h
    assert f("Tu cita es el jueves a las 16:30") == "Tu cita es el jueves a las 4:30 PM"
    assert f("Te veo a las 09:00 y a las 00:30") == "Te veo a las 9:00 AM y a las 12:30 AM"
    assert f("Atendemos de 9:00 a 18:00 hrs") == "Atendemos de 9:00 a 6:00 PM"
    assert f("A las 10:00 hrs") == "A las 10:00 AM" and f("a las 12:00 hrs.") == "a las 12:00 PM"
    assert f("a las 16:30 horas") == "a las 4:30 PM" and f("21:15hrs") == "9:15 PM"
    assert f("1) 13:30  2) 15:00  3) 17:30") == "1) 1:30 PM  2) 3:00 PM  3) 5:30 PM"


@test
def to_12h_no_toca_lo_que_ya_esta_bien_ni_lo_ambiguo_ni_las_fechas_iso():
    f = clinic_info.to_12h
    for ok in ["a las 10:00 AM", "a las 4:30 PM", "a las 4:30 p. m.", "a las 4:30 pm", "16:30 PM",
               "a las 10:00", "a las 9:30", "a las 12:00",               # sueltas: podrian ser ya de 12 h
               "2026-11-12T16:30", "2026-11-12T16:30-05:00", "10:30:15", "x16:30", "$750", "tel 55:55", "", "hola"]:
        assert f(ok) == ok, ok
    assert f(None) is None


@test
def el_prompt_manda_hablar_en_12_h_y_conserva_24_h_en_las_acciones():
    with entorno() as (a, c, enviados, prompts):
        server.answer([{"role": "user", "content": "hola"}], PHONE)
        p = prompts[0]
        assert "HORAS EN 12 H" in p and "10:00 AM" in p and "4:30 PM" in p and "NUNCA uses formato ISO ni de 24 h" in p
        assert "AAAA-MM-DDTHH:MM" in p and "hora_min" in p, "las acciones siguen en 24 h"
        import re
        assert re.search(r"hora local \d{1,2}:\d{2} (AM|PM) \(zona", p), "la hora actual del prompt va en 12 h"
        assert not re.search(r"hora local (0\d|1[3-9]|2[0-3]):", p)


@test
def una_hora_de_24_h_que_se_le_escapa_al_modelo_sale_en_12_h_hacia_el_paciente():
    with entorno() as (a, c, enviados, prompts):
        server.llm = lambda system, msgs: json.dumps({"reply": "Listo, tu cita queda el jueves a las 16:30.", "action": None})
        assert server.answer([{"role": "user", "content": "hola"}], PHONE) == "Listo, tu cita queda el jueves a las 4:30 PM."
        server.llm = lambda system, msgs: "Atendemos de 09:00 a 18:00 hrs"   # texto plano
        assert server.answer([{"role": "user", "content": "horario?"}], PHONE) == "Atendemos de 9:00 AM a 6:00 PM"


# ------------------------------------------------------------------ nucleo con la API
@contextmanager
def entorno(config=CONFIG, active=True):
    """API falsa + modelo y Zernio falsos. Entrega (api, cliente, enviados, prompts)."""
    a = FakeApi()
    c = ApiAgenda(a.url, TOKEN, timeout=2)
    a.on("GET", "/api/bot/config", (200, config))
    a.on("GET", "/api/bot/status", (200, {"active": active}))
    a.on("POST", "/api/bot/handoffs", (201, {"id": "1"}))
    enviados, prompts = [], []
    saved = (server._AGENDA, server.llm, server.zernio, server.history, server.DRY_RUN, server.SECRET)
    server._AGENDA, server.DRY_RUN = c, False
    server.zernio = lambda method, path, body=None: enviados.append((method, path, body)) or {}
    server.history = lambda conv, acc: []
    server.GREETED.clear(); server.SEEN.clear()

    def modelo(system, msgs):
        prompts.append(system)
        return json.dumps({"reply": "Hola, soy el asistente de la clinica.", "action": None})
    server.llm = modelo
    try:
        yield a, c, enviados, prompts
    finally:
        server._AGENDA, server.llm, server.zernio, server.history, server.DRY_RUN, server.SECRET = saved
        a.close()


def evento(text="hola", conv="c1", phone=PHONE, eid="e1"):
    return {"id": eid, "event": "message.received", "account": {"accountId": "acc1"},
            "message": {"id": "m" + eid, "platform": "whatsapp", "direction": "incoming", "conversationId": conv,
                        "text": text, "sender": {"id": phone}}}


def llamadas(a, method, path):
    return [x for x in a.calls if x.method == method and x.path == path]


@test
def el_prompt_lleva_doctores_y_horarios_de_la_api_una_sola_consulta_por_mensaje():
    with entorno() as (a, c, enviados, prompts):
        r = server.answer([{"role": "user", "content": "hola"}], PHONE)
        assert r == "Hola, soy el asistente de la clinica."
        p = prompts[0]
        assert "lunes a viernes 9:00 AM a 6:00 PM" in p and "Dra. Geydi" in p and "Dr. Molina" not in p
        assert "Anestesiologia: Dra. Geydi" in p, "la seccion de agenda tambien sale de la API"
        assert len(llamadas(a, "GET", "/api/bot/config")) == 1, "una sola consulta de configuracion por mensaje"


@test
def un_numero_no_valido_responde_sin_agenda_pero_con_los_datos_vigentes():
    with entorno() as (a, c, enviados, prompts):
        server.llm = lambda system, msgs: (prompts.append(system), "Con gusto, un momento.")[1]
        assert server.answer([{"role": "user", "content": "hola"}], "no-es-un-telefono") == "Con gusto, un momento."
        assert "AGENDA AUTOMATICA" not in prompts[0] and "Dra. Geydi" in prompts[0]


@test
def reply_for_interruptor_apagado_no_contesta_ni_llama_al_modelo():
    with entorno(active=False) as (a, c, enviados, prompts):
        assert server.reply_for([{"role": "user", "content": "hola"}], PHONE, "c1") is None
        assert prompts == [] and llamadas(a, "GET", "/api/bot/config") == []


@test
def reply_for_con_la_api_caida_envia_el_respaldo_y_avisa_a_una_persona():
    with entorno() as (a, c, enviados, prompts):
        a.on("GET", "/api/bot/status", (503, {"error": "caida"}))
        assert server.reply_for([{"role": "user", "content": "quiero cita"}], PHONE, "c1") == server.FALLBACK
        assert prompts == [], "sin API no se consulta al modelo con horarios viejos"
        assert llamadas(a, "POST", "/api/bot/handoffs")  # se intento avisar (puede fallar tambien)


@test
def reply_for_si_solo_falla_la_configuracion_tambien_envia_el_respaldo():
    with entorno() as (a, c, enviados, prompts):
        a.on("GET", "/api/bot/config", (500, {"error": "boom"}))
        assert server.reply_for([{"role": "user", "content": "hola"}], PHONE, "c1") == server.FALLBACK
        assert prompts == []
        h = llamadas(a, "POST", "/api/bot/handoffs")[0].body
        assert h["conversationId"] == "c1" and h["telefono"] == PHONE and h["reason"] == "otro"


@test
def reply_for_si_el_modelo_falla_envia_el_respaldo_con_motivo_modelo_fallo():
    with entorno() as (a, c, enviados, prompts):
        def roto(system, msgs):
            raise RuntimeError("claude CLI failed")
        server.llm = roto
        assert server.reply_for([{"role": "user", "content": "hola"}], PHONE, "c1") == server.FALLBACK
        assert llamadas(a, "POST", "/api/bot/handoffs")[0].body["reason"] == "modelo_fallo"


@test
def reply_for_una_respuesta_normal_no_genera_traspaso():
    with entorno() as (a, c, enviados, prompts):
        assert server.reply_for([{"role": "user", "content": "hola"}], PHONE, "c1") == "Hola, soy el asistente de la clinica."
        assert llamadas(a, "POST", "/api/bot/handoffs") == []


@test
def agendar_por_el_bot_llega_a_la_api_con_el_telefono_del_remitente():
    with entorno() as (a, c, enviados, prompts):
        cita = {"cita_id": "42", "doctor": "Dr. Cervantes Pelaez", "especialidad": "Proctologia", "consultorio": "Consultorio 1",
                "inicio": "2026-11-20T10:00-05:00", "paciente": "Ana Lopez"}
        a.on("POST", "/api/bot/appointments", (201, dict(cita, ok=True)))
        pasos = iter([
            json.dumps({"reply": None, "action": {"name": "agendar", "especialidad": "Proctologia", "nombre": "Ana Lopez",
                                                  "inicio": "2026-11-20T10:00"}}),
            json.dumps({"reply": "Listo, tu cita quedo agendada.", "action": None})])
        vistos = []
        server.llm = lambda system, msgs: (vistos.append(msgs), next(pasos))[1]
        r = server.reply_for([{"role": "user", "content": "si, ese horario"}], PHONE, "c1")
        assert r == "Listo, tu cita quedo agendada."
        body = llamadas(a, "POST", "/api/bot/appointments")[0].body
        assert body["telefono"] == PHONE and body["nombre"] == "Ana Lopez" and body["inicio"] == "2026-11-20T10:00-05:00"
        assert "RESULTADO" in vistos[1][-1]["content"] and '"event_id": "42"' in vistos[1][-1]["content"]
        assert llamadas(a, "GET", "/api/bot/status"), "el interruptor se consulta antes de contestar"


@test
def handle_direct_contesta_por_zernio_y_con_el_interruptor_apagado_calla():
    with entorno() as (a, c, enviados, prompts):
        assert server.handle_direct(evento("hola")) == "Hola, soy el asistente de la clinica."
        assert enviados == [("POST", "/inbox/conversations/c1/messages", {"accountId": "acc1", "message": "Hola, soy el asistente de la clinica."})]
        assert "PRIMER mensaje" in prompts[0], "el primer mensaje aclara que es un asistente automatico"
        a.on("GET", "/api/bot/status", (200, {"active": False}))
        assert server.handle_direct(evento("otra cosa", eid="e2")) is None
        assert len(enviados) == 1, "con el interruptor apagado no se envia nada a Zernio"


# ------------------------------------------------------------------ el webhook HTTP real del bot
def _firmar(raw, secret):
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def _post(url, raw, headers):
    req = urllib.request.Request(url, data=raw, method="POST", headers=dict({"Content-Type": "application/json"}, **headers))
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def _esperar(cond, segundos=5):
    fin = time.time() + segundos
    while time.time() < fin:
        if cond():
            return True
        time.sleep(0.02)
    return False


@test
def webhook_directo_verifica_la_firma_responde_rapido_y_contesta_una_sola_vez():
    with entorno() as (a, c, enviados, prompts):
        server.SECRET = "secreto-de-prueba"
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{httpd.server_address[1]}/"
        try:
            raw = json.dumps(evento("hola, quiero una cita")).encode()
            assert _post(url, raw, {"X-Zernio-Signature": "0" * 64}) == 401 and enviados == []
            assert _post(url, raw, {}) == 401
            ok = {"X-Zernio-Signature": _firmar(raw, "secreto-de-prueba")}
            assert _post(url, raw, ok) == 200
            assert _esperar(lambda: len(enviados) == 1), "debio contestar por Zernio"
            assert enviados[0][1] == "/inbox/conversations/c1/messages"
            assert _post(url, raw, ok) == 200  # Zernio reintenta/duplica: se ignora
            time.sleep(0.3)
            assert len(enviados) == 1, "el mismo evento no se contesta dos veces"
            # eventos que no son del paciente: se aceptan y se ignoran
            for cambio in ({"direction": "outgoing"}, {"platform": "instagram"}, {"metadata": {"standby": True}}):
                e = evento("x", eid="otro-" + str(len(cambio) + len(str(cambio))))
                e["message"].update(cambio)
                body = json.dumps(e).encode()
                assert _post(url, body, {"X-Zernio-Signature": _firmar(body, "secreto-de-prueba")}) == 200
            prueba = json.dumps({"event": "webhook.test", "test": True, "message": "ping"}).encode()
            assert _post(url, prueba, {"X-Zernio-Signature": _firmar(prueba, "secreto-de-prueba")}) == 200
            time.sleep(0.3)
            assert len(enviados) == 1
        finally:
            httpd.shutdown(); httpd.server_close()


@test
def webhook_directo_con_el_interruptor_apagado_no_envia_nada():
    with entorno(active=False) as (a, c, enviados, prompts):
        server.SECRET = "s"
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            raw = json.dumps(evento("hola")).encode()
            assert _post(f"http://127.0.0.1:{httpd.server_address[1]}/", raw, {"X-Zernio-Signature": _firmar(raw, "s")}) == 200
            assert _esperar(lambda: llamadas(a, "GET", "/api/bot/status")), "debio consultar el interruptor"
            time.sleep(0.3)
            assert enviados == [] and prompts == []
        finally:
            httpd.shutdown(); httpd.server_close()


@test
def el_reporte_de_arranque_dice_con_que_agenda_trabaja():
    with entorno() as (a, c, enviados, prompts):
        r = server.startup_report()
        assert "OK" in r and "ACTIVO" in r and "2 doctores" in r and "lunes a viernes" in r and TOKEN not in r
        a.on("GET", "/api/bot/status", (200, {"active": False}))
        assert "APAGADO" in server.startup_report()
        a.on("GET", "/api/bot/config", (500, {"error": "x"}))
        assert "NO RESPONDE" in server.startup_report()


if __name__ == "__main__":
    bad = 0
    for t in tests:
        try:
            t(); print("OK  ", t.__name__)
        except Exception as e:
            import traceback
            bad += 1; print("FAIL", t.__name__, "->", repr(e)[:400]); traceback.print_exc(limit=3)
    print(f"\n{len(tests) - bad}/{len(tests)} pruebas pasaron")
    sys.exit(1 if bad else 0)
