#!/usr/bin/env python3
"""Wathsbot: receives Zernio message.received webhooks and auto-replies on WhatsApp."""
import hashlib, hmac, json, os, sys, threading, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = "https://zernio.com/api/v1"
ZKEY = os.environ["ZERNIO_API_KEY"]
SECRET = os.environ.get("WATHSBOT_WEBHOOK_SECRET", "")
DRY_RUN = os.environ.get("WATHSBOT_DRY_RUN") == "1"
PORT = int(os.environ.get("WATHSBOT_PORT", "8787"))
HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM = open(os.path.join(HERE, "system_prompt.md"), encoding="utf-8").read()
SEEN, GREETED, LOCK = set(), set(), threading.Lock()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def http(method, url, headers, body=None, timeout=40):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def zernio(method, path, body=None):
    h = {"Authorization": f"Bearer {ZKEY}", "Content-Type": "application/json"}
    return http(method, BASE + path, h, body)


def llm_cli(system, messages):
    """Same Claude subscription as the Hermes chat, via the claude CLI with NO tools."""
    import subprocess, tempfile
    convo = "\n".join(("Paciente: " if m["role"] == "user" else "Wathsbot: ") + m["content"] for m in messages)
    prompt = ("Conversacion hasta ahora:\n" + convo +
              "\n\nEscribe SOLO la siguiente respuesta de Wathsbot (texto a enviar por WhatsApp).")
    with tempfile.TemporaryDirectory() as d:
        r = subprocess.run([os.environ.get("CLAUDE_BIN", "/data/.local/bin/claude"), "-p", "--model", os.environ.get("WATHSBOT_MODEL", "sonnet"),
                            "--tools", "", "--system-prompt", system, prompt],
                           capture_output=True, text=True, timeout=90, cwd=d)
    out = r.stdout.strip()
    if r.returncode != 0 or not out:
        raise RuntimeError("claude CLI failed: " + (r.stderr or out)[:200])
    return out


def llm(system, messages):
    if os.environ.get("WATHSBOT_LLM", "cli") == "cli":
        return llm_cli(system, messages)
    if os.environ.get("ANTHROPIC_API_KEY"):
        r = http("POST", "https://api.anthropic.com/v1/messages",
                 {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
                  "content-type": "application/json"},
                 {"model": os.environ.get("WATHSBOT_MODEL", "claude-haiku-4-5"), "max_tokens": 400,
                  "system": system, "messages": messages})
        return r["content"][0]["text"].strip()
    if os.environ.get("OPENROUTER_API_KEY"):
        r = http("POST", "https://openrouter.ai/api/v1/chat/completions",
                 {"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"], "Content-Type": "application/json"},
                 {"model": os.environ.get("WATHSBOT_MODEL", "anthropic/claude-haiku-4.5"), "max_tokens": 400,
                  "messages": [{"role": "system", "content": system}] + messages})
        return r["choices"][0]["message"]["content"].strip()
    raise RuntimeError("No ANTHROPIC_API_KEY or OPENROUTER_API_KEY configured")


def history(conv_id, account_id):
    """Best-effort recent history as alternating user/assistant messages."""
    try:
        r = zernio("GET", f"/inbox/conversations/{conv_id}/messages?accountId={account_id}&limit=12&sortOrder=desc")
        items = r.get("messages") or r.get("data") or []
        out = []
        for m in reversed(items):
            t = m.get("text") or m.get("message")
            if not t:
                continue
            role = "user" if m.get("direction") == "incoming" else "assistant"
            if out and out[-1]["role"] == role:
                out[-1]["content"] += "\n" + t
            else:
                out.append({"role": role, "content": t})
        return out
    except Exception as e:
        log("history unavailable:", e)
        return []


def handle(ev):
    m, acc, conv = ev["message"], ev["account"], ev["conversation"]
    text = m.get("text") or ""
    if not text.strip():
        text = "[el paciente envio un archivo o contenido sin texto]"
    conv_id, account_id = m["conversationId"], acc["accountId"] if "accountId" in acc else acc.get("id")
    msgs = history(conv_id, account_id)
    if not msgs or msgs[-1]["role"] != "user" or text not in msgs[-1]["content"]:
        msgs.append({"role": "user", "content": text})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    sys_prompt = SYSTEM
    with LOCK:
        first = conv_id not in GREETED and len(msgs) <= 1
        GREETED.add(conv_id)
    if first:
        sys_prompt += "\n\nEste es el PRIMER mensaje de la conversacion: aclara que eres un asistente automatico."
    phone = str((m.get("sender") or {}).get("id") or "").strip()
    if agenda_enabled() and phone.isdigit():
        reply = run_agent(sys_prompt, msgs, phone)
    else:
        sys_prompt += "\n\nResponde unicamente con el texto del mensaje a enviar."
        reply = llm(sys_prompt, msgs)
    log(f"conv={conv_id} IN: {text[:80]!r} -> OUT: {reply[:120]!r}")
    if DRY_RUN:
        return
    zernio("POST", f"/inbox/conversations/{conv_id}/messages", {"accountId": account_id, "message": reply})


# ---------------- agenda: el modelo propone, el codigo ejecuta ----------------
_AGENDA = None
FALLBACK = "Disculpa, tuve un problema para revisar la agenda. Un miembro del equipo se pondra en contacto contigo para ayudarte con tu cita."


def agenda_enabled():
    import scheduler
    return not any("PENDIENTE" in c for c in scheduler.CFG["consultorios"].values())


def get_agenda():
    global _AGENDA
    if _AGENDA is None:
        import scheduler
        _AGENDA = scheduler.Agenda(scheduler.GoogleBackend())
    return _AGENDA


def agenda_prompt():
    import scheduler as S
    docs = "\n".join(f"- {d['label']}: {d['name']}" for d in S.CFG["doctors"].values())
    n = S.now()
    dias = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
    return f"""

## AGENDA AUTOMATICA (esta seccion tiene prioridad sobre "Ayudar a agendar")
Ahora puedes agendar, consultar, reprogramar y cancelar citas TU MISMO usando acciones. Hoy es {dias[n.weekday()]} {n.date().isoformat()}, hora local {n.strftime('%H:%M')} (zona {S.CFG['timezone']}). Citas de {S.CFG['slot_minutes']} minutos.
Doctores:
{docs}

FORMATO DE SALIDA (obligatorio): responde SIEMPRE un unico objeto JSON y nada mas:
{{"reply": "texto para el paciente o null", "action": null o {{"name": ...}}}}
Acciones (una por turno):
- {{"name":"horarios","especialidad":"...","desde":"AAAA-MM-DD","hora_min":13,"hora_max":18,"dias":7}}  -> consulta huecos libres reales. desde, hora_min, hora_max (hora local, 24h) y dias son opcionales. Por defecto devuelve pocos horarios, solo los primeros de cada dia: NO es la lista completa.
- {{"name":"agendar","especialidad":"...","nombre":"Nombre Apellido","inicio":"AAAA-MM-DDTHH:MM"}}
- {{"name":"cercanos","especialidad":"...","fecha_hora":"AAAA-MM-DDTHH:MM"}}  -> cuando el paciente pide un dia y hora concretos: devuelve "exacto" (true si ese horario esta libre) y los 3 huecos libres mas cercanos
- {{"name":"mis_citas"}}
- {{"name":"cancelar","event_id":"..."}}
- {{"name":"reprogramar","event_id":"...","inicio":"AAAA-MM-DDTHH:MM"}}
Si usas una accion, pon reply en null: veras el RESULTADO y entonces redactas la respuesta final con action null.

REGLAS DE AGENDA (obligatorias):
0. FLUJO PARA AGENDAR: primero pregunta al paciente que dia y horario le acomoda (no le des una lista de entrada). Con un dia y hora concretos usa "cercanos": si "exacto" es true, propon ese horario y pide confirmacion; si es false, di que ese horario no esta libre y ofrece los horarios que devolvio (los mas cercanos). Si el paciente dice "cualquier dia", "lo mas pronto" o no sabe, usa "horarios" y ofrece 2 o 3. Si la peticion es ambigua (ej. "la proxima semana", "en la tarde") pregunta un dia concreto o usa "horarios" con el rango, sin suponer una hora exacta.
0b. LIMITES: solo se agenda con al menos {S.CFG['min_notice_minutes']} minutos de antelacion y hasta {S.CFG['horizon_days']} dias a futuro (hasta el {(n + __import__('datetime').timedelta(days=S.CFG['horizon_days'])).date().isoformat()}). Nunca prometas ni intentes agendar fuera de ese rango; explica el limite con amabilidad y ofrece una fecha valida.
1. NUNCA inventes ni supongas horarios: ofrece solo los que devuelva "horarios". Ofrece 2 o 3 y espera que el paciente elija uno.
1b. Si el paciente pide una preferencia (tarde, despues del mediodia, manana temprano, otro dia, un dia concreto, una hora concreta), VUELVE A CONSULTAR "horarios" con hora_min/hora_max/desde que correspondan. NUNCA digas que no hay disponibilidad sin haberlo consultado con ese criterio: la lista anterior es solo una muestra parcial. "Mediodia/tarde" = hora_min 12; "manana" (parte del dia) = hora_max 12. Si el resultado trae "nota" o horarios vacios, entonces si dilo y ofrece ampliar (otros dias).
2. Solo ejecuta "agendar" cuando tengas: especialidad, nombre completo y un horario que el paciente eligio de forma explicita. Si falta algo, pregunta.
3. Para cancelar o reprogramar, usa primero "mis_citas" y confirma con el paciente cual cita es. Solo existen las citas del propio paciente; nunca hables de citas de otras personas.
4. Tras agendar, confirma doctor, especialidad, dia, hora y consultorio EXACTAMENTE como los devuelve el RESULTADO. Si el RESULTADO es un error, explica sin tecnicismos y ofrece otro horario (consulta "horarios" de nuevo).
5. No guardes ni pidas sintomas o motivos medicos; solo nombre, especialidad y horario.
6. Si la especialidad no esta en la lista, di que no la ofrecemos por este medio y que el equipo confirmara. Si la agenda falla, di que el equipo se pondra en contacto.
7. Escribe fechas en espanol natural (ej. "martes 11 de noviembre a las 10:00"), nunca en formato ISO.
"""


def run_action(act, phone):
    import scheduler as S
    ag = get_agenda()
    n = act.get("name")
    if n == "horarios":
        d = None
        if act.get("desde"):
            d = S.parse_dt(act["desde"] + ("T00:00" if len(act["desde"]) == 10 else "")).date()
        def hr(x):
            try:
                return float(x)
            except Exception:
                return None
        return ag.free_slots(act.get("especialidad", ""), from_day=d, hora_min=hr(act.get("hora_min")), hora_max=hr(act.get("hora_max")),
                             days=int(act.get("dias") or 7), limit=6)
    if n == "cercanos":
        return ag.nearest(act.get("especialidad", ""), S.parse_dt(act["fecha_hora"]))
    if n == "agendar":
        return ag.book(phone, (act.get("nombre") or "").strip(), act.get("especialidad", ""), S.parse_dt(act["inicio"]))
    if n == "mis_citas":
        return {"citas": ag.mine(phone)}
    if n == "cancelar":
        return ag.cancel(phone, act.get("event_id", ""))
    if n == "reprogramar":
        return ag.reschedule(phone, act.get("event_id", ""), S.parse_dt(act["inicio"]))
    return {"error": "accion_desconocida"}


def parse_model_json(s):
    a, b = s.find("{"), s.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        return json.loads(s[a:b + 1])
    except Exception:
        return None


def run_agent(sys_prompt, msgs, phone, max_steps=4):
    sys_prompt += agenda_prompt()
    msgs = list(msgs)
    for _ in range(max_steps):
        raw = llm(sys_prompt, msgs)
        data = parse_model_json(raw)
        if data is None:
            # el modelo respondio texto plano: es seguro enviarlo solo si no parece JSON
            return raw if not raw.lstrip().startswith(("{", "[")) else FALLBACK
        act = data.get("action")
        if not act:
            return (data.get("reply") or "").strip() or FALLBACK
        try:
            res = run_action(act, phone)
        except Exception as e:
            log("action error:", repr(e))
            res = {"error": "agenda_no_disponible"}
        log(f"ACTION {act.get('name')} -> {json.dumps(res, ensure_ascii=False)[:160]}")
        msgs.append({"role": "assistant", "content": json.dumps(data, ensure_ascii=False)})
        msgs.append({"role": "user", "content": "RESULTADO (sistema, no es el paciente): " + json.dumps(res, ensure_ascii=False)})
    return FALLBACK


def valid_sig(raw, headers):
    if not SECRET:
        return False
    want = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    for k, v in headers.items():
        if "signature" in k.lower() or k.lower() in ("x-zernio-secret", "x-webhook-secret"):
            if hmac.compare_digest(v.replace("sha256=", "").strip().lower(), want):
                return True
    return False


class H(BaseHTTPRequestHandler):
    def _send(self, code, body=b"ok"):
        self.send_response(code); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        self._send(200, b'{"status":"ok"}')

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not valid_sig(raw, dict(self.headers)):
            log("REJECTED bad/missing signature; headers:", [k for k in self.headers.keys()])
            return self._send(401, b"bad signature")
        self._send(200)
        try:
            ev = json.loads(raw)
            if ev.get("event") != "message.received" or ev.get("test"):
                if ev.get("test"):
                    log("test event received OK")
                return
            m = ev["message"]
            if m.get("platform") != "whatsapp" or m.get("direction") != "incoming":
                return
            if (m.get("metadata") or {}).get("standby"):
                return
            with LOCK:
                if ev["id"] in SEEN:
                    return
                SEEN.add(ev["id"])
            threading.Thread(target=self._safe, args=(ev,), daemon=True).start()
        except Exception as e:
            log("error parsing:", e)

    def _safe(self, ev):
        try:
            handle(ev)
        except Exception as e:
            log("handler error:", repr(e))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    log(f"Wathsbot listening on :{PORT} dry_run={DRY_RUN} secret={'set' if SECRET else 'MISSING'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
