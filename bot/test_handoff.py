"""Pruebas del traspaso a una persona. Sin red: API y modelo simulados.
Ejecutar:  python test_handoff.py   (con /opt/venv/bin/python)
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.update(ZERNIO_API_KEY="x", WATHSBOT_BACKEND="api", CLINICA_API_URL="http://x", CLINICA_BOT_TOKEN="x")
import server, api_client

HOURS = {d: [{"start": "09:00", "end": "18:00"}] for d in ("mon", "tue", "wed", "thu", "fri")}


class FakeAgenda:
    def __init__(self, fail_handoff=False, active=True):
        self.handoffs, self.fail, self.active = [], fail_handoff, active

    def config(self):
        return {"timezone": "America/Cancun", "slotMinutes": 30, "minNoticeMinutes": 60, "horizonDays": 60, "clinicHours": HOURS,
                "doctors": [{"name": "Dr. Cervantes", "specialty": "Proctologia", "usesClinicHours": True}]}

    def bot_active(self):
        return self.active

    def handoff(self, conv, reason, telefono=None, detail=None):
        if self.fail:
            raise api_client.ApiUnavailable("API caida")
        self.handoffs.append((conv, reason, telefono, detail))

    def mine(self, phone):
        return []


def script(*replies):
    """Modelo simulado: devuelve las respuestas en orden (cada una es un dict JSON del bot)."""
    it = iter(replies)
    server.llm = lambda system, messages: json.dumps(next(it))


def run(user_text, *model_replies, fail=False, active=True, first=False):
    server._HANDOFF_SEEN.clear()
    ag = FakeAgenda(fail, active)
    server._AGENDA = ag
    script(*model_replies)
    out = server.reply_for([{"role": "user", "content": user_text}], "529990000001", "conv-1", first)
    return ag, out


tests = []
def test(f):
    tests.append(f); return f


@test
def accion_explicita_registra_una_sola_vez():
    ag, out = run("Quiero hablar con un humano",
                  {"reply": None, "action": {"name": "pasar_a_persona", "motivo": "pidio_persona", "detalle": "quiere hablar con alguien"}},
                  {"reply": "Listo, avise a un miembro del equipo.", "action": None})
    assert len(ag.handoffs) == 1, ag.handoffs
    assert ag.handoffs[0][1] == "pidio_persona" and ag.handoffs[0][2] == "529990000001" and ag.handoffs[0][0] == "conv-1"
    assert "avise" in out


@test
def el_caso_real_el_modelo_promete_sin_usar_la_accion():
    # lo que paso: el paciente pide un humano y el modelo solo escribe "voy a avisar"
    ag, out = run("Quiero hablar con un humano", {"reply": "Claro. Voy a avisar a un miembro del equipo para que se ponga en contacto contigo.", "action": None})
    assert len(ag.handoffs) == 1 and ag.handoffs[0][1] == "pidio_persona", ag.handoffs
    assert "Voy a avisar" in out


@test
def promesa_del_modelo_sin_peticion_del_paciente_tambien_se_registra():
    ag, out = run("Cuanto cuesta la consulta de reumatologia?", {"reply": "No tengo ese precio; un miembro del equipo se pondra en contacto contigo.", "action": None})
    assert len(ag.handoffs) == 1 and ag.handoffs[0][1] == "fuera_de_alcance", ag.handoffs


@test
def si_el_registro_falla_no_se_promete_un_aviso_falso():
    ag, out = run("Quiero hablar con una persona", {"reply": "Claro, voy a avisar al equipo.", "action": None}, fail=True)
    assert ag.handoffs == []
    assert out == server.NO_NOTIFY and "avisar al equipo" not in out.lower().replace("intente avisar", "")


@test
def accion_que_falla_el_modelo_recibe_el_error_y_no_promete():
    ag, out = run("Quiero hablar con un humano",
                  {"reply": None, "action": {"name": "pasar_a_persona", "motivo": "pidio_persona"}},
                  {"reply": "No pude registrar tu solicitud, vuelve a escribir en unos minutos.", "action": None}, fail=True)
    assert ag.handoffs == [] and "No pude registrar" in out


@test
def conversacion_normal_no_genera_traspaso():
    for text, reply in [("Hola", "Hola, soy Wathsbot. En que te ayudo?"),
                        ("Quiero agendar con el proctologo", "Con gusto. Que dia te acomoda?"),
                        ("Gracias, hasta luego", "Con gusto. Que tengas buen dia.")]:
        ag, out = run(text, {"reply": reply, "action": None})
        assert ag.handoffs == [], (text, ag.handoffs)
        assert out == reply


@test
def distintas_formas_de_pedir_una_persona():
    for t in ["quiero hablar con un humano", "Pasame con una persona por favor", "necesito un asesor humano", "me comunicas con la recepcionista?",
              "quiero hablar con alguien del equipo", "Quiero hablar con un humano", "NECESITO HABLAR CON UNA PERSONA REAL"]:
        ag, _ = run(t, {"reply": "Claro.", "action": None})
        assert len(ag.handoffs) == 1, t


@test
def falsos_positivos_comunes_no_registran():
    for t in ["Quiero una cita para mi mama que es una persona mayor", "Soy un ser humano normal y quiero agendar", "Cual es el horario?"]:
        ag, _ = run(t, {"reply": "Claro, en que horario?", "action": None})
        assert ag.handoffs == [], (t, ag.handoffs)


@test
def mensaje_de_respaldo_registra_una_sola_vez():
    ag, out = run("Hola", {"reply": server.FALLBACK, "action": None})
    assert out == server.FALLBACK and len(ag.handoffs) == 1, ag.handoffs


@test
def bot_apagado_no_contesta_ni_registra():
    ag, out = run("Quiero hablar con un humano", {"reply": "x", "action": None}, active=False)
    assert out is None and ag.handoffs == []


@test
def el_estado_del_turno_no_se_arrastra_a_otro_mensaje():
    ag, _ = run("Quiero hablar con un humano", {"reply": None, "action": {"name": "pasar_a_persona", "motivo": "pidio_persona"}}, {"reply": "ok", "action": None})
    assert len(ag.handoffs) == 1
    ag2, _ = run("Quiero hablar con un humano otra vez", {"reply": "Claro.", "action": None})
    assert len(ag2.handoffs) == 1  # un mensaje nuevo vuelve a registrarse


@test
def si_la_accion_falla_pero_el_modelo_promete_igual_se_corrige():
    ag, out = run("Quiero hablar con un humano",
                  {"reply": None, "action": {"name": "pasar_a_persona", "motivo": "pidio_persona"}},
                  {"reply": "Listo, voy a avisar al equipo.", "action": None}, fail=True)
    assert ag.handoffs == [] and out == server.NO_NOTIFY


@test
def motivo_invalido_del_modelo_se_normaliza():
    ag, _ = run("Hola", {"reply": None, "action": {"name": "pasar_a_persona", "motivo": "inventado"}}, {"reply": "ok", "action": None})
    assert ag.handoffs[0][1] == "otro"


@test
def el_prompt_incluye_la_accion_y_las_reglas():
    p = server.agenda_prompt(server._prompt_ctx())
    assert "pasar_a_persona" in p and "TRASPASO A UNA PERSONA" in p and "NUNCA afirmes que el paciente tiene una cita" in p


if __name__ == "__main__":
    bad = 0
    for t in tests:
        try:
            t(); print("OK  ", t.__name__)
        except Exception as e:
            bad += 1; print("FAIL", t.__name__, "->", repr(e)[:300])
    print(f"\n{len(tests) - bad}/{len(tests)} pruebas pasaron")
    sys.exit(1 if bad else 0)
