"""Pruebas de `api_client.py`, del backend `api` de `server.py` y de `poller.py` contra una API FALSA local.
No toca Zernio, Google ni el modelo. Ejecutar: python test_api_client.py (solo libreria estandar).
"""
import json, os, sys, threading, time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ZERNIO_API_KEY", "x")
os.environ["WATHSBOT_BACKEND"] = "api"
from datetime import date, datetime

import api_client
import poller
import server
from api_client import ApiAgenda, ApiUnavailable, TZ

TOKEN = "token-de-prueba"
tests = []


def test(f):
    tests.append(f)
    return f


# ------------------------------------------------------------------ API falsa
class FakeApi:
    def __init__(self):
        self.routes, self.calls, self.drop = {}, [], 0
        api = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _serve(self):
                u = urlparse(self.path)
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                req = SimpleNamespace(method=self.command, raw_path=u.path, path=unquote(u.path),
                                      query={k: v[0] for k, v in parse_qs(u.query).items()},
                                      body=json.loads(raw) if raw else None, headers=self.headers)
                api.calls.append(req)
                if api.drop > 0:  # cortar la conexion sin responder
                    api.drop -= 1
                    self.close_connection = True
                    self.connection.close()
                    return
                fn = api.routes.get((self.command, req.path))
                status, out = fn(req) if fn else (404, b"sin ruta")
                data = out if isinstance(out, bytes) else (b"" if out is None else json.dumps(out).encode())
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _serve

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def on(self, method, path, response):
        self.routes[(method, path)] = response if callable(response) else (lambda _r, r=response: r)

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@contextmanager
def api():
    a = FakeApi()
    try:
        yield a, ApiAgenda(a.url, TOKEN, timeout=3)
    finally:
        a.close()


CITA = {"cita_id": "42", "doctor": "Dr. Cervantes Pelaez", "especialidad": "Proctologia", "consultorio": "Consultorio 1",
        "inicio": "2026-11-12T10:00-05:00", "paciente": "Ana Lopez"}


# ------------------------------------------------------------- cliente HTTP
@test
def sin_configuracion_no_arranca():
    old = {k: os.environ.pop(k, None) for k in ("CLINICA_API_URL", "CLINICA_BOT_TOKEN")}
    try:
        try:
            ApiAgenda()
        except ApiUnavailable:
            return
        raise AssertionError("debio fallar sin CLINICA_API_URL/CLINICA_BOT_TOKEN")
    finally:
        os.environ.update({k: v for k, v in old.items() if v})


@test
def horarios_envia_token_y_parametros():
    with api() as (a, c):
        a.on("GET", "/api/bot/availability", (200, {"doctor": "Dr. X", "especialidad": "Proctologia", "horarios": ["2026-11-12T13:30-05:00"]}))
        r = c.free_slots("proctologia", from_day=date(2026, 11, 20), days=5, hora_min=13, hora_max=18.5)
        q = a.calls[0].query
        assert a.calls[0].headers["Authorization"] == "Bearer " + TOKEN
        assert q["especialidad"] == "proctologia" and q["desde"] == "2026-11-20" and q["dias"] == "5"
        assert float(q["hora_min"]) == 13 and float(q["hora_max"]) == 18.5
        assert r["horarios"] == ["2026-11-12T13:30-05:00"]
        c.free_slots("proctologia")  # sin filtros opcionales: no se mandan
        assert set(a.calls[1].query) == {"especialidad", "dias"}, a.calls[1].query


@test
def cercanos_manda_hora_de_cancun_con_desfase():
    with api() as (a, c):
        a.on("GET", "/api/bot/nearest", (200, {"exacto": True, "horarios": []}))
        c.nearest("proctologia", datetime(2026, 11, 12, 13, 30, tzinfo=TZ))
        assert a.calls[0].query["fecha_hora"] == "2026-11-12T13:30-05:00"


@test
def errores_de_negocio_se_devuelven_como_dict():
    with api() as (a, c):
        a.on("GET", "/api/bot/availability", (422, {"error": "especialidad_no_encontrada", "especialidades": ["Proctologia"]}))
        a.on("POST", "/api/bot/appointments", (409, {"error": "horario_ocupado"}))
        a.on("POST", "/api/bot/appointments/9/cancel", (404, {"error": "cita_no_encontrada"}))
        assert c.free_slots("cardiologia")["error"] == "especialidad_no_encontrada"
        assert c.book("5299", "Ana Lopez", "proctologia", datetime(2026, 11, 12, 10, tzinfo=TZ)) == {"error": "horario_ocupado"}
        assert c.cancel("5299", "9") == {"error": "cita_no_encontrada"}


@test
def agendar_manda_cuerpo_y_agrega_event_id_heredado():
    with api() as (a, c):
        a.on("POST", "/api/bot/appointments", (201, dict(CITA, ok=True)))
        r = c.book("529988908000", "Ana Lopez", "proctologia", datetime(2026, 11, 12, 10, 0, tzinfo=TZ))
        assert a.calls[0].body == {"telefono": "529988908000", "nombre": "Ana Lopez", "especialidad": "proctologia",
                                   "inicio": "2026-11-12T10:00-05:00"}
        assert r["ok"] and r["cita_id"] == "42" and r["event_id"] == "42" and r["consultorio"] == "Consultorio 1"


@test
def mis_citas_cancelar_y_reprogramar():
    with api() as (a, c):
        a.on("GET", "/api/bot/appointments", (200, {"citas": [CITA]}))
        a.on("POST", "/api/bot/appointments/42/cancel", (200, {"ok": True, "cancelada": CITA}))
        a.on("POST", "/api/bot/appointments/42/reschedule",
             (200, dict(CITA, ok=True, inicio="2026-11-13T10:00-05:00", reprogramada_desde="2026-11-12T10:00-05:00")))
        m = c.mine("529988908000")
        assert a.calls[0].query == {"telefono": "529988908000"} and m[0]["event_id"] == "42"
        r = c.cancel("529988908000", "42")
        assert r["ok"] and r["cancelada"]["event_id"] == "42" and a.calls[1].body == {"telefono": "529988908000"}
        r = c.reschedule("529988908000", "42", datetime(2026, 11, 13, 10, tzinfo=TZ))
        assert r["event_id"] == "42" and r["reprogramada_desde"] == "2026-11-12T10:00-05:00"
        assert a.calls[2].body == {"telefono": "529988908000", "inicio": "2026-11-13T10:00-05:00"}


@test
def el_id_de_la_cita_va_codificado_en_la_ruta():
    with api() as (a, c):
        a.on("POST", "/api/bot/appointments/ab c/cancel", (404, {"error": "cita_no_encontrada"}))
        c.cancel("5299", "ab c")
        assert a.calls[0].raw_path == "/api/bot/appointments/ab%20c/cancel", a.calls[0].raw_path
        try:
            c.cancel("5299", "../../x")  # no puede escapar de la ruta (la API falsa no tiene esa ruta: 404 sin cuerpo)
        except ApiUnavailable:
            pass
        assert a.calls[1].raw_path == "/api/bot/appointments/..%2F..%2Fx/cancel", a.calls[1].raw_path


@test
def fallos_de_infraestructura_lanzan_ApiUnavailable():
    with api() as (a, c):
        a.on("GET", "/api/bot/availability", (500, {"error": "boom"}))
        a.on("GET", "/api/bot/nearest", (401, {"error": "no_autenticado"}))
        a.on("GET", "/api/bot/appointments", (200, b"<html>no soy json</html>"))
        a.on("POST", "/api/bot/appointments/1/cancel", (404, b"sin cuerpo de error"))
        a.on("POST", "/api/bot/appointments", (429, {"error": "limite"}))
        for fn, status in ((lambda: c.free_slots("p"), 500),
                           (lambda: c.nearest("p", datetime(2026, 11, 12, 10, tzinfo=TZ)), 401),
                           (lambda: c.mine("5299"), 200),
                           (lambda: c.cancel("5299", "1"), 404),
                           (lambda: c.book("5299", "Ana Lopez", "p", datetime(2026, 11, 12, 10, tzinfo=TZ)), 429)):
            try:
                fn()
            except ApiUnavailable as e:
                assert e.status == status, (e.status, status)
            else:
                raise AssertionError("debio lanzar ApiUnavailable")
    dead = ApiAgenda("http://127.0.0.1:9", TOKEN, timeout=1)  # puerto cerrado
    try:
        dead.bot_active()
    except ApiUnavailable:
        pass
    else:
        raise AssertionError("conexion rechazada debe ser ApiUnavailable")


@test
def lecturas_se_reintentan_una_vez_las_escrituras_no():
    with api() as (a, c):
        a.on("GET", "/api/bot/status", (200, {"active": True}))
        a.on("POST", "/api/bot/appointments", (201, dict(CITA, ok=True)))
        a.drop = 1
        assert c.bot_active() is True and len(a.calls) == 2  # corte + reintento
        a.drop = 1
        try:
            c.book("5299", "Ana Lopez", "p", datetime(2026, 11, 12, 10, tzinfo=TZ))
        except ApiUnavailable:
            assert len(a.calls) == 3, "una escritura no debe reintentarse (riesgo de reservar dos veces)"
        else:
            raise AssertionError("la escritura cortada debio fallar")


@test
def interruptor_y_configuracion():
    with api() as (a, c):
        a.on("GET", "/api/bot/status", (200, {"active": False}))
        assert c.bot_active() is False
        a.on("GET", "/api/bot/status", (200, {"active": "si"}))
        try:
            c.bot_active()
        except ApiUnavailable:
            pass
        else:
            raise AssertionError("un estado ilegible nunca se toma como activo")
        a.on("GET", "/api/bot/config", (200, {"timezone": "America/Cancun", "doctors": []}))
        assert c.config()["timezone"] == "America/Cancun"


@test
def cola_claim_ack_fail_y_handoff():
    with api() as (a, c):
        a.on("POST", "/api/bot/events/claim", (200, {"events": [{"id": "7", "payload": {}}]}))
        a.on("POST", "/api/bot/events/7/ack", (204, None))
        a.on("POST", "/api/bot/events/7/fail", (204, None))
        a.on("POST", "/api/bot/handoffs", (201, {"id": "1"}))
        assert c.claim(limit=3, lease_seconds=300)[0]["id"] == "7"
        assert a.calls[0].body == {"limit": 3, "leaseSeconds": 300}
        c.ack("7", "replied")
        c.fail("7", "x" * 900, retry=False)
        c.handoff("conv1", "otro", telefono="5299", detail="d")
        assert a.calls[1].body == {"outcome": "replied"}
        assert a.calls[2].body["retry"] is False and len(a.calls[2].body["reason"]) == 500
        assert a.calls[3].body == {"conversationId": "conv1", "reason": "otro", "telefono": "5299", "detail": "d"}


# ------------------------------------------------- server.py con backend `api`
DOCS = [{"name": "Dr. Cervantes Pelaez", "specialty": "Proctologia"}, {"name": "Dra. Geydi", "specialty": "Anestesiologia"}]
CONFIG = {"timezone": "America/Cancun", "slotMinutes": 30, "minNoticeMinutes": 60, "horizonDays": 60, "doctors": DOCS}


@contextmanager
def server_con_api():
    with api() as (a, c):
        a.on("GET", "/api/bot/config", (200, CONFIG))
        old = server._AGENDA
        server._AGENDA = c
        try:
            yield a, c
        finally:
            server._AGENDA = old


@test
def run_action_traduce_las_acciones_a_la_api():
    with server_con_api() as (a, c):
        a.on("GET", "/api/bot/availability", (200, {"doctor": "Dr. X", "horarios": []}))
        a.on("GET", "/api/bot/nearest", (200, {"exacto": False, "horarios": []}))
        a.on("POST", "/api/bot/appointments", (201, dict(CITA, ok=True)))
        a.on("GET", "/api/bot/appointments", (200, {"citas": [CITA]}))
        a.on("POST", "/api/bot/appointments/42/cancel", (200, {"ok": True, "cancelada": CITA}))
        a.on("POST", "/api/bot/appointments/42/reschedule", (200, dict(CITA, ok=True, reprogramada_desde="x")))
        ph = "529988908000"
        server.run_action({"name": "horarios", "especialidad": "proctologia", "desde": "2026-11-20", "hora_min": 13, "dias": 3}, ph)
        q = a.calls[-1].query
        assert q["desde"] == "2026-11-20" and float(q["hora_min"]) == 13 and q["dias"] == "3" and "hora_max" not in q
        server.run_action({"name": "cercanos", "especialidad": "proctologia", "fecha_hora": "2026-11-12T13:30"}, ph)
        assert a.calls[-1].query["fecha_hora"] == "2026-11-12T13:30-05:00"
        r = server.run_action({"name": "agendar", "especialidad": "proctologia", "nombre": "  Ana Lopez ", "inicio": "2026-11-12T10:00"}, ph)
        assert a.calls[-1].body["nombre"] == "Ana Lopez" and a.calls[-1].body["telefono"] == ph and r["event_id"] == "42"
        assert server.run_action({"name": "mis_citas"}, ph)["citas"][0]["event_id"] == "42"
        assert server.run_action({"name": "cancelar", "event_id": "42"}, ph)["ok"]
        assert server.run_action({"name": "reprogramar", "event_id": "42", "inicio": "2026-11-13T10:00"}, ph)["ok"]
        assert server.run_action({"name": "inventada"}, ph) == {"error": "accion_desconocida"}


@test
def el_prompt_sale_de_la_api_y_no_de_agenda_config():
    with server_con_api() as (a, c):
        p = server.agenda_prompt()
        assert "Dra. Geydi" in p and "Proctologia: Dr. Cervantes Pelaez" in p and "Citas de 30 minutos" in p
        assert "al menos 60 minutos de antelacion y hasta 60 dias" in p
        assert "Dr. Molina" not in p, "no debe usar los doctores de agenda_config.json"
        a.on("GET", "/api/bot/config", (503, {"error": "caida"}))
        try:
            server.agenda_prompt()
        except ApiUnavailable:
            pass
        else:
            raise AssertionError("sin API no hay prompt de agenda: no se usa una copia")


@test
def api_caida_a_mitad_de_la_conversacion_el_modelo_recibe_agenda_no_disponible():
    with server_con_api() as (a, c):
        a.on("GET", "/api/bot/availability", (500, {"error": "boom"}))
        vistos = []
        respuestas = iter(['{"reply": null, "action": {"name": "horarios", "especialidad": "proctologia"}}',
                           '{"reply": "El equipo se pondra en contacto contigo.", "action": null}'])
        old = server.llm
        server.llm = lambda system, msgs: (vistos.append(json.dumps(msgs, ensure_ascii=False)), next(respuestas))[1]
        try:
            r = server.run_agent("S", [{"role": "user", "content": "quiero cita"}], "529988908000")
        finally:
            server.llm = old
        assert "agenda_no_disponible" in vistos[1] and "horarios" not in r, (vistos[1], r)
        assert r == "El equipo se pondra en contacto contigo."


# ------------------------------------------------------------------- poller
def ev(text="hola", conv="c1", phone="529988908000", **over):
    m = {"platform": "whatsapp", "direction": "incoming", "text": text, "conversationId": conv, "sender": {"id": phone}}
    p = {"id": "z-" + conv, "event": "message.received", "message": m, "account": {"accountId": "a1"}, "conversation": {}}
    p.update(over)
    return p


class FakeClient:
    def __init__(self, active=True):
        self.active, self.calls = active, []
        self.err = set()          # operaciones que lanzan ApiUnavailable (una vez cada vez que se piden)
        self.err_times = {}       # operacion -> veces que debe fallar

    def _maybe(self, op):
        self.calls.append(op)
        n = self.err_times.get(op[0], 0)
        if n > 0:
            self.err_times[op[0]] = n - 1
            raise ApiUnavailable(op[0])

    def bot_active(self):
        self._maybe(("bot_active",))
        return self.active

    def ack(self, eid, outcome):
        self._maybe(("ack", eid, outcome))

    def fail(self, eid, reason, retry=True):
        self._maybe(("fail", eid, retry))

    def handoff(self, conv, reason, telefono=None, detail=None):
        self._maybe(("handoff", conv, telefono))

    def of(self, name):
        return [c for c in self.calls if c[0] == name]


def proc(client, handle, fallback="FALLBACK"):
    return poller.Processor(client, handle, fallback, log=lambda *a: None)


@test
def poller_contesta_y_cierra_el_evento():
    c, hecho = FakeClient(), []
    p = proc(c, lambda payload: hecho.append(payload) or "respuesta")
    p.process({"id": "1", "payload": ev()})
    assert len(hecho) == 1 and c.of("ack") == [("ack", "1", "replied")] and not c.of("handoff") and not c.of("fail")


@test
def poller_con_interruptor_apagado_no_contesta():
    c, hecho = FakeClient(active=False), []
    proc(c, lambda payload: hecho.append(1) or "x").process({"id": "1", "payload": ev()})
    assert hecho == [] and c.of("ack") == [("ack", "1", "skipped_bot_inactive")]


@test
def poller_ignora_lo_que_no_es_un_mensaje_de_paciente():
    casos = [ev(test=True), ev(event="webhook.test", message="texto"), ev(event="message.sent")]
    otro = ev(); otro["message"]["direction"] = "outgoing"; casos.append(otro)
    wa = ev(); wa["message"]["platform"] = "instagram"; casos.append(wa)
    sb = ev(); sb["message"]["metadata"] = {"standby": True}; casos.append(sb)
    for i, payload in enumerate(casos):
        c, hecho = FakeClient(), []
        proc(c, lambda p: hecho.append(1) or "x").process({"id": str(i), "payload": payload})
        assert hecho == [] and c.of("ack") == [("ack", str(i), "skipped_ignored")], (i, c.calls)
        assert not c.of("bot_active"), "ni siquiera debe consultar el interruptor"


@test
def poller_si_el_atendedor_falla_devuelve_el_evento_a_la_cola():
    for exc in (RuntimeError("modelo caido"), ApiUnavailable("api")):
        c = FakeClient()
        def boom(payload, e=exc):
            raise e
        proc(c, boom).process({"id": "1", "payload": ev()})
        assert c.of("fail") == [("fail", "1", True)] and not c.of("ack"), (exc, c.calls)


@test
def poller_sin_interruptor_legible_devuelve_el_evento_y_no_contesta():
    c, hecho = FakeClient(), []
    c.err_times["bot_active"] = 1
    proc(c, lambda p: hecho.append(1) or "x").process({"id": "1", "payload": ev()})
    assert hecho == [] and c.of("fail") == [("fail", "1", True)]


@test
def poller_no_se_cae_si_tampoco_puede_devolver_el_evento():
    c = FakeClient()
    c.err_times.update(bot_active=1, fail=1)
    proc(c, lambda p: "x").process({"id": "1", "payload": ev()})  # no debe lanzar
    assert c.of("fail")


@test
def poller_no_contesta_dos_veces_si_el_ack_no_llego():
    c, hecho = FakeClient(), []
    c.err_times["ack"] = 1
    p = proc(c, lambda payload: hecho.append(1) or "respuesta")
    p.process({"id": "1", "payload": ev()})          # contesta; el ack falla (API cayo justo despues)
    p.process({"id": "1", "payload": ev()})          # el servidor lo reclama de nuevo al vencer el plazo
    assert len(hecho) == 1, "no debe volver a contestar"
    assert c.of("ack") == [("ack", "1", "replied")] * 2 and not c.of("fail")


@test
def poller_avisa_a_una_persona_cuando_el_bot_envia_el_mensaje_de_respaldo():
    c = FakeClient()
    proc(c, lambda payload: server.FALLBACK, fallback=server.FALLBACK).process({"id": "1", "payload": ev(conv="cx", phone="5299")})
    assert c.of("ack") == [("ack", "1", "replied")] and c.of("handoff") == [("handoff", "cx", "5299")]
    c2 = FakeClient(); c2.err_times["handoff"] = 1  # si el aviso falla, no pasa nada
    proc(c2, lambda payload: server.FALLBACK, fallback=server.FALLBACK).process({"id": "2", "payload": ev()})
    assert c2.of("ack")


@test
def poller_atiende_de_uno_en_uno_los_mensajes_de_una_misma_conversacion():
    c, estado = FakeClient(), {"activos": 0, "max": 0}
    lock = threading.Lock()

    def lento(payload):
        with lock:
            estado["activos"] += 1
            estado["max"] = max(estado["max"], estado["activos"])
        time.sleep(0.05)
        with lock:
            estado["activos"] -= 1
        return "ok"

    p = proc(c, lento)
    hilos = [threading.Thread(target=p.process, args=({"id": str(i), "payload": ev(conv="misma")},)) for i in range(4)]
    [h.start() for h in hilos]; [h.join() for h in hilos]
    assert estado["max"] == 1 and len(c.of("ack")) == 4, estado
    # y conversaciones distintas SI van en paralelo
    estado.update(activos=0, max=0)
    hilos = [threading.Thread(target=p.process, args=({"id": "d" + str(i), "payload": ev(conv=f"c{i}")},)) for i in range(4)]
    [h.start() for h in hilos]; [h.join() for h in hilos]
    assert estado["max"] > 1, estado


@test
def poller_bucle_se_recupera_de_una_caida_y_procesa_la_cola():
    c, hechos, stop = FakeClient(), [], threading.Event()
    secuencia = [ApiUnavailable("caida"), [{"id": "1", "payload": ev(conv="a")}, {"id": "2", "payload": ev(conv="b")}], []]

    def claim(limit, lease_seconds):
        assert 1 <= limit <= 20 and lease_seconds == 60
        r = secuencia.pop(0) if secuencia else []
        if isinstance(r, Exception):
            raise r
        return r

    def handle(payload):
        hechos.append(payload["message"]["conversationId"])
        if len(hechos) == 2:
            threading.Timer(0.1, stop.set).start()
        return "ok"

    c.claim = claim
    threading.Timer(10, stop.set).start()  # red de seguridad
    poller.run(c, proc(c, handle), stop, workers=2, poll=0.01, lease=60, log=lambda *a: None)
    assert sorted(hechos) == ["a", "b"] and sorted(x[1] for x in c.of("ack")) == ["1", "2"], (hechos, c.calls)


if __name__ == "__main__":
    bad = 0
    for t in tests:
        try:
            t(); print("OK  ", t.__name__)
        except Exception as e:
            bad += 1; print("FAIL", t.__name__, "->", repr(e)[:400])
    print(f"\n{len(tests) - bad}/{len(tests)} pruebas pasaron")
    sys.exit(1 if bad else 0)
