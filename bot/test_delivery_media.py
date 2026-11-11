"""Pruebas: envio fallido por Zernio, avisos duplicados y mensajes sin texto. Sin red: Zernio, API y modelo simulados.
Ejecutar:  /opt/venv/bin/python test_delivery_media.py
"""
import json, os, sys, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.update(ZERNIO_API_KEY="x", WATHSBOT_BACKEND="api", CLINICA_API_URL="http://x", CLINICA_BOT_TOKEN="x")
import server, api_client
from test_handoff import FakeAgenda

server.RETRY_SLEEP = 0
PHONE = "529990000001"


class FakeZernio:
    """Registra los envios. `plan` = lista de resultados por intento: 'ok', 500, 400, 429, 'net'."""
    def __init__(self, plan=("ok",)):
        self.plan, self.posts = list(plan), []

    def __call__(self, method, path, body=None, headers=None):
        if method == "GET":
            return {"messages": []}
        step = self.plan.pop(0) if len(self.plan) > 1 else self.plan[0]
        self.posts.append({"path": path, "body": body, "key": (headers or {}).get("Idempotency-Key"), "step": step})
        if step == "ok":
            return {"success": True}
        if step == "net":
            raise urllib.error.URLError("sin red")
        raise urllib.error.HTTPError("http://z", step, "err", {}, None)


class Model:
    def __init__(self, *replies):
        self.it, self.calls = iter(replies), []

    def __call__(self, system, messages):
        self.calls.append(messages)
        return json.dumps(next(self.it))


def ev(text="", atts=None, eid="evt-1", conv="conv-1"):
    m = {"conversationId": conv, "text": text, "attachments": atts or [], "platform": "whatsapp", "direction": "incoming", "sender": {"id": PHONE}}
    return {"id": eid, "message": m, "account": {"accountId": "acc-1"}, "conversation": {}}


def setup(plan=("ok",), fail_handoff=False, active=True, model=()):
    server._HANDOFF_SEEN.clear()
    server._CONV_LOCKS.clear()
    ag = FakeAgenda(fail_handoff, active)
    server._AGENDA = ag
    z = FakeZernio(plan)
    server.zernio = z
    mdl = Model(*model)
    server.llm = mdl
    return ag, z, mdl


tests = []
def test(f):
    tests.append(f); return f


OKREPLY = {"reply": "Hola, en que te ayudo?", "action": None}


# ---------------------------------------------------------------- 1. envio fallido
@test
def envio_ok_no_registra_nada():
    ag, z, _ = setup(model=[OKREPLY])
    server.handle_direct(ev("Hola"))
    assert len(z.posts) == 1 and ag.handoffs == []


@test
def envio_que_falla_siempre_avisa_a_una_persona_tras_3_intentos():
    ag, z, _ = setup(plan=(500,), model=[OKREPLY])
    server.handle_direct(ev("Hola"))
    assert len(z.posts) == 3, len(z.posts)
    assert len(ag.handoffs) == 1 and ag.handoffs[0][1] == "otro" and "no la recibio" in ag.handoffs[0][3]


@test
def los_reintentos_usan_la_misma_idempotency_key():
    _, z, _ = setup(plan=(500, "net", "ok"), model=[OKREPLY])
    server.handle_direct(ev("Hola"))
    keys = {p["key"] for p in z.posts}
    assert len(z.posts) == 3 and len(keys) == 1 and None not in keys, z.posts


@test
def un_fallo_transitorio_se_recupera_sin_avisar():
    ag, z, _ = setup(plan=(500, "ok"), model=[OKREPLY])
    server.handle_direct(ev("Hola"))
    assert len(z.posts) == 2 and ag.handoffs == []


@test
def un_4xx_no_se_reintenta_pero_si_se_avisa():
    ag, z, _ = setup(plan=(400,), model=[OKREPLY])
    server.handle_direct(ev("Hola"))
    assert len(z.posts) == 1 and len(ag.handoffs) == 1


@test
def un_429_si_se_reintenta():
    ag, z, _ = setup(plan=(429, "ok"), model=[OKREPLY])
    server.handle_direct(ev("Hola"))
    assert len(z.posts) == 2 and ag.handoffs == []


@test
def envio_fallido_y_api_de_clinica_caida_no_rompe_el_servicio():
    ag, z, _ = setup(plan=(500,), fail_handoff=True, model=[OKREPLY])
    server.handle_direct(ev("Hola"))  # no debe lanzar
    assert ag.handoffs == []


# ---------------------------------------------------------------- 2. avisos duplicados
@test
def dos_mensajes_seguidos_pidiendo_humano_abren_un_solo_caso():
    ag, z, _ = setup(model=[{"reply": "Claro.", "action": None}] * 2)
    server.handle_direct(ev("Quiero hablar con un humano", eid="e1"))
    server.handle_direct(ev("Hola?? quiero hablar con una persona", eid="e2"))
    assert len(ag.handoffs) == 1, ag.handoffs
    assert len(z.posts) == 2  # ambos mensajes se contestan


@test
def causas_distintas_no_se_confunden():
    ag, z, _ = setup(model=[{"reply": "Claro.", "action": None}] * 2)
    server.handle_direct(ev("Quiero hablar con un humano", eid="e1"))
    server.handle_direct(ev("", [{"type": "image"}], eid="e2"))
    assert sorted(h[3] and h[1] for h in ag.handoffs) == ["otro", "pidio_persona"], ag.handoffs


@test
def conversaciones_distintas_no_se_confunden():
    ag, _, _ = setup(model=[{"reply": "Claro.", "action": None}] * 2)
    server.handle_direct(ev("Quiero hablar con un humano", eid="e1", conv="c1"))
    server.handle_direct(ev("Quiero hablar con un humano", eid="e2", conv="c2"))
    assert len(ag.handoffs) == 2


@test
def pasada_la_ventana_se_vuelve_a_avisar():
    ag, _, _ = setup(model=[{"reply": "Claro.", "action": None}] * 2)
    server.handle_direct(ev("Quiero hablar con un humano", eid="e1"))
    for k in list(server._HANDOFF_SEEN):
        server._HANDOFF_SEEN[k] -= server.HANDOFF_DEDUP_S + 5
    server.handle_direct(ev("Sigo esperando, quiero hablar con un humano", eid="e2"))
    assert len(ag.handoffs) == 2


@test
def un_registro_fallido_no_se_recuerda_y_se_reintenta_en_el_siguiente_mensaje():
    ag, _, _ = setup(fail_handoff=True, model=[{"reply": "Claro.", "action": None}] * 2)
    server.handle_direct(ev("Quiero hablar con un humano", eid="e1"))
    assert server._HANDOFF_SEEN == {}
    ag.fail = False
    server.handle_direct(ev("Quiero hablar con un humano", eid="e2"))
    assert len(ag.handoffs) == 1


# ---------------------------------------------------------------- 3. mensajes sin texto
@test
def foto_sin_texto_avisa_y_no_llama_al_modelo():
    ag, z, mdl = setup()  # sin respuestas de modelo: si lo llamara, fallaria
    out = server.handle_direct(ev("", [{"type": "image", "url": "http://z/media/1"}]))
    assert out == server.MEDIA_OK and mdl.calls == []
    assert len(ag.handoffs) == 1 and ag.handoffs[0][1] == "otro" and "image" in ag.handoffs[0][3]
    assert z.posts[0]["body"]["message"] == server.MEDIA_OK


@test
def audio_y_documento_se_nombran_en_el_aviso():
    ag, _, _ = setup()
    server.handle_direct(ev("", [{"type": "audio"}, {"type": "file"}, {"type": "audio"}]))
    assert "audio, file" in ag.handoffs[0][3]


@test
def si_el_aviso_falla_no_se_promete_nada():
    ag, z, _ = setup(fail_handoff=True)
    out = server.handle_direct(ev("", [{"type": "image"}]))
    assert out == server.MEDIA_FAIL and "no pude avisar" in out and ag.handoffs == []


@test
def foto_con_texto_el_modelo_contesta_el_texto_y_sabe_del_adjunto():
    ag, z, mdl = setup(model=[{"reply": "Gracias, un miembro del equipo revisara tu archivo.", "action": None}])
    out = server.handle_direct(ev("Esta es mi receta", [{"type": "image"}]))
    assert len(ag.handoffs) == 1 and len(mdl.calls) == 1
    seen = mdl.calls[0][-1]["content"]
    assert "Esta es mi receta" in seen and "image" in seen and "ya fue avisado" in seen
    assert "revisara" in out


@test
def foto_con_texto_y_aviso_fallido_el_modelo_lo_sabe():
    ag, _, mdl = setup(fail_handoff=True, model=[{"reply": "No pude registrar tu archivo, vuelve a escribir.", "action": None}])
    server.handle_direct(ev("Esta es mi receta", [{"type": "image"}]))
    assert "NO se pudo avisar" in mdl.calls[0][-1]["content"]


@test
def solo_un_sticker_no_contesta_ni_avisa():
    ag, z, mdl = setup()
    out = server.handle_direct(ev("", [{"type": "sticker"}]))
    assert out is None and z.posts == [] and ag.handoffs == [] and mdl.calls == []


@test
def sticker_con_otro_adjunto_si_cuenta():
    ag, _, _ = setup()
    server.handle_direct(ev("", [{"type": "sticker"}, {"type": "image"}]))
    assert len(ag.handoffs) == 1


@test
def mensaje_sin_texto_ni_adjuntos_ubicacion_o_contacto_tambien_avisa():
    ag, _, mdl = setup()
    out = server.handle_direct(ev("", []))
    assert out == server.MEDIA_OK and len(ag.handoffs) == 1 and "contenido sin texto" in ag.handoffs[0][3] and mdl.calls == []


@test
def bot_apagado_no_contesta_ni_avisa_por_un_adjunto():
    ag, z, _ = setup(active=False)
    out = server.handle_direct(ev("", [{"type": "image"}]))
    assert out is None and z.posts == [] and ag.handoffs == []


@test
def varias_fotos_seguidas_abren_un_solo_caso():
    ag, z, _ = setup()
    for i in range(4):
        server.handle_direct(ev("", [{"type": "image"}], eid=f"e{i}"))
    assert len(ag.handoffs) == 1 and len(z.posts) == 4


@test
def un_mensaje_normal_sigue_igual():
    ag, z, mdl = setup(model=[OKREPLY])
    out = server.handle_direct(ev("Hola buenas tardes"))
    assert out == OKREPLY["reply"] and ag.handoffs == [] and len(mdl.calls) == 1


if __name__ == "__main__":
    bad = 0
    for t in tests:
        try:
            t(); print("OK  ", t.__name__)
        except Exception as e:
            bad += 1; print("FAIL", t.__name__, "->", repr(e)[:300])
    print(f"\n{len(tests) - bad}/{len(tests)} pruebas pasaron")
    sys.exit(1 if bad else 0)
