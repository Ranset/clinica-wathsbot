"""Pruebas de canales: WhatsApp, Messenger de Facebook e Instagram con LAS MISMAS funciones.
Sin red: Zernio, la API y el modelo estan simulados.   Ejecutar:  /opt/venv/bin/python test_channels.py
"""
import json, os, subprocess, sys, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.update(ZERNIO_API_KEY="x", WATHSBOT_BACKEND="api", CLINICA_API_URL="http://x", CLINICA_BOT_TOKEN="x")
import server, api_client, poller

server.RETRY_SLEEP = 0
HOURS = {d: [{"start": "09:00", "end": "18:00"}] for d in ("mon", "tue", "wed", "thu", "fri")}
PSID = "29894443490173495"      # id de Meta de 17 digitos: NO es un telefono
IGSID = "17841400000000000"
PHONE = "529990000001"
T1, T2 = api_client.parse_dt("2026-11-20T10:00"), api_client.parse_dt("2026-11-20T11:00")


# ================================================================== cliente de la API (lo que viaja por la red)
class Wire(api_client.ApiAgenda):
    """ApiAgenda real con el transporte sustituido: registra cada peticion tal como saldria a la API."""
    def __init__(self, status=None):
        super().__init__("http://x", "tok")
        self.sent, self.status = [], ({"active": True} if status is None else status)

    def _call(self, method, path, params=None, body=None, retry_get=True):
        self.sent.append((method, path, params, body))
        if path == "/api/bot/status": return 200, self.status
        if path == "/api/bot/appointments" and method == "GET": return 200, {"citas": []}
        if path == "/api/bot/handoffs": return 201, {"id": "1"}
        return 200, {"ok": True, "id": 1}


tests = []
def test(f): tests.append(f); return f


@test
def whatsapp_manda_a_la_api_exactamente_lo_de_siempre():
    w = Wire()
    w.mine(PHONE); w.book(PHONE, "Ana Lopez", "proctologia", T1); w.cancel(PHONE, "5")
    w.reschedule(PHONE, "5", T2); w.handoff("c1", "otro", telefono=PHONE, detail="x")
    sent = w.sent
    assert sent[0][2] == {"telefono": PHONE}
    assert set(sent[1][3]) == {"telefono", "nombre", "especialidad", "inicio"} and sent[1][3]["telefono"] == PHONE
    assert sent[2][3] == {"telefono": PHONE}
    assert set(sent[3][3]) == {"telefono", "inicio"}
    assert sent[4][3] == {"conversationId": "c1", "reason": "otro", "telefono": PHONE, "detail": "x"}
    for _, _, params, body in sent:                       # ni rastro de campos nuevos
        assert "canal" not in (params or {}) and "canal" not in (body or {})


@test
def messenger_e_instagram_mandan_canal_y_contacto_id_nunca_telefono():
    for canal, ident in (("facebook", PSID), ("instagram", IGSID)):
        w = Wire(); who = api_client.Ident(ident, canal)
        w.mine(who); w.book(who, "Ana Lopez", "proctologia", T1, telefono_contacto="9981234567")
        w.cancel(who, "5"); w.reschedule(who, "5", T2); w.handoff("c1", "pidio_persona", canal=canal, contacto_id=ident)
        want = {"canal": canal, "contacto_id": ident}
        assert w.sent[0][2] == want, w.sent[0]
        assert {k: w.sent[1][3][k] for k in want} == want and w.sent[1][3]["telefono_contacto"] == "9981234567"
        assert {k: w.sent[2][3][k] for k in want} == want and {k: w.sent[3][3][k] for k in want} == want
        h = w.sent[4][3]
        assert h["canal"] == canal and h["contacto_id"] == ident and "telefono" not in h
        for _, _, params, body in w.sent:
            assert "telefono" not in (params or {}) and "telefono" not in (body or {}), (params, body)


@test
def el_telefono_de_contacto_solo_viaja_en_canales_distintos_de_whatsapp():
    w = Wire(); w.book(PHONE, "Ana", "proctologia", T1, telefono_contacto="9981234567")
    assert "telefono_contacto" not in w.sent[0][3]


@test
def el_interruptor_es_por_canal():
    w = Wire({"active": True, "channels": {"whatsapp": True, "facebook": False, "instagram": True}})
    assert w.bot_active() is True and w.bot_active("whatsapp") is True
    assert w.bot_active("facebook") is False and w.bot_active("instagram") is True


@test
def con_la_api_vieja_whatsapp_sigue_funcionando_y_los_otros_canales_quedan_apagados():
    w = Wire({"active": True})             # sin "channels": la API aun no conoce canales
    assert w.bot_active() is True
    assert w.bot_active("facebook") is False and w.bot_active("instagram") is False
    assert Wire({"active": False}).bot_active() is False


@test
def una_respuesta_rara_del_interruptor_nunca_se_toma_como_activo():
    for st in ({"channels": {"facebook": "si"}}, {"channels": {"whatsapp": None}}, {}):
        for canal in ("whatsapp", "facebook"):
            w = Wire(st)
            try:
                r = w.bot_active(canal)
            except api_client.ApiUnavailable:
                continue
            assert r is False, (st, canal, r)


# ================================================================== el bot
class RecAgenda:
    """Agenda simulada que REGISTRA con que identidad (valor + canal) se llamo a cada cosa."""
    def __init__(self, fail_handoff=False, switches=None):
        self.calls, self.handoffs, self.fail = [], [], fail_handoff
        self.switches = switches or {"whatsapp": True, "facebook": True, "instagram": True}
        self.asked = []

    def config(self):
        return {"timezone": "America/Cancun", "slotMinutes": 30, "minNoticeMinutes": 60, "horizonDays": 60, "clinicHours": HOURS,
                "doctors": [{"name": "Dr. Cervantes", "specialty": "Proctologia", "usesClinicHours": True}]}

    def bot_active(self, canal="whatsapp"):
        self.asked.append(canal); return self.switches.get(canal, False)

    def handoff(self, conv, reason, telefono=None, detail=None, canal=None, contacto_id=None):
        if self.fail: raise api_client.ApiUnavailable("caida")
        self.handoffs.append({"conv": conv, "reason": reason, "telefono": telefono, "detail": detail, "canal": canal, "contacto_id": contacto_id})

    def book(self, who, name, spec, start, ignore_id=None, telefono_contacto=None):
        self.calls.append(("book", str(who), api_client.canal_of(who), name, telefono_contacto)); return {"ok": True, "id": "7"}

    def mine(self, who): self.calls.append(("mine", str(who), api_client.canal_of(who))); return []
    def cancel(self, who, eid): self.calls.append(("cancel", str(who), api_client.canal_of(who), eid)); return {"ok": True}
    def reschedule(self, who, eid, start): self.calls.append(("reschedule", str(who), api_client.canal_of(who), eid)); return {"ok": True}
    def free_slots(self, *a, **k): self.calls.append(("free_slots",)); return []
    def nearest(self, *a, **k): self.calls.append(("nearest",)); return {"exacto": False, "cercanos": []}


class FakeZernio:
    def __init__(self): self.posts = []
    def __call__(self, method, path, body=None, headers=None):
        if method == "GET": return {"messages": []}
        self.posts.append(body); return {"success": True}


class Model:
    def __init__(self, *replies): self.it, self.systems = iter(replies), []
    def __call__(self, system, messages):
        self.systems.append(system); return json.dumps(next(self.it))


def ev(text="", platform="facebook", sender=PSID, atts=None, md=None, eid="e1", conv="c1"):
    m = {"conversationId": conv, "text": text, "attachments": atts or [], "platform": platform, "direction": "incoming",
         "sender": {"id": sender}, "metadata": md or {}}
    return {"id": eid, "event": "message.received", "message": m, "account": {"accountId": "acc-1"}, "conversation": {}}


def setup(*model, fail_handoff=False, switches=None, platforms=("whatsapp", "facebook", "instagram")):
    server._HANDOFF_SEEN.clear(); server._CONV_LOCKS.clear(); server.GREETED.clear()
    server.PLATFORMS = set(platforms)
    ag = RecAgenda(fail_handoff, switches); server._AGENDA = ag
    z = FakeZernio(); server.zernio = z
    mdl = Model(*model); server.llm = mdl
    return ag, z, mdl


def say(t): return {"reply": t, "action": None}
def act(**a): return {"reply": None, "action": a}


# ---------------------------------------------------------------- filtro de entrada
@test
def por_defecto_solo_whatsapp_y_se_activa_por_configuracion():
    server.PLATFORMS = {"whatsapp"}
    assert server._should_handle(ev("hola", "whatsapp", PHONE)) and not server._should_handle(ev("hola", "facebook"))
    server.PLATFORMS = {"whatsapp", "facebook", "instagram"}
    assert server._should_handle(ev("hola", "facebook")) and server._should_handle(ev("hola", "instagram"))


@test
def sin_configuracion_el_bot_solo_atiende_whatsapp():
    """Arranca server.py en un proceso nuevo con el entorno limpio."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("WATHSBOT_")}
    code = "import server; print(sorted(server.PLATFORMS))"
    out = subprocess.run([sys.executable, "-c", code], cwd=HERE, env=env, capture_output=True, text=True, timeout=30).stdout.strip()
    assert out == "['whatsapp']", out
    env["WATHSBOT_PLATFORMS"] = "whatsapp, facebook ,instagram"
    out = subprocess.run([sys.executable, "-c", code], cwd=HERE, env=env, capture_output=True, text=True, timeout=30).stdout.strip()
    assert out == "['facebook', 'instagram', 'whatsapp']", out


@test
def sigue_ignorando_salientes_standby_pruebas_y_otros_canales():
    server.PLATFORMS = {"whatsapp", "facebook", "instagram"}
    out = ev("hola"); out["message"]["direction"] = "outgoing"
    t = ev("hola"); t["test"] = True
    e = ev("hola"); e["event"] = "message.sent"
    assert not any(server._should_handle(x) for x in (out, ev("hola", md={"standby": True}), t, e))
    assert not any(server._should_handle(ev("hola", p)) for p in ("telegram", "sms", "twitter", "tiktok"))


# ---------------------------------------------------------------- mismas funciones en cada canal
@test
def el_prompt_de_agenda_aplica_a_los_tres_canales_y_el_canal_se_nombra_solo_si_no_es_whatsapp():
    for plat, who, nombre in (("whatsapp", PHONE, None), ("facebook", PSID, "Messenger de Facebook"), ("instagram", IGSID, "Instagram")):
        ag, z, mdl = setup(say("Hola"))
        server.handle_direct(ev("Hola", plat, who))
        sp = mdl.systems[0]
        assert "AGENDA AUTOMATICA" in sp and "pasar_a_persona" in sp, plat
        assert (("CANAL: " + nombre) in sp) if nombre else ("CANAL:" not in sp), plat


@test
def las_seis_acciones_funcionan_en_messenger_e_instagram_con_identidad_y_canal():
    for plat, who in (("facebook", PSID), ("instagram", IGSID)):
        ag, z, _ = setup(act(name="mis_citas"), say("a"),
                         act(name="agendar", especialidad="proctologia", nombre="Ana Lopez", inicio="2026-11-20T10:00", telefono_contacto="998 123-4567"), say("b"),
                         act(name="cancelar", event_id="5"), say("c"),
                         act(name="reprogramar", event_id="5", inicio="2026-11-20T11:00"), say("d"),
                         act(name="horarios", especialidad="proctologia"), say("e"),
                         act(name="cercanos", especialidad="proctologia", fecha_hora="2026-11-20T10:00"), say("f"))
        for i in range(6):
            server.handle_direct(ev("x", plat, who, eid=f"e{i}", conv=f"c{i}"))
        names = [c[0] for c in ag.calls]
        assert names == ["mine", "book", "cancel", "reschedule", "free_slots", "nearest"], names
        for c in ag.calls:
            if c[0] in ("mine", "book", "cancel", "reschedule"):
                assert c[1] == who and c[2] == plat, c           # la identidad viaja CON su canal
        assert ag.calls[1][4] == "9981234567"                    # telefono de contacto normalizado


@test
def agendar_desde_messenger_sin_telefono_de_contacto_valido_se_rechaza_en_el_codigo():
    for tel in (None, "", "123", "abc", "12345678901234567"):
        extra = {"telefono_contacto": tel} if tel is not None else {}
        ag, z, _ = setup(act(name="agendar", especialidad="proctologia", nombre="Ana Lopez", inicio="2026-11-20T10:00", **extra),
                         say("Necesito un telefono de contacto."))
        out = server.handle_direct(ev("agenda"))
        assert [c for c in ag.calls if c[0] == "book"] == [], tel
        assert out == "Necesito un telefono de contacto."


@test
def en_whatsapp_agendar_no_pide_telefono_de_contacto():
    ag, z, _ = setup(act(name="agendar", especialidad="proctologia", nombre="Ana Lopez", inicio="2026-11-20T10:00"), say("Listo."))
    server.handle_direct(ev("agenda", "whatsapp", PHONE))
    assert ag.calls == [("book", PHONE, "whatsapp", "Ana Lopez", None)]


@test
def el_prompt_de_messenger_pide_telefono_de_contacto_y_no_manda_a_whatsapp():
    ag, z, mdl = setup(say("ok"))
    server.handle_direct(ev("Quiero una cita"))
    sp = mdl.systems[0]
    assert "telefono_contacto" in sp and "No menciones WhatsApp" in sp and "por este mismo chat" in sp


@test
def un_psid_igual_a_un_telefono_real_no_se_confunde_con_el_paciente_de_whatsapp():
    ag, z, _ = setup(act(name="mis_citas"), say("ok"), act(name="mis_citas"), say("ok"))
    server.handle_direct(ev("mis citas", "facebook", PHONE))
    server.handle_direct(ev("mis citas", "whatsapp", PHONE, eid="e2", conv="c2"))
    assert ag.calls == [("mine", PHONE, "facebook"), ("mine", PHONE, "whatsapp")]


# ---------------------------------------------------------------- interruptor por canal
@test
def cada_canal_consulta_su_propio_interruptor():
    ag, z, _ = setup(say("a"), say("b"), say("c"))
    server.handle_direct(ev("hola", "whatsapp", PHONE, eid="1", conv="w"))
    server.handle_direct(ev("hola", "facebook", PSID, eid="2", conv="f"))
    server.handle_direct(ev("hola", "instagram", IGSID, eid="3", conv="i"))
    assert ag.asked == ["whatsapp", "facebook", "instagram"]


@test
def apagar_un_canal_no_apaga_los_demas():
    ag, z, mdl = setup(say("Hola WA"), switches={"whatsapp": True, "facebook": False, "instagram": True})
    assert server.handle_direct(ev("hola", "facebook", PSID)) is None and z.posts == [] and mdl.systems == []
    assert server.handle_direct(ev("hola", "whatsapp", PHONE, eid="e2", conv="c2")) == "Hola WA"
    ag, z, mdl = setup(say("Hola IG"), switches={"whatsapp": False, "facebook": True, "instagram": True})
    assert server.handle_direct(ev("hola", "whatsapp", PHONE)) is None
    assert server.handle_direct(ev("hola", "instagram", IGSID, eid="e2", conv="c2")) == "Hola IG"


@test
def un_canal_que_la_api_no_conoce_queda_callado():
    ag, z, mdl = setup(say("x"), switches={"whatsapp": True})
    assert server.handle_direct(ev("hola", "facebook")) is None and z.posts == [] and mdl.systems == []


# ---------------------------------------------------------------- traspaso a una persona
@test
def pedir_un_humano_registra_el_caso_con_canal_e_id_y_sin_telefono():
    ag, z, _ = setup(act(name="pasar_a_persona", motivo="pidio_persona", detalle="quiere hablar"), say("Ya avise al equipo."))
    server.handle_direct(ev("Quiero hablar con un humano", "instagram", IGSID))
    h = ag.handoffs
    assert len(h) == 1 and h[0]["telefono"] is None and h[0]["canal"] == "instagram" and h[0]["contacto_id"] == IGSID
    assert h[0]["reason"] == "pidio_persona" and h[0]["conv"] == "c1"


@test
def el_traspaso_de_whatsapp_sigue_mandando_telefono_y_nada_de_canal():
    ag, z, _ = setup(act(name="pasar_a_persona", motivo="pidio_persona", detalle="x"), say("ok"))
    server.handle_direct(ev("humano", "whatsapp", PHONE))
    h = ag.handoffs[0]
    assert h["telefono"] == PHONE and h["canal"] is None and h["contacto_id"] is None


@test
def la_red_de_seguridad_tambien_funciona_en_messenger():
    ag, z, _ = setup(say("Claro, voy a avisar a un miembro del equipo."))
    server.handle_direct(ev("Quiero hablar con una persona"))
    assert len(ag.handoffs) == 1 and ag.handoffs[0]["canal"] == "facebook"


@test
def si_el_registro_falla_no_se_promete_un_aviso_falso():
    ag, z, _ = setup(say("Claro, voy a avisar al equipo."), fail_handoff=True)
    assert server.handle_direct(ev("Quiero hablar con una persona")) == server.NO_NOTIFY


@test
def el_envio_fallido_se_reporta_con_el_canal_correcto():
    ag, z, _ = setup(say("Hola"))
    def boom(*a, **k): raise urllib.error.HTTPError("http://z", 500, "e", {}, None)
    server.zernio = boom
    server.handle_direct(ev("Hola"))
    h = ag.handoffs[0]
    assert h["canal"] == "facebook" and "Messenger de Facebook" in h["detail"] and "WhatsApp" not in h["detail"]


# ---------------------------------------------------------------- botones, adjuntos y compartidos
@test
def el_boton_comenzar_sin_texto_no_se_confunde_con_un_archivo():
    ag, z, mdl = setup(say("Hola, soy el asistente de la clinica."))
    out = server.handle_direct(ev("", md={"postbackPayload": "GET_STARTED"}))
    assert out.startswith("Hola, soy el asistente") and ag.handoffs == [] and len(mdl.systems) == 1


@test
def una_foto_avisa_a_una_persona_con_el_canal_y_no_llama_al_modelo():
    ag, z, mdl = setup()
    out = server.handle_direct(ev("", "instagram", IGSID, atts=[{"type": "image", "url": "https://cdn/x.jpg"}]))
    assert out == server.MEDIA_OK and mdl.systems == []
    assert len(ag.handoffs) == 1 and ag.handoffs[0]["canal"] == "instagram" and "image" in ag.handoffs[0]["detail"]


@test
def compartir_una_publicacion_o_un_sticker_solo_no_contesta_ni_avisa():
    for kinds in (["share"], ["sticker"], ["share", "sticker"]):
        ag, z, mdl = setup()
        assert server.handle_direct(ev("", "instagram", IGSID, atts=[{"type": k} for k in kinds])) is None
        assert z.posts == [] and ag.handoffs == [] and mdl.systems == [], kinds


@test
def compartir_algo_junto_con_una_foto_si_cuenta():
    ag, z, _ = setup()
    server.handle_direct(ev("", atts=[{"type": "share"}, {"type": "image"}]))
    assert len(ag.handoffs) == 1


@test
def una_vez_por_conversacion_y_causa_en_cada_canal():
    ag, z, _ = setup(say("Claro."), say("Claro."))
    server.handle_direct(ev("Quiero hablar con un humano", eid="e1"))
    server.handle_direct(ev("Hola?? quiero hablar con una persona", eid="e2"))
    assert len(ag.handoffs) == 1 and len(z.posts) == 2


@test
def conversaciones_de_distintos_canales_no_se_mezclan():
    ag, z, _ = setup(say("Claro."), say("Claro."))
    server.handle_direct(ev("Quiero hablar con un humano", "facebook", conv="fb-1"))
    server.handle_direct(ev("Quiero hablar con un humano", "instagram", IGSID, conv="ig-1", eid="e2"))
    assert sorted((h["conv"], h["canal"]) for h in ag.handoffs) == [("fb-1", "facebook"), ("ig-1", "instagram")]


# ---------------------------------------------------------------- modo cola (poller)
class QClient:
    def __init__(self, sw): self.sw, self.acks, self.hand, self.asked = sw, [], [], []
    def bot_active(self, canal="whatsapp"): self.asked.append(canal); return self.sw.get(canal, False)
    def ack(self, eid, outcome): self.acks.append((eid, outcome))
    def fail(self, *a, **k): self.acks.append(("fail", a))
    def handoff(self, conv, reason, telefono=None, detail=None, canal=None, contacto_id=None): self.hand.append((conv, telefono, canal, contacto_id))


@test
def el_poller_respeta_el_interruptor_de_cada_canal():
    c = QClient({"whatsapp": True, "facebook": False, "instagram": True}); sent = []
    p = poller.Processor(c, lambda payload: sent.append(payload["message"]["platform"]) or "ok", "FALLBACK", log=lambda *a: None)
    p.platforms = {"whatsapp", "facebook", "instagram"}
    for i, plat in enumerate(("whatsapp", "facebook", "instagram", "telegram")):
        p.process({"id": i, "payload": ev("hola", plat)})
    assert sent == ["whatsapp", "instagram"]
    assert dict(c.acks) == {0: "replied", 1: "skipped_bot_inactive", 2: "replied", 3: "skipped_ignored"}


@test
def el_poller_por_defecto_solo_atiende_whatsapp():
    c = QClient({"whatsapp": True, "facebook": True}); sent = []
    p = poller.Processor(c, lambda payload: sent.append(1) or "ok", "FALLBACK", log=lambda *a: None)
    p.process({"id": 1, "payload": ev("hola", "facebook")})
    assert sent == [] and c.acks == [(1, "skipped_ignored")]


@test
def el_poller_avisa_a_una_persona_con_canal_si_el_bot_manda_el_respaldo():
    c = QClient({"facebook": True})
    p = poller.Processor(c, lambda payload: "FALLBACK", "FALLBACK", log=lambda *a: None); p.platforms = {"facebook"}
    p.process({"id": 1, "payload": ev("hola", "facebook")})
    assert c.hand == [("c1", None, "facebook", PSID)]


if __name__ == "__main__":
    bad = 0
    for t in tests:
        try:
            t(); print("OK  ", t.__name__)
        except Exception as e:
            import traceback
            bad += 1; print("FAIL", t.__name__, "->", repr(e)[:300]); traceback.print_exc(limit=-2)
    print(f"\n{len(tests) - bad}/{len(tests)} pruebas pasaron")
    sys.exit(1 if bad else 0)
