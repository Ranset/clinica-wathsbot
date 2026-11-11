#!/usr/bin/env python3
"""Wathsbot: receives Zernio message.received webhooks and auto-replies on WhatsApp."""
import hashlib, hmac, json, os, sys, threading, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import clinic_info

BASE = "https://zernio.com/api/v1"
ZKEY = os.environ["ZERNIO_API_KEY"]
SECRET = os.environ.get("WATHSBOT_WEBHOOK_SECRET", "")
DRY_RUN = os.environ.get("WATHSBOT_DRY_RUN") == "1"
# De donde sale la agenda:
#   "google" (defecto, el bot de antes: Google Calendar via scheduler.py) o
#   "api"    (la API de la clinica: el bot trabaja como un empleado mas; doctores, horarios, citas, interruptor).
BACKEND = os.environ.get("WATHSBOT_BACKEND", "google")
# Por donde llegan los mensajes (solo importa con BACKEND=api):
#   "webhook" (defecto) Zernio -> este proceso (WATHSBOT_PORT); es como ya funciona el bot en produccion.
#   "queue"             Zernio -> servidor de la clinica -> cola; la consulta `poller.py` (no abre puerto).
INGRESS = os.environ.get("WATHSBOT_INGRESS", "webhook")
PORT = int(os.environ.get("WATHSBOT_PORT", "8787"))
HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM = open(os.path.join(HERE, "system_prompt.md"), encoding="utf-8").read()
SEEN, GREETED, LOCK = set(), set(), threading.Lock()
_CONV_LOCKS = {}  # un candado por conversacion: dos mensajes seguidos del mismo paciente se atienden de uno en uno


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
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90, cwd=d)
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


def _prepare(ev):
    """Evento de Zernio -> (texto, conversacion, cuenta, telefono, historial, primer_mensaje)."""
    m, acc = ev["message"], ev["account"]
    text = m.get("text") or ""
    if not text.strip():
        text = "[el paciente envio un archivo o contenido sin texto]"
    conv_id, account_id = m["conversationId"], acc["accountId"] if "accountId" in acc else acc.get("id")
    msgs = history(conv_id, account_id)
    if not msgs or msgs[-1]["role"] != "user" or text not in msgs[-1]["content"]:
        msgs.append({"role": "user", "content": text})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    with LOCK:
        first = conv_id not in GREETED and len(msgs) <= 1
        GREETED.add(conv_id)
    phone = str((m.get("sender") or {}).get("id") or "").strip()
    return text, conv_id, account_id, phone, msgs, first


def answer(msgs, phone, first=False):
    """Nucleo del bot: historial (termina con el mensaje del paciente) -> texto a enviar. NO envia nada.
    Con BACKEND=api toma doctores, horarios y limites de la API en CADA mensaje (si no responde lanza ApiUnavailable:
    nunca se contesta con datos viejos)."""
    ctx = _prompt_ctx() if BACKEND == "api" else None
    sys_prompt = clinic_info.compose_system(SYSTEM, ctx.API) if ctx else SYSTEM
    if first:
        sys_prompt += "\n\nEste es el PRIMER mensaje de la conversacion: aclara que eres un asistente automatico."
    if agenda_enabled() and phone.isdigit():
        return run_agent(sys_prompt, msgs, phone, ctx=ctx)
    sys_prompt += "\n\nResponde unicamente con el texto del mensaje a enviar."
    return llm(sys_prompt, msgs)


def deliver(conv_id, account_id, reply):
    if not DRY_RUN:
        zernio("POST", f"/inbox/conversations/{conv_id}/messages", {"accountId": account_id, "message": reply})


def handle(ev):
    """Atiende un mensaje y lo envia. Lo usa `poller.py` (que ya revisa el interruptor y maneja los fallos de la API)."""
    text, conv_id, account_id, phone, msgs, first = _prepare(ev)
    reply = answer(msgs, phone, first)
    log(f"conv={conv_id} IN: {text[:80]!r} -> OUT: {reply[:120]!r}")
    deliver(conv_id, account_id, reply)
    return reply


def reply_for(msgs, phone, conv_id, first=False):
    """Decision completa del bot para un mensaje -> texto a enviar, o None si NO debe contestar.
    Con BACKEND=api: (1) consulta el interruptor en la API (apagado -> None: atiende una persona);
    (2) si la API no responde NO ofrece horarios de memoria: envia FALLBACK; (3) si termina en FALLBACK
    avisa a una persona (traspaso) para que no se pierda el caso."""
    if BACKEND != "api":
        return answer(msgs, phone, first)
    import api_client
    ag = get_agenda()
    reason = "otro"
    try:
        if not ag.bot_active():
            log(f"conv={conv_id} interruptor del bot APAGADO: no contesto")
            return None
        reply = answer(msgs, phone, first)
    except api_client.ApiUnavailable as e:
        log(f"conv={conv_id} la API de la clinica no responde ({e}): paso el caso a una persona")
        reply = FALLBACK
    except Exception as e:  # el modelo fallo (CLI caido, tiempo agotado...): mejor avisar que quedarse callado
        log(f"conv={conv_id} fallo el modelo: {e!r}: paso el caso a una persona")
        reply, reason = FALLBACK, "modelo_fallo"
    if reply == FALLBACK:
        try:
            ag.handoff(conv_id, reason, telefono=phone or None, detail="El bot envio el mensaje de respaldo")
        except api_client.ApiUnavailable as e:
            log(f"conv={conv_id} no se pudo registrar el traspaso a una persona: {e}")
    return reply


def handle_direct(ev):
    """Zernio -> este proceso (webhook directo): contesta con las reglas de `reply_for`."""
    text, conv_id, account_id, phone, msgs, first = _prepare(ev)
    with LOCK:
        lock = _CONV_LOCKS.setdefault(conv_id, threading.Lock())
    with lock:
        reply = reply_for(msgs, phone, conv_id, first)
    if reply is None:
        return None
    log(f"conv={conv_id} IN: {text[:80]!r} -> OUT: {reply[:120]!r}")
    deliver(conv_id, account_id, reply)
    return reply


# ---------------- agenda: el modelo propone, el codigo ejecuta ----------------
_AGENDA = None
FALLBACK = "Disculpa, tuve un problema para revisar la agenda. Un miembro del equipo se pondra en contacto contigo para ayudarte con tu cita."


def agenda_enabled():
    if BACKEND == "api":
        return True  # el interruptor del bot y la disponibilidad de la API los controla poller.py
    import scheduler
    return not any("PENDIENTE" in c for c in scheduler.CFG["consultorios"].values())


def get_agenda():
    global _AGENDA
    if _AGENDA is None:
        if BACKEND == "api":
            import api_client
            _AGENDA = api_client.ApiAgenda()
        else:
            import scheduler
            _AGENDA = scheduler.Agenda(scheduler.GoogleBackend())
    return _AGENDA


def _prompt_ctx():
    """Doctores y limites para el prompt: de la API (sin copia: si cae, lanza ApiUnavailable) o de scheduler.py.
    Devuelve algo con `.CFG` y `.now()` para no tocar el texto del prompt; con la API ademas `.API` (la respuesta
    cruda de /api/bot/config: horarios y doctores vigentes)."""
    if BACKEND != "api":
        import scheduler
        return scheduler
    from datetime import datetime
    from types import SimpleNamespace
    from zoneinfo import ZoneInfo
    c = get_agenda().config()
    tz = ZoneInfo(c["timezone"])
    cfg = {"timezone": c["timezone"], "slot_minutes": c["slotMinutes"], "min_notice_minutes": c["minNoticeMinutes"],
           "horizon_days": c["horizonDays"],
           # por nombre (no por especialidad): dos doctores de la misma especialidad no se pisan
           "doctors": {d["name"]: {"label": d["specialty"], "name": d["name"]} for d in c["doctors"]}}
    return SimpleNamespace(CFG=cfg, now=lambda: datetime.now(tz), API=c)


def agenda_prompt(S=None):
    S = S or _prompt_ctx()
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
2. Solo ejecuta "agendar" cuando tengas: especialidad, nombre completo y un horario que el paciente eligio de forma explicita. Si falta algo, pregunta. Si ofreciste varios horarios y el paciente responde solo "si", "ese", "confirmo" o "el primero que dijiste" sin que quede claro cual, NO agendes: pregunta cual de los horarios ofrecidos prefiere (repitelos). Nunca elijas tu por el paciente.
3. Para cancelar o reprogramar, usa primero "mis_citas" y confirma con el paciente cual cita es. Solo existen las citas del propio paciente; nunca hables de citas de otras personas.
4. Tras agendar, confirma doctor, especialidad, dia, hora y consultorio EXACTAMENTE como los devuelve el RESULTADO. Si el RESULTADO es un error, explica sin tecnicismos y ofrece otro horario (consulta "horarios" de nuevo).
5. No guardes ni pidas sintomas o motivos medicos; solo nombre, especialidad y horario.
6. Si la especialidad no esta en la lista, di que no la ofrecemos por este medio y que el equipo confirmara. Si la agenda falla, di que el equipo se pondra en contacto.
7. Escribe fechas en espanol natural (ej. "martes 11 de noviembre a las 10:00"), nunca en formato ISO.
"""


def run_action(act, phone):
    if BACKEND == "api":
        import api_client as S  # solo se usa S.parse_dt
    else:
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


def run_agent(sys_prompt, msgs, phone, max_steps=4, ctx=None):
    sys_prompt += agenda_prompt(ctx)
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
            handle_direct(ev)
        except Exception as e:
            log("handler error:", repr(e))

    def log_message(self, *a):
        pass


def startup_report():
    """Una linea que dice con que agenda trabaja el bot (y si la API responde AHORA). No tumba el arranque."""
    if BACKEND != "api":
        return "agenda=Google Calendar (scheduler.py)"
    import api_client
    try:
        ag = get_agenda()
        cfg, active = ag.config(), ag.bot_active()
        return (f"agenda=API {ag.base} OK | bot {'ACTIVO' if active else 'APAGADO (no contestara)'} | "
                f"{len(cfg['doctors'])} doctores | horario: {clinic_info.summarize_hours(cfg.get('clinicHours')) or '?'}")
    except api_client.ApiUnavailable as e:
        return f"agenda=API NO RESPONDE ({e}): hasta que responda el bot enviara el mensaje de respaldo"


if __name__ == "__main__":
    if BACKEND == "api" and INGRESS == "queue":
        sys.exit("Con WATHSBOT_INGRESS=queue el bot NO recibe webhooks (los recibe el servidor de la clinica y los "
                 "encola): ejecuta `python poller.py`.")
    log(f"Wathsbot listening on :{PORT} dry_run={DRY_RUN} secret={'set' if SECRET else 'MISSING'} "
        f"backend={BACKEND} ingress={'webhook' if BACKEND != 'api' else INGRESS}")
    log(startup_report())
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
